import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  toPositiveInt,
} from "../utils/common.js";
import { makeStoreOptions, useStoresList } from "../utils/stores.js";

const moneyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatMoney(value) {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numberValue)) return "--";
  return moneyFormatter.format(numberValue);
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-PH", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatIsoDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromIsoDateInput(value) {
  const raw = String(value || "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return new Date(y, m - 1, d);
}

function addDays(date, deltaDays) {
  const next = new Date(date);
  next.setDate(next.getDate() + deltaDays);
  return next;
}

function clampDateRange({ start, end }) {
  if (!(start instanceof Date) || Number.isNaN(start.getTime()))
    return { start: null, end: null };
  if (!(end instanceof Date) || Number.isNaN(end.getTime()))
    return { start, end: start };
  if (start <= end) return { start, end };
  return { start: end, end: start };
}

function listDayKeysInRange(start, end) {
  const keys = [];
  const cursor = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    keys.push(formatIsoDateInput(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
}

function normalizeBucketKeyToRange(value, rangeKeys, idx, yearMin, yearMax) {
  const raw = String(value ?? "").trim();
  if (!raw) return rangeKeys?.[idx] ?? "";

  if (/^\\d{4}-\\d{2}-\\d{2}$/.test(raw)) return raw;

  const isoMatch = /\\d{4}-\\d{2}-\\d{2}/.exec(raw);
  if (isoMatch) return isoMatch[0];

  const n = Number(raw);
  if (Number.isFinite(n) && rangeKeys?.[idx]) return rangeKeys[idx];

  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) {
    const y = dt.getFullYear();
    if (typeof yearMin === "number" && typeof yearMax === "number") {
      if (y < yearMin || y > yearMax) return rangeKeys?.[idx] ?? "";
    }
    return formatIsoDateInput(dt);
  }

  return rangeKeys?.[idx] ?? raw;
}

function getBucketKey(bucket, rangeKeys, idx, yearMin, yearMax) {
  if (bucket && typeof bucket === "object") {
    return normalizeBucketKeyToRange(
      bucket.bucket ?? bucket.date ?? bucket.label ?? bucket.key ?? "",
      rangeKeys,
      idx,
      yearMin,
      yearMax,
    );
  }
  return normalizeBucketKeyToRange(bucket, rangeKeys, idx, yearMin, yearMax);
}

function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeCategory(value) {
  if (!value) return { id: "", name: "" };
  if (typeof value === "string") return { id: "", name: value.trim() };
  if (typeof value !== "object") return { id: "", name: String(value).trim() };
  const id = value.id ?? value._id ?? value.categoryId ?? value.category_id ?? "";
  const name = value.name ?? value.categoryName ?? value.category_name ?? "";
  return { id: id == null ? "" : String(id), name: String(name || "").trim() };
}

function downloadTextFile({
  filename,
  content,
  mime = "text/plain;charset=utf-8",
}) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(escape).join(",")).join("\n");
}

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

const ITEM_CHART_WIDTH = 980;
const ITEM_CHART_PADDING_LEFT = 56;
const ITEM_CHART_PADDING_RIGHT = 20;
const ITEM_CHART_PADDING_TOP = 18;
const ITEM_CHART_PADDING_BOTTOM = 34;

const ITEM_LINE_COLORS = [
  "#60A5FA", // blue
  "#34D399", // green
  "#FBBF24", // amber
  "#F87171", // red
  "#A78BFA", // purple
  "#22D3EE", // cyan
  "#FB7185", // rose
  "#F97316", // orange
  "#4ADE80", // emerald
  "#38BDF8", // sky
];

