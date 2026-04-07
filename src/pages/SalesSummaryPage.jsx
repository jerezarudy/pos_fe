import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  readLocalStorage,
  safeParseList,
  toPositiveInt,
  writeLocalStorage,
} from "../utils/common.js";

const STORES_STORAGE_KEY = "pos.stores.v1";

const moneyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const MINI_CHART_WIDTH = 980;
const MINI_CHART_PADDING_LEFT = 56;
const MINI_CHART_PADDING_RIGHT = 20;
const MINI_CHART_PADDING_TOP = 18;
const MINI_CHART_PADDING_BOTTOM = 34;

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
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d))
    return null;
  return new Date(y, m - 1, d);
}

function parseTimeInput(value, fallback = { h: 0, m: 0 }) {
  const raw = String(value || "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!match) return fallback;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return fallback;
  if (h < 0 || h > 23) return fallback;
  if (m < 0 || m > 59) return fallback;
  return { h, m };
}

function withLocalTime(date, timeValue, fallbackTime) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  const next = new Date(date);
  const { h, m } = parseTimeInput(timeValue, fallbackTime);
  next.setHours(h, m, 0, 0);
  return next;
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

function daysBetweenInclusive(start, end) {
  const a = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const b = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  const ms = b.getTime() - a.getTime();
  const days = Math.round(ms / 86400000);
  return Math.max(1, days + 1);
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

function getLocalDayKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return formatIsoDateInput(date);
}

function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function loadCashiersFromStorage() {
  const raw = readLocalStorage("pos.users.v1", "");
  const list = safeParseList(raw);
  const out = [];
  for (const u of list) {
    if (!u || typeof u !== "object") continue;
    const userType = String(u.userType ?? u.role ?? u.type ?? "")
      .trim()
      .toLowerCase();
    if (userType !== "cashier") continue;
    const id = u.id ?? u._id ?? u.userId ?? u.uuid ?? "";
    if (!id) continue;
    const label =
      String(u.name ?? u.fullName ?? u.email ?? id).trim() || String(id);
    out.push({ id: String(id), label });
  }
  out.sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
  return out;
}

function toCsv(rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(escape).join(",")).join("\n");
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

function extractSalesList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function normalizeSummaryTotals(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const grossSales = normalizeNumber(source.grossSales ?? source.gross_sales) ?? 0;
  const refunds =
    normalizeNumber(source.refunds ?? source.refundAmount ?? source.refund_amount) ??
    0;
  const discounts =
    normalizeNumber(source.discounts ?? source.discountAmount ?? source.discount_amount) ??
    0;
  const netSales =
    normalizeNumber(source.netSales ?? source.net_sales) ??
    grossSales - refunds - discounts;
  const costOfGoods =
    normalizeNumber(source.costOfGoods ?? source.cost_of_goods ?? source.cogs) ?? 0;
  const grossProfit =
    normalizeNumber(source.grossProfit ?? source.gross_profit) ??
    netSales - costOfGoods;
  const salesTransactions = toPositiveInt(
    source.salesTransactions ?? source.sales_transactions,
    0,
  );
  const refundTransactions = toPositiveInt(
    source.refundTransactions ?? source.refund_transactions,
    0,
  );
  const receipts = toPositiveInt(
    source.receipts ?? source.transactions,
    salesTransactions + refundTransactions,
  );
  const averageSale =
    normalizeNumber(source.averageSale ?? source.average_sale ?? source.avgSale) ??
    (salesTransactions > 0 ? netSales / salesTransactions : 0);

  return {
    grossSales,
    refunds,
    discounts,
    netSales,
    costOfGoods,
    grossProfit,
    salesTransactions,
    refundTransactions,
    receipts,
    averageSale,
  };
}

function normalizeSummaryDayKey(value) {
  const raw = String(value ?? "").trim();
  const dateOnly = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (dateOnly) return dateOnly[1];
  return getLocalDayKey(raw);
}

function normalizeSummarySeriesPoint(raw) {
  if (!raw || typeof raw !== "object") return null;
  const dayKey = normalizeSummaryDayKey(
    raw.x ?? raw.dayKey ?? raw.day_key ?? raw.date ?? raw.bucket,
  );
  if (!dayKey) return null;
  return {
    dayKey,
    ...normalizeSummaryTotals(raw),
  };
}

function sumTotals(list) {
  return list.reduce(
    (acc, row) => {
      acc.grossSales += row.grossSales || 0;
      acc.refunds += row.refunds || 0;
      acc.discounts += row.discounts || 0;
      acc.netSales += row.netSales || 0;
      acc.costOfGoods += row.costOfGoods || 0;
      acc.grossProfit += row.grossProfit || 0;
      acc.salesTransactions += row.salesTransactions || 0;
      acc.refundTransactions += row.refundTransactions || 0;
      acc.receipts += row.receipts || 0;
      return acc;
    },
    {
      grossSales: 0,
      refunds: 0,
      discounts: 0,
      netSales: 0,
      costOfGoods: 0,
      grossProfit: 0,
      salesTransactions: 0,
      refundTransactions: 0,
      receipts: 0,
      averageSale: 0,
    },
  );
}

function normalizeSummaryRange(raw, fallback = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const series = (
    Array.isArray(source.series)
      ? source.series
      : Array.isArray(source.data)
        ? source.data
        : []
  )
    .map(normalizeSummarySeriesPoint)
    .filter(Boolean);

  const totals =
    source.totals && typeof source.totals === "object"
      ? normalizeSummaryTotals(source.totals)
      : normalizeSummaryTotals(sumTotals(series));

  return {
    from: String(source.from ?? fallback.from ?? ""),
    to: String(source.to ?? fallback.to ?? ""),
    totals,
    series,
  };
}

function normalizeSummaryReport(payload, fallback = {}) {
  const source =
    payload?.data && typeof payload.data === "object" && !Array.isArray(payload.data)
      ? payload.data
      : payload;
  const root = source && typeof source === "object" ? source : {};
  const current = normalizeSummaryRange(root.current ?? root, {
    from: root.from ?? fallback.from,
    to: root.to ?? fallback.to,
  });
  const previous = normalizeSummaryRange(root.previous, {
    from: root.previousFrom ?? root.previous_from ?? fallback.previousFrom,
    to: root.previousTo ?? root.previous_to ?? fallback.previousTo,
  });

  return {
    from: String(root.from ?? current.from ?? fallback.from ?? ""),
    to: String(root.to ?? current.to ?? fallback.to ?? ""),
    previousFrom: String(
      root.previousFrom ?? root.previous_from ?? previous.from ?? fallback.previousFrom ?? "",
    ),
    previousTo: String(
      root.previousTo ?? root.previous_to ?? previous.to ?? fallback.previousTo ?? "",
    ),
    currency: String(root.currency ?? "PHP"),
    bucket: String(root.bucket ?? fallback.bucket ?? "day"),
    current,
    previous,
  };
}

function extractEmployeeOptions(payload) {
  const map = new Map();
  for (const c of loadCashiersFromStorage()) {
    map.set(c.id, c.label);
  }

  const parsed = payload
    ? parsePagedResponse(payload, { page: 1, limit: 1000 })
    : { data: [] };
  for (const r of extractSalesList(parsed.data)) {
    if (!r || typeof r !== "object") continue;
    const id =
      r.employeeId ??
      r.employee_id ??
      r.id ??
      r.userId ??
      r.user_id ??
      r.cashierId ??
      r.cashier_id ??
      null;
    if (!id) continue;
    const label =
      String(
        r.name ??
          r.employeeName ??
          r.employee_name ??
          r.label ??
          r.cashierName ??
          r.cashier_name ??
          "",
      ).trim() || String(id);
    map.set(String(id), label);
  }

  return [...map.entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) =>
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
    );
}

function pctChange(current, previous) {
  const a = normalizeNumber(current);
  const b = normalizeNumber(previous);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (b === 0) return a === 0 ? 0 : 100;
  return ((a - b) / Math.abs(b)) * 100;
}

function _generateDemoSales({ startKey, endKey }) {
  const start = new Date(startKey);
  const end = new Date(endKey);
  const clamped = clampDateRange({ start, end });
  if (!clamped.start || !clamped.end) return [];
  const dayKeys = listDayKeysInRange(clamped.start, clamped.end);
  return dayKeys.map((key, idx) => {
    const wave = Math.sin(idx * 0.55) * 0.45 + 0.55;
    const spike = idx % 14 === 0 ? 1.8 : 1;
    const grossSales = Math.round(wave * spike * 1500 * 100) / 100;
    const discounts = Math.round(grossSales * 0.06 * 100) / 100;
    const netSales = Math.max(0, grossSales - discounts);
    const costOfGoods = Math.round(netSales * 0.55 * 100) / 100;
    const grossProfit = Math.max(0, netSales - costOfGoods);
    return {
      id: `demo:${key}`,
      createdAt: key,
      dayKey: key,
      cashierId: "demo",
      cashierName: "Demo employee",
      grossSales,
      refunds: 0,
      discounts,
      netSales,
      costOfGoods,
      grossProfit,
    };
  });
}