function hashStringToInt(value) {
  const s = String(value ?? "");
  let hash = 2166136261;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function colorForItemId(itemId) {
  const idx = hashStringToInt(itemId) % ITEM_LINE_COLORS.length;
  return ITEM_LINE_COLORS[idx];
}

function ItemLineChart({ labels, series, selectedId, height = 220 }) {
  const safeSeries = useMemo(() => {
    return (Array.isArray(series) ? series : [])
      .map((s) => {
        if (!s || typeof s !== "object") return null;
        const id = String(s.id ?? "");
        const name = String(s.name ?? id);
        const values = Array.isArray(s.values) ? s.values : [];
        const safeValues = values.map((v) => (Number.isFinite(v) ? v : 0));
        const color = String(s.color || colorForItemId(id));
        return { id, name, color, values: safeValues };
      })
      .filter(Boolean);
  }, [series]);

  const yTicks = useMemo(() => {
    const all = [];
    for (const s of safeSeries) all.push(...s.values);
    const max = Math.max(0, ...(all.length ? all : [0]));
    const steps = 4;
    const ticks = [];
    for (let i = 0; i <= steps; i++) ticks.push((max * i) / steps);
    return ticks;
  }, [safeSeries]);

  const paths = useMemo(() => {
    const innerW =
      ITEM_CHART_WIDTH - ITEM_CHART_PADDING_LEFT - ITEM_CHART_PADDING_RIGHT;
    const innerH = height - ITEM_CHART_PADDING_TOP - ITEM_CHART_PADDING_BOTTOM;

    const maxTick = yTicks[yTicks.length - 1] || 1;
    const span = maxTick || 1;

    return safeSeries.map((s) => {
      const points = s.values.map((v, i) => {
        const x =
          ITEM_CHART_PADDING_LEFT +
          (labels.length <= 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
        const y = ITEM_CHART_PADDING_TOP + (1 - v / span) * innerH;
        return { x, y };
      });

      const d = points.length
        ? points
            .map(
              (p, idx) =>
                `${idx ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`,
            )
            .join(" ")
        : "";

      return { id: s.id, color: s.color, d };
    });
  }, [height, labels, safeSeries, yTicks]);

  return (
    <div className="salesByItemChartWrap">
      <svg
        viewBox={`0 0 ${ITEM_CHART_WIDTH} ${height}`}
        role="img"
        aria-label="Sales by item chart"
        className="salesByItemChart"
        preserveAspectRatio="none"
      >
        {yTicks.map((t) => {
          const innerH =
            height - ITEM_CHART_PADDING_TOP - ITEM_CHART_PADDING_BOTTOM;
          const y =
            ITEM_CHART_PADDING_TOP +
            (1 - t / (yTicks[yTicks.length - 1] || 1)) * innerH;
          return (
            <g key={t}>
              <line
                x1={ITEM_CHART_PADDING_LEFT}
                x2={ITEM_CHART_WIDTH - ITEM_CHART_PADDING_RIGHT}
                y1={y}
                y2={y}
                stroke="rgba(148, 163, 184, 0.35)"
                strokeWidth="1"
              />
              <text
                x={ITEM_CHART_PADDING_LEFT - 10}
                y={y + 4}
                textAnchor="end"
                fontSize="11"
                fill="currentColor"
                opacity="0.7"
              >
                {formatMoney(t)}
              </text>
            </g>
          );
        })}

        {paths.map((p) => {
          if (!p.d) return null;
          const isSelected = selectedId && String(selectedId) === String(p.id);
          return (
            <path
              key={p.id}
              d={p.d}
              fill="none"
              stroke={p.color}
              opacity={isSelected ? 1 : 0.55}
              strokeWidth={isSelected ? 3.2 : 2.2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          );
        })}

        <line
          x1={ITEM_CHART_PADDING_LEFT}
          x2={ITEM_CHART_WIDTH - ITEM_CHART_PADDING_RIGHT}
          y1={height - ITEM_CHART_PADDING_BOTTOM}
          y2={height - ITEM_CHART_PADDING_BOTTOM}
          stroke="rgba(148, 163, 184, 0.45)"
          strokeWidth="1"
        />

        {labels.map((label, idx) => {
          if (
            labels.length > 14 &&
            idx % Math.ceil(labels.length / 14) !== 0 &&
            idx !== labels.length - 1
          )
            return null;
          const innerW =
            ITEM_CHART_WIDTH -
            ITEM_CHART_PADDING_LEFT -
            ITEM_CHART_PADDING_RIGHT;
          const x =
            ITEM_CHART_PADDING_LEFT +
            (labels.length <= 1
              ? innerW / 2
              : (idx / (labels.length - 1)) * innerW);
          return (
            <text
              key={`${label}-${idx}`}
              x={x}
              y={height - 12}
              textAnchor="middle"
              fontSize="11"
              fill="currentColor"
              opacity="0.7"
            >
              {label}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function generateDemoRows({ startKey, endKey }) {
  const start = new Date(startKey);
  const end = new Date(endKey);
  const clamped = clampDateRange({ start, end });
  if (!clamped.start || !clamped.end) return [];
  const keys = listDayKeysInRange(clamped.start, clamped.end);
  const items = [
    { id: "demo:1", name: "test 1", category: "a", cost: 100 },
    { id: "demo:2", name: "test 2", category: "b", cost: 80 },
    { id: "demo:3", name: "test 3", category: "c", cost: 120 },
    { id: "demo:4", name: "test 4", category: "d", cost: 60 },
    { id: "demo:5", name: "test 5", category: "e", cost: 50 },
  ];

  const rows = items.map((it, idx) => {
    const perDay = new Map();
    keys.forEach((k, dayIdx) => {
      const wave = Math.sin((dayIdx + idx * 3) * 0.5) * 0.45 + 0.55;
      const spike = (dayIdx + idx) % 13 === 0 ? 2.0 : 1;
      const base = 900 + idx * 150;
      const amount = Math.round(wave * spike * base * 100) / 100;
      perDay.set(k, amount);
    });
    const qty = 5 + idx * 2;
    const netSales = Math.round((2000 / (idx + 1)) * 100) / 100;
    const costOfGoods = qty * it.cost;
    return {
      itemId: it.id,
      itemName: it.name,
      categoryId: `demo-cat:${it.category}`,
      categoryName: it.category,
      qtySold: qty,
      netSales,
      costOfGoods,
      grossProfit: Math.max(0, netSales - costOfGoods),
      perDay,
    };
  });

  return rows;
}

export default function SalesByItemPage({ apiBaseUrl, authToken, authUser }) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const [storeId, setStoreId] = useState(() => reportStoreId);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    return formatIsoDateInput(addDays(end, -29));
  });
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [dayPart, setDayPart] = useState("all");
  const [employeeId, setEmployeeId] = useState("all");

  const [selectedItemId, setSelectedItemId] = useState("");
  const [chartType, setChartType] = useState("line");
  const [granularity, setGranularity] = useState("day");

  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [page, setPage] = useState(1);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isDemoData, setIsDemoData] = useState(false);

  const [employees, setEmployees] = useState([]);
  const [rows, setRows] = useState([]);

  const lastFetchId = useRef(0);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      const url = `${apiBaseUrl}${path}`;
      const response = await fetch(url, {
        method,
        headers: getAuthHeaders(),
        credentials: getFetchCredentials(),
        body: body ? JSON.stringify(body) : undefined,
      });

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }

      if (!response.ok) {
        const message =
          (payload && (payload.message || payload.error)) ||
          `Request failed (HTTP ${response.status}).`;
        throw new Error(String(message));
      }

      return payload;
    },
    [apiBaseUrl, getAuthHeaders],
  );

  const { stores, isStoresLoading } = useStoresList({ apiBaseUrl, apiRequest });

  const storeOptions = useMemo(() => {
    return makeStoreOptions({ stores, activeStoreId: storeId });
  }, [storeId, stores]);

  const visibleStoreOptions = useMemo(() => {
    if (canPickStore) return storeOptions;
    const active = String(storeId || "").trim();
    if (!active) return [];
    return storeOptions.filter((s) => String(s.id) === active);
  }, [canPickStore, storeId, storeOptions]);

  useEffect(() => {
    if (!canPickStore) {
      setStoreId(reportStoreId);
      return;
    }
    if (authRole !== "admin" && reportStoreId && !storeId) {
      setStoreId(reportStoreId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authRole, canPickStore, reportStoreId]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;
    setPage(1);
  }, [endDate, rowsPerPage, startDate]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");
    setIsDemoData(false);

    (async () => {
      try {
        const rangeKeys = listDayKeysInRange(clamped.start, clamped.end);
        const yearMin = clamped.start.getFullYear() - 1;
        const yearMax = clamped.end.getFullYear() + 1;

        const baseParams = {
          from: formatIsoDateInput(clamped.start),
          to: formatIsoDateInput(clamped.end),
          storeId: storeId || undefined,
          bucket: "day",
          top: 5,
          page: 1,
          limit: 1000,
        };

        const [payload, employeePayload] = await Promise.all([
          apiRequest(
            `/sales/reports/by-item${buildQueryString({
              ...baseParams,
              ...(employeeId !== "all" ? { employeeId } : null),
            })}`,
          ),
          apiRequest(
            `/sales/reports/by-employee${buildQueryString({
              from: baseParams.from,
              to: baseParams.to,
              storeId: baseParams.storeId,
              page: 1,
              limit: 1000,
            })}`,
          ).catch(() => null),
        ]);

        console.log("Sales by item report payload:", payload);

        const parsed = parsePagedResponse(payload, { page: 1, limit: 1000 });
        const data = extractList(parsed.data);

        const buckets =
          (Array.isArray(payload?.buckets) && payload.buckets) ||
          (Array.isArray(payload?.data?.buckets) && payload.data.buckets) ||
          null;
        const series =
          (Array.isArray(payload?.series) && payload.series) ||
          (Array.isArray(payload?.data?.series) && payload.data.series) ||
          null;

        const seriesByItemId = new Map();
        if (Array.isArray(series)) {
          for (const s of series) {
            if (!s || typeof s !== "object") continue;
            const id = s.itemId ?? s.item_id ?? s.id ?? null;
            if (!id) continue;
            seriesByItemId.set(String(id), s);
          }
        }

        const outRows = data
          .map((r) => {
            if (!r || typeof r !== "object") return null;
            const itemId = r.itemId ?? r.item_id ?? r.id ?? null;
            if (!itemId) return null;
            const id = String(itemId);
            const itemName =
              String(r.name ?? r.itemName ?? r.item_name ?? "").trim() || id;
            const categoryObj = normalizeCategory(
              r.category ?? r.categoryName ?? r.category_name,
            );
            const qtySold = toPositiveInt(
              r.itemsSold ?? r.items_sold ?? r.qtySold,
              0,
            );
            const netSales = normalizeNumber(r.netSales ?? r.net_sales) ?? 0;
            const costOfGoods =
              normalizeNumber(r.costOfGoods ?? r.cost_of_goods ?? r.cogs) ?? 0;
            const grossProfit =
              normalizeNumber(r.grossProfit ?? r.gross_profit) ??
              netSales - costOfGoods;

            const perDay = new Map();
            if (Array.isArray(r.buckets)) {
              r.buckets.forEach((b, idx) => {
                if (!b || typeof b !== "object") return;
                const key = getBucketKey(
                  b.bucket ?? b.date ?? b.label ?? b,
                  rangeKeys,
                  idx,
                  yearMin,
                  yearMax,
                );
                if (!key) return;
                const value =
                  normalizeNumber(
                    b.netSales ?? b.net_sales ?? b.value ?? b.amount,
                    b.y,
                  ) ?? 0;
                perDay.set(key, value);
              });
            } else if (seriesByItemId.has(id)) {
              const s = seriesByItemId.get(id);
              const values =
                (Array.isArray(s?.values) && s.values) ||
                (Array.isArray(s?.data) && s.data) ||
                (Array.isArray(s?.points) && s.points) ||
                null;
              if (Array.isArray(values)) {
                const looksLikePoints = values.some(
                  (v) => v && typeof v === "object" && ("x" in v || "bucket" in v || "date" in v),
                );

                if (looksLikePoints) {
                  values.forEach((pt, idx) => {
                    if (!pt || typeof pt !== "object") return;
                    const key = getBucketKey(
                      pt.x ?? pt.bucket ?? pt.date ?? pt.label ?? pt.key ?? idx,
                      rangeKeys,
                      idx,
                      yearMin,
                      yearMax,
                    );
                    if (!key) return;
                    const amount =
                      normalizeNumber(
                        pt.netSales ?? pt.net_sales ?? pt.value ?? pt.amount ?? pt.y,
                      ) ?? 0;
                    perDay.set(key, amount);
                  });
                } else if (Array.isArray(buckets)) {
                  buckets.forEach((bk, idx) => {
                    const key = getBucketKey(bk, rangeKeys, idx, yearMin, yearMax);
                    if (!key) return;
                    const v = values[idx];
                    if (v && typeof v === "object") {
                      const amount =
                        normalizeNumber(
                          v.netSales ?? v.net_sales ?? v.value ?? v.amount ?? v.y,
                        ) ?? 0;
                      perDay.set(key, amount);
                    } else {
                      perDay.set(key, normalizeNumber(v) ?? 0);
                    }
                  });
                }
              }
            }

            return {
              itemId: id,
              itemName,
              categoryId: categoryObj.id,
              categoryName: categoryObj.name,
              qtySold,
              netSales: Math.round(netSales * 100) / 100,
              costOfGoods: Math.round(costOfGoods * 100) / 100,
              grossProfit: Math.round(grossProfit * 100) / 100,
              perDay,
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.netSales - a.netSales);

        const employeesFromReport = (() => {
          if (!employeePayload) return [];
          const src = parsePagedResponse(employeePayload, {
            page: 1,
            limit: 1000,
          }).data;
          return extractList(src)
            .map((r) => {
              if (!r || typeof r !== "object") return null;
              const id =
                r.employeeId ??
                r.employee_id ??
                r.id ??
                r.userId ??
                r.cashierId ??
                null;
              if (!id) return null;
              const label =
                String(
                  r.name ?? r.employeeName ?? r.employee_name ?? r.label ?? "",
                ).trim() || String(id);
              return { id: String(id), label };
            })
            .filter(Boolean)
            .sort((a, b) =>
              a.label.localeCompare(b.label, undefined, {
                sensitivity: "base",
              }),
            );
        })();

        if (fetchId !== lastFetchId.current) return;

        setRows(outRows);
        setEmployees(employeesFromReport);

        setSelectedItemId((prev) => {
          if (prev && outRows.some((r) => r.itemId === prev)) return prev;
          return outRows.length ? outRows[0].itemId : "";
        });
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message =
          e instanceof Error ? e.message : "Failed to load sales by item.";
        setError(`${message} (Showing demo data)`);
        setIsDemoData(true);
        const demo = generateDemoRows({ startKey: startDate, endKey: endDate });
        setRows(demo);
        setEmployees([{ id: "demo", label: "Demo employee" }]);
        setSelectedItemId((prev) => {
          if (prev && demo.some((r) => r.itemId === prev)) return prev;
          return demo.length ? demo[0].itemId : "";
        });
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, employeeId, endDate, startDate, storeId]);

  const topItems = useMemo(() => rows.slice(0, 5), [rows]);

  const selected = useMemo(() => {
    const found = rows.find((r) => r.itemId === selectedItemId);
    return found || (rows.length ? rows[0] : null);
  }, [rows, selectedItemId]);

  const dayKeys = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return [];
    return listDayKeysInRange(clamped.start, clamped.end);
  }, [endDate, startDate]);

  const chart = useMemo(() => {
    const labels = dayKeys.map((k) => {
      const date = new Date(k);
      return new Intl.DateTimeFormat("en-PH", {
        day: "2-digit",
        month: "short",
      }).format(date);
    });
    return { labels };
  }, [dayKeys]);

  const chartSeries = useMemo(() => {
    return topItems.map((it) => ({
      id: it.itemId,
      name: it.itemName,
      color: colorForItemId(it.itemId),
      values: dayKeys.map((k) => {
        const v = it?.perDay?.get?.(k);
        return Number.isFinite(v) ? v : 0;
      }),
    }));
  }, [dayKeys, topItems]);

  const totalPages = useMemo(() => {
    if (!rows.length) return 1;
    return Math.max(1, Math.ceil(rows.length / rowsPerPage));
  }, [rows.length, rowsPerPage]);

  const pagedRows = useMemo(() => {
    const startIdx = (page - 1) * rowsPerPage;
    return rows.slice(startIdx, startIdx + rowsPerPage);
  }, [page, rows, rowsPerPage]);

  const exportCsv = useCallback(() => {
    const header = [
      "Item",
      "Category",
      "Items sold",
      "Net sales",
      "Cost of goods",
      "Gross profit",
    ];
    const csvRows = rows.map((r) => [
      r.itemName,
      r.categoryName || "",
      String(r.qtySold || 0),
      (r.netSales || 0).toFixed(2),
      (r.costOfGoods || 0).toFixed(2),
      (r.grossProfit || 0).toFixed(2),
    ]);
    const csv = `${toCsv([header, ...csvRows])}\n`;
    const filename = `sales-by-item_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({
      filename,
      content: `\uFEFF${csv}`,
      mime: "text/csv;charset=utf-8",
    });
  }, [endDate, rows, startDate]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatShortDate(clamped.start)} - ${formatShortDate(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page salesByItemPage">
      <div className="salesSummaryHeaderBar" aria-label="Sales by item">
        <div className="salesSummaryHeaderTitle">Sales by item</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date range">
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Previous period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = listDayKeysInRange(
                  clamped.start,
                  clamped.end,
                ).length;
                setStartDate(formatIsoDateInput(addDays(clamped.start, -days)));
                setEndDate(formatIsoDateInput(addDays(clamped.end, -days)));
              }}
              disabled={isLoading}
            >
              {"<"}
            </button>
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={startDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setStartDate(todayKey);
                    return;
                  }
                  setStartDate(next);
                }}
                aria-label="Start date"
                max={todayKey}
                disabled={isLoading}
              />
              <span className="salesSummaryRangeDash" aria-hidden="true">
                --
              </span>
              <input
                className="salesSummaryDateInput"
                type="date"
                value={endDate}
                onChange={(e) => {
                  const next = e.target.value;
                  if (next && todayKey && next > todayKey) {
                    setEndDate(todayKey);
                    return;
                  }
                  setEndDate(next);
                }}
                aria-label="End date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Next period"
              onClick={() => {
                const start = new Date(startDate);
                const end = new Date(endDate);
                const clamped = clampDateRange({ start, end });
                if (!clamped.start || !clamped.end) return;
                const days = listDayKeysInRange(
                  clamped.start,
                  clamped.end,
                ).length;
                const candidateEnd = addDays(clamped.end, days);
                const candidateEndKey = formatIsoDateInput(candidateEnd);
                if (todayKey && candidateEndKey > todayKey) {
                  const todayDate = dateFromIsoDateInput(todayKey);
                  if (!todayDate) return;
                  setEndDate(todayKey);
                  setStartDate(formatIsoDateInput(addDays(todayDate, -(days - 1))));
                  return;
                }
                setStartDate(formatIsoDateInput(addDays(clamped.start, days)));
                setEndDate(candidateEndKey);
              }}
              disabled={isLoading || (todayKey && endDate && endDate >= todayKey)}
            >
              {">"}
            </button>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={dayPart}
              onChange={(e) => setDayPart(e.target.value)}
              aria-label="Time filter"
              disabled={isLoading}
            >
              <option value="all">All day</option>
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              aria-label="Employee filter"
              disabled={isLoading}
            >
              <option value="all">All employees</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={storeId}
              onChange={(e) => {
                setStoreId(e.target.value);
                if (error) setError("");
              }}
              aria-label="Store filter"
              disabled={isLoading || isStoresLoading || !canPickStore}
            >
              {canPickStore ? <option value="">All stores</option> : null}
              {!canPickStore && !storeId ? (
                <option value="">No store assigned</option>
              ) : null}
              {visibleStoreOptions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name || s.id}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFiltersRight">
            <div className="salesByItemRangeMeta" title={rangeLabel}>
              {rangeLabel}
            </div>
          </div>
        </div>
      </div>

      {error ? (
        <div className="authError salesSummaryError">{error}</div>
      ) : null}
      {isDemoData ? (
        <div className="salesSummaryHint">
          Demo data is generated locally to preview the layout.
        </div>
      ) : null}

      <div className="card salesByItemTopCard">
        <div className="salesByItemTopGrid">
          <div className="salesByItemTopList">
            <div className="salesByItemTopHeader">
              <div className="salesByItemTopTitle">Top 5 items</div>
              <div className="salesByItemTopMeta">Net sales</div>
            </div>
            <div className="salesByItemTopItems">
              {topItems.length ? (
                topItems.map((it) => {
                  const active = it.itemId === (selected?.itemId || "");
                  return (
                    <button
                      key={it.itemId}
                      type="button"
                      className={`salesByItemRow ${active ? "salesByItemRowActive" : ""}`}
                      onClick={() => setSelectedItemId(it.itemId)}
                    >
                      <span
                        className="salesByItemAvatar"
                        aria-hidden="true"
                        style={{ background: colorForItemId(it.itemId) }}
                      />
                      <span className="salesByItemName">{it.itemName}</span>
                      <span className="salesByItemValue">
                        {formatMoney(it.netSales)}
                      </span>
                    </button>
                  );
                })
              ) : (
                <div className="salesByItemEmpty">
                  {isLoading ? "Loading..." : "No data."}
                </div>
              )}
            </div>
          </div>

          <div className="salesByItemTopChart">
            <div className="salesByItemTopChartHeader">
              <div className="salesByItemTopTitle">Sales by item chart</div>
              <div className="salesByItemTopChartControls">
                <label className="salesSummaryChartControl">
                  <span className="salesSummaryChartControlLabel">Line</span>
                  <select
                    className="select selectSmall"
                    value={chartType}
                    onChange={(e) => setChartType(e.target.value)}
                    disabled={isLoading}
                  >
                    <option value="line">Line</option>
                  </select>
                </label>
                <label className="salesSummaryChartControl">
                  <span className="salesSummaryChartControlLabel">Days</span>
                  <select
                    className="select selectSmall"
                    value={granularity}
                    onChange={(e) => setGranularity(e.target.value)}
                    disabled={isLoading}
                  >
                    <option value="day">Days</option>
                  </select>
                </label>
              </div>
            </div>

            <div className="salesByItemTopChartBody">
              {isLoading ? (
                <div className="salesSummaryChartLoading">Loading...</div>
              ) : chart.labels.length && chartSeries.length ? (
                <ItemLineChart
                  labels={chart.labels}
                  series={chartSeries}
                  selectedId={selected?.itemId || ""}
                />
              ) : (
                <div className="salesSummaryChartEmpty">
                  No data in this range.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="card salesSummaryTableCard">
        <div className="salesSummaryTableHeader">
          <div className="salesSummaryExportLabel">EXPORT</div>
          <div className="salesSummaryTableHeaderRight">
            <button
              className="btn btnGhost btnSmall"
              type="button"
              onClick={exportCsv}
              disabled={isLoading || !rows.length}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th className="salesByItemColItem">Item</th>
                <th className="salesByItemColCategory">Category</th>
                <th className="salesByItemColQty">Items sold</th>
                <th className="colMoney">Net sales</th>
                <th className="colMoney">Cost of goods</th>
                <th className="colMoney">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="usersEmpty">
                    {isLoading ? "Loading..." : "No results."}
                  </td>
                </tr>
              ) : (
                pagedRows.map((r) => (
                  <tr key={r.itemId}>
                    <td className="salesByItemColItem">{r.itemName}</td>
                    <td className="salesByItemColCategory">
                      {r.categoryName || "--"}
                    </td>
                    <td className="salesByItemColQty">{r.qtySold || 0}</td>
                    <td className="colMoney">{formatMoney(r.netSales)}</td>
                    <td className="colMoney">{formatMoney(r.costOfGoods)}</td>
                    <td className="colMoney">{formatMoney(r.grossProfit)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="salesSummaryPager" aria-label="Pagination">
          <div className="pagerButtons" aria-label="Page controls">
            <button
              className="pagerBtn"
              type="button"
              aria-label="Previous page"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {"<"}
            </button>
            <button
              className="pagerBtn"
              type="button"
              aria-label="Next page"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {">"}
            </button>
          </div>

          <div className="pagerMeta">
            <span>Page:</span>
            <span className="salesSummaryPagerStrong">{page}</span>
            <span>of {totalPages}</span>
          </div>

          <div className="pagerMeta">
            <span>Rows per page:</span>
            <select
              className="select selectSmall"
              value={String(rowsPerPage)}
              onChange={(e) => {
                setRowsPerPage(toPositiveInt(e.target.value, rowsPerPage));
                setPage(1);
              }}
              disabled={isLoading}
              aria-label="Rows per page"
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
            </select>
          </div>
        </div>
      </div>

      {dayPart !== "all" || chartType !== "line" || granularity !== "day" ? (
        <div className="salesSummaryHint">
          Some filters are placeholders and may require backend support.
        </div>
      ) : null}
    </div>
  );
}