function extractStoresList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.stores)) return payload.stores;
  if (Array.isArray(payload?.data?.stores)) return payload.data.stores;
  return [];
}

function toUiStore(apiStore) {
  if (!apiStore || typeof apiStore !== "object") return null;
  const id =
    apiStore.id ??
    apiStore._id ??
    apiStore.storeId ??
    apiStore.uuid ??
    (apiStore.name ? `name:${apiStore.name}` : null);
  if (!id) return null;
  return { id: String(id), name: String(apiStore.name ?? "") };
}

function MiniLineChart({ labels, values, height = 240 }) {
  const points = useMemo(() => {
    const safeValues = values.map((v) => (Number.isFinite(v) ? v : 0));
    const max = Math.max(0, ...safeValues);
    const min = Math.min(0, ...safeValues);
    const span = max - min || 1;
    const innerW =
      MINI_CHART_WIDTH - MINI_CHART_PADDING_LEFT - MINI_CHART_PADDING_RIGHT;
    const innerH = height - MINI_CHART_PADDING_TOP - MINI_CHART_PADDING_BOTTOM;

    return safeValues.map((v, i) => {
      const x =
        MINI_CHART_PADDING_LEFT +
        (labels.length <= 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW);
      const y = MINI_CHART_PADDING_TOP + (1 - (v - min) / span) * innerH;
      return { x, y, v };
    });
  }, [height, labels.length, values]);

  const path = useMemo(() => {
    if (!points.length) return "";
    return points
      .map((p, idx) => `${idx ? "L" : "M"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
      .join(" ");
  }, [points]);

  const yTicks = useMemo(() => {
    const safeValues = values.map((v) => (Number.isFinite(v) ? v : 0));
    const max = Math.max(0, ...safeValues);
    const steps = 4;
    const ticks = [];
    for (let i = 0; i <= steps; i++) ticks.push((max * i) / steps);
    return ticks;
  }, [values]);

  return (
    <div className="salesSummaryChartWrap">
      <svg
        viewBox={`0 0 ${MINI_CHART_WIDTH} ${height}`}
        role="img"
        aria-label="Sales chart"
        className="salesSummaryChart"
        preserveAspectRatio="none"
      >
        <rect
          x="0"
          y="0"
          width={MINI_CHART_WIDTH}
          height={height}
          fill="transparent"
        />

        {yTicks.map((t) => {
          const innerH =
            height - MINI_CHART_PADDING_TOP - MINI_CHART_PADDING_BOTTOM;
          const y =
            MINI_CHART_PADDING_TOP +
            (1 - t / (yTicks[yTicks.length - 1] || 1)) * innerH;
          return (
            <g key={t}>
              <line
                x1={MINI_CHART_PADDING_LEFT}
                x2={MINI_CHART_WIDTH - MINI_CHART_PADDING_RIGHT}
                y1={y}
                y2={y}
                stroke="rgba(148, 163, 184, 0.35)"
                strokeWidth="1"
              />
              <text
                x={MINI_CHART_PADDING_LEFT - 10}
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

        {path ? (
          <>
            <path
              d={path}
              fill="none"
              stroke="#2e7d32"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map((p) => (
              <circle
                key={`${p.x}:${p.y}`}
                cx={p.x}
                cy={p.y}
                r="3.2"
                fill="#2e7d32"
                stroke="#ffffff"
                strokeWidth="1.4"
              />
            ))}
          </>
        ) : null}

        <line
          x1={MINI_CHART_PADDING_LEFT}
          x2={MINI_CHART_WIDTH - MINI_CHART_PADDING_RIGHT}
          y1={height - MINI_CHART_PADDING_BOTTOM}
          y2={height - MINI_CHART_PADDING_BOTTOM}
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
            MINI_CHART_WIDTH -
            MINI_CHART_PADDING_LEFT -
            MINI_CHART_PADDING_RIGHT;
          const x =
            MINI_CHART_PADDING_LEFT +
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

export default function SalesSummaryPage({ apiBaseUrl, authToken, authUser }) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const assignedStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const [storeId, setStoreId] = useState(() => assignedStoreId);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);

  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    return formatIsoDateInput(addDays(end, -29));
  });
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));

  const [dayPart, setDayPart] = useState("all");
  const [startTime, setStartTime] = useState("00:00");
  const [endTime, setEndTime] = useState("23:59");
  const [employeeId, setEmployeeId] = useState("all");
  const [area, setArea] = useState("grossSales");
  const [granularity, setGranularity] = useState("day");

  const [rowsPerPage, setRowsPerPage] = useState(10);
  const [page, setPage] = useState(1);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isDemoData, setIsDemoData] = useState(false);
  const [summaryReport, setSummaryReport] = useState(null);
  const [employees, setEmployees] = useState([]);

  const [stores, setStores] = useState(() => {
    return safeParseList(readLocalStorage(STORES_STORAGE_KEY, ""))
      .map(toUiStore)
      .filter(Boolean);
  });
  const [isStoresLoading, setIsStoresLoading] = useState(false);

  const lastFetchId = useRef(0);

  useEffect(() => {
    if (dayPart !== "all") return;
    if (startTime !== "00:00") setStartTime("00:00");
    if (endTime !== "23:59") setEndTime("23:59");
  }, [dayPart, endTime, startTime]);

  const timeBounds = useMemo(() => {
    if (dayPart === "all") return null;

    const start = dateFromIsoDateInput(startDate);
    const end = dateFromIsoDateInput(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return null;

    const from = withLocalTime(clamped.start, startTime, { h: 0, m: 0 });
    const to = withLocalTime(clamped.end, endTime, { h: 23, m: 59 });
    if (!from || !to) return null;

    if (from <= to) return { from, to };
    return { from: to, to: from };
  }, [dayPart, endDate, endTime, startDate, startTime]);

  const summaryRangeParams = useMemo(() => {
    if (dayPart !== "all" && timeBounds) {
      return {
        from: timeBounds.from.toISOString(),
        to: timeBounds.to.toISOString(),
      };
    }
    return { startDate, endDate };
  }, [dayPart, endDate, startDate, timeBounds]);

  const storeOptions = useMemo(() => {
    const map = new Map();
    for (const s of stores) {
      if (!s?.id) continue;
      map.set(String(s.id), { id: String(s.id), name: String(s.name ?? "") });
    }

    const active = String(storeId || "").trim();
    if (active && !map.has(active)) {
      map.set(active, { id: active, name: active });
    }

    return Array.from(map.values()).sort((a, b) =>
      String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
        sensitivity: "base",
      }),
    );
  }, [storeId, stores]);

  const visibleStoreOptions = useMemo(() => {
    if (canPickStore) return storeOptions;
    const active = String(storeId || "").trim();
    if (!active) return [];
    return storeOptions.filter((s) => String(s.id) === active);
  }, [canPickStore, storeId, storeOptions]);

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

  useEffect(() => {
    writeLocalStorage(STORES_STORAGE_KEY, JSON.stringify(stores));
  }, [stores]);

  useEffect(() => {
    if (!canPickStore) {
      setStoreId(assignedStoreId);
      return;
    }
    if (authRole !== "admin" && assignedStoreId && !storeId) {
      setStoreId(assignedStoreId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignedStoreId, authRole, canPickStore]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;

    async function loadStores() {
      setIsStoresLoading(true);
      try {
        const qs = buildQueryString({ page: 1, limit: 200 });
        const payload = await apiRequest(`/stores${qs}`);
        const paged = parsePagedResponse(payload, { page: 1, limit: 200 });
        const apiStores = extractStoresList({ ...payload, data: paged.data });
        const ui = apiStores.map(toUiStore).filter(Boolean);
        if (!cancelled && ui.length) setStores(ui);
      } catch {
        // optional: report can still load without stores list
      } finally {
        if (!cancelled) setIsStoresLoading(false);
      }
    }

    loadStores();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiRequest]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;
    setPage(1);
  }, [startDate, endDate, rowsPerPage]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const rangeDays = daysBetweenInclusive(clamped.start, clamped.end);
    const prevEnd = addDays(clamped.start, -1);
    const prevStart = addDays(prevEnd, -(rangeDays - 1));

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");
    setIsDemoData(false);

    (async () => {
      try {
        const summaryQuery = buildQueryString({
          ...summaryRangeParams,
          bucket: granularity,
          storeId: storeId || undefined,
          ...(employeeId !== "all" ? { employeeId } : null),
        });

        const employeesQuery = buildQueryString({
          ...summaryRangeParams,
          storeId: storeId || undefined,
          page: 1,
          limit: 1000,
        });

        const [summaryPayload, employeePayload] = await Promise.all([
          apiRequest(`/sales/reports/summary${summaryQuery}`),
          apiRequest(`/sales/reports/by-employee${employeesQuery}`).catch(
            () => null,
          ),
        ]);

        if (fetchId !== lastFetchId.current) return;
        setSummaryReport(
          normalizeSummaryReport(summaryPayload, {
            from: formatIsoDateInput(clamped.start),
            to: formatIsoDateInput(clamped.end),
            previousFrom: formatIsoDateInput(prevStart),
            previousTo: formatIsoDateInput(prevEnd),
            bucket: granularity,
          }),
        );
        setIsDemoData(false);
        setEmployees(extractEmployeeOptions(employeePayload));
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message =
          e instanceof Error ? e.message : "Failed to load sales summary.";
        setError(message);
        setSummaryReport(null);
        setIsDemoData(false);
        setEmployees(extractEmployeeOptions(null));
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [
    apiRequest,
    employeeId,
    endDate,
    granularity,
    startDate,
    storeId,
    summaryRangeParams,
  ]);

  const currentRange = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return null;
    const rangeDays = daysBetweenInclusive(clamped.start, clamped.end);
    const prevEnd = addDays(clamped.start, -1);
    const prevStart = addDays(prevEnd, -(rangeDays - 1));
    return { start: clamped.start, end: clamped.end, prevStart, prevEnd };
  }, [startDate, endDate]);

  const { tableRows, kpis, chart } = useMemo(() => {
    if (!currentRange) {
      return { tableRows: [], kpis: [], chart: { labels: [], values: [] } };
    }

    const currentKeys = new Set(
      listDayKeysInRange(currentRange.start, currentRange.end),
    );

    const aggregated = new Map(
      (summaryReport?.current?.series ?? []).map((row) => [row.dayKey, row]),
    );
    const dayKeys = [...currentKeys].sort((a, b) => a.localeCompare(b));
    const dayRows = dayKeys.map(
      (k) =>
        aggregated.get(k) || {
          dayKey: k,
          grossSales: 0,
          refunds: 0,
          discounts: 0,
          netSales: 0,
          costOfGoods: 0,
          grossProfit: 0,
        },
    );

    const currentTotals = summaryReport?.current?.totals ?? sumTotals(dayRows);
    const prevTotals =
      summaryReport?.previous?.totals ??
      normalizeSummaryTotals(sumTotals(summaryReport?.previous?.series ?? []));

    const mkKpi = (label, key) => {
      const current = currentTotals[key] || 0;
      const previous = prevTotals[key] || 0;
      const delta = current - previous;
      const pct = pctChange(current, previous);
      return { label, key, current, previous, delta, pct };
    };

    const kpiList = [
      mkKpi("Gross sales", "grossSales"),
      mkKpi("Refunds", "refunds"),
      mkKpi("Discounts", "discounts"),
      mkKpi("Net sales", "netSales"),
      mkKpi("Gross profit", "grossProfit"),
    ];

    const chartLabels = dayKeys.map((k) => {
      const date = new Date(k);
      return new Intl.DateTimeFormat("en-PH", {
        day: "2-digit",
        month: "short",
      }).format(date);
    });
    const chartValues = dayRows.map((r) => r[area] || 0);

    const sortedForTable = [...dayRows].sort((a, b) =>
      b.dayKey.localeCompare(a.dayKey),
    );

    return {
      tableRows: sortedForTable,
      kpis: kpiList,
      chart: { labels: chartLabels, values: chartValues },
    };
  }, [area, currentRange, summaryReport]);

  const totalPages = useMemo(() => {
    if (!tableRows.length) return 1;
    return Math.max(1, Math.ceil(tableRows.length / rowsPerPage));
  }, [rowsPerPage, tableRows.length]);

  const pagedRows = useMemo(() => {
    const startIdx = (page - 1) * rowsPerPage;
    return tableRows.slice(startIdx, startIdx + rowsPerPage);
  }, [page, rowsPerPage, tableRows]);

  const rangeLabels = useMemo(() => {
    if (!currentRange) return { current: "--", previous: "--" };
    return {
      current: `${formatShortDate(currentRange.start)} - ${formatShortDate(currentRange.end)}`,
      previous: `${formatShortDate(currentRange.prevStart)} - ${formatShortDate(currentRange.prevEnd)}`,
    };
  }, [currentRange]);

  const exportCsv = useCallback(() => {
    const header = [
      "Date",
      "Gross sales",
      "Refunds",
      "Discounts",
      "Net sales",
      "Cost of goods",
      "Gross profit",
    ];
    const rows = tableRows.map((r) => [
      r.dayKey,
      (r.grossSales || 0).toFixed(2),
      (r.refunds || 0).toFixed(2),
      (r.discounts || 0).toFixed(2),
      (r.netSales || 0).toFixed(2),
      (r.costOfGoods || 0).toFixed(2),
      (r.grossProfit || 0).toFixed(2),
    ]);
    const csv = `${toCsv([header, ...rows])}\n`;
    const filename = `sales-summary_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({
      filename,
      content: `\uFEFF${csv}`,
      mime: "text/csv;charset=utf-8",
    });
  }, [endDate, startDate, tableRows]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  return (
    <div className="page salesSummaryPage">
      <div className="salesSummaryHeaderBar" aria-label="Sales summary">
        <div className="salesSummaryHeaderTitle">Sales summary</div>
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
                const days = daysBetweenInclusive(clamped.start, clamped.end);
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
                const days = daysBetweenInclusive(clamped.start, clamped.end);
                const candidateEnd = addDays(clamped.end, days);
                const candidateEndKey = formatIsoDateInput(candidateEnd);
                if (todayKey && candidateEndKey > todayKey) {
                  const todayDate = dateFromIsoDateInput(todayKey);
                  if (!todayDate) return;
                  setEndDate(todayKey);
                  setStartDate(
                    formatIsoDateInput(addDays(todayDate, -(days - 1))),
                  );
                  return;
                }
                setStartDate(formatIsoDateInput(addDays(clamped.start, days)));
                setEndDate(candidateEndKey);
              }}
              disabled={
                isLoading || (todayKey && endDate && endDate >= todayKey)
              }
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
              <option value="custom">Custom time</option>
            </select>
          </div>

          <div className="salesSummaryFilterGroup" aria-label="Time range">
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="time"
                value={startTime}
                onChange={(e) => setStartTime(e.target.value)}
                aria-label="Start time"
                disabled={isLoading || dayPart === "all"}
              />
              <span className="salesSummaryRangeDash" aria-hidden="true">
                --
              </span>
              <input
                className="salesSummaryDateInput"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                aria-label="End time"
                disabled={isLoading || dayPart === "all"}
              />
            </div>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={employeeId}
              onChange={(e) => {
                setEmployeeId(e.target.value);
              }}
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
            <div
              className="salesSummaryRangeLabels"
              aria-label="Current and previous range"
            >
              <div
                className="salesSummaryRangeLabel"
                title={rangeLabels.current}
              >
                <span className="salesSummaryRangeLabelTitle">Current</span>
                <span className="salesSummaryRangeLabelValue">
                  {rangeLabels.current}
                </span>
              </div>
              <div
                className="salesSummaryRangeLabel"
                title={rangeLabels.previous}
              >
                <span className="salesSummaryRangeLabelTitle">Previous</span>
                <span className="salesSummaryRangeLabelValue">
                  {rangeLabels.previous}
                </span>
              </div>
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

      <div className="salesSummaryKpiGrid" aria-label="Key metrics">
        {(kpis || []).map((kpi) => {
          const showPct = kpi.pct != null && Number.isFinite(kpi.pct);
          const isPositive = (kpi.delta || 0) >= 0;
          const deltaLabel =
            kpi.previous === 0 && kpi.current > 0
              ? `+${formatMoney(kpi.current)} (+100%)`
              : kpi.previous === 0 && kpi.current === 0
                ? `${formatMoney(0)} (0%)`
                : showPct
                  ? `${kpi.delta >= 0 ? "+" : ""}${formatMoney(kpi.delta)} (${kpi.pct >= 0 ? "+" : ""}${kpi.pct.toFixed(0)}%)`
                  : "--";
          return (
            <div key={kpi.key} className="card salesSummaryKpiCard">
              <div className="salesSummaryKpiLabel">{kpi.label}</div>
              <div className="salesSummaryKpiValue">
                {formatMoney(kpi.current)}
              </div>
              <div
                className={`salesSummaryKpiDelta ${isPositive ? "salesSummaryKpiDeltaUp" : "salesSummaryKpiDeltaDown"}`}
              >
                {deltaLabel}
              </div>
            </div>
          );
        })}
      </div>

      <div className="card salesSummaryChartCard">
        <div className="salesSummaryChartHeader">
          <div className="salesSummaryChartTitle">Gross sales</div>
          <div className="salesSummaryChartControls">
            <label className="salesSummaryChartControl">
              <span className="salesSummaryChartControlLabel">Area</span>
              <select
                className="select selectSmall"
                value={area}
                onChange={(e) => setArea(e.target.value)}
                disabled={isLoading}
              >
                <option value="grossSales">Gross sales</option>
                <option value="netSales">Net sales</option>
                <option value="grossProfit">Gross profit</option>
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
        <div className="salesSummaryChartBody">
          {isLoading ? (
            <div className="salesSummaryChartLoading">Loading...</div>
          ) : chart.labels.length ? (
            <MiniLineChart labels={chart.labels} values={chart.values} />
          ) : (
            <div className="salesSummaryChartEmpty">No data in this range.</div>
          )}
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
              disabled={isLoading || !tableRows.length}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="table salesSummaryTable">
            <thead>
              <tr>
                <th className="salesSummaryColDate">Date</th>
                <th className="colMoney">Gross sales</th>
                <th className="colMoney">Refunds</th>
                <th className="colMoney">Discounts</th>
                <th className="colMoney">Net sales</th>
                <th className="colMoney">Cost of goods</th>
                <th className="colMoney">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="usersEmpty">
                    {isLoading ? "Loading..." : "No results."}
                  </td>
                </tr>
              ) : (
                pagedRows.map((r) => (
                  <tr key={r.dayKey}>
                    <td className="salesSummaryColDate">
                      {formatShortDate(r.dayKey)}
                    </td>
                    <td className="colMoney">{formatMoney(r.grossSales)}</td>
                    <td className="colMoney">{formatMoney(r.refunds)}</td>
                    <td className="colMoney">{formatMoney(r.discounts)}</td>
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

      {granularity !== "day" ? (
        <div className="salesSummaryHint">
          Some filters are placeholders and may require backend support.
        </div>
      ) : null}
    </div>
  );
}
