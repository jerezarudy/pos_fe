import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  toPositiveInt,
} from "../utils/common.js";

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
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (cursor <= last) {
    keys.push(formatIsoDateInput(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return keys;
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

function toCsv(rows) {
  const escape = (v) => {
    const s = v == null ? "" : String(v);
    if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(escape).join(",")).join("\n");
}

function downloadTextFile({ filename, content, mime = "text/plain;charset=utf-8" }) {
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

function extractList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function generateDemoRows() {
  const rows = [
    { categoryId: "demo-cat:a", categoryName: "a", qtySold: 15, netSales: 2250, costOfGoods: 1500 },
    { categoryId: "demo-cat:b", categoryName: "b", qtySold: 10, netSales: 1200, costOfGoods: 700 },
  ];
  return rows
    .map((r) => ({
      ...r,
      grossProfit: Math.max(0, (r.netSales || 0) - (r.costOfGoods || 0)),
    }))
    .sort((a, b) => (b.netSales || 0) - (a.netSales || 0));
}

export default function SalesByCategoryPage({ apiBaseUrl, authToken, authUser }) {
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    return formatIsoDateInput(addDays(end, -29));
  });
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));

  const [dayPart, setDayPart] = useState("all");
  const [employeeId, setEmployeeId] = useState("all");

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
        const baseParams = {
          from: formatIsoDateInput(clamped.start),
          to: formatIsoDateInput(clamped.end),
          storeId: reportStoreId || undefined,
          page: 1,
          limit: 1000,
        };

        const [payload, employeePayload] = await Promise.all([
          apiRequest(
            `/sales/reports/by-category${buildQueryString({
              ...baseParams,
              ...(employeeId !== "all" ? { employeeId } : null),
            })}`,
          ),
          apiRequest(
            `/sales/reports/by-employee${buildQueryString({
              ...baseParams,
            })}`,
          ).catch(() => null),
        ]);

        const parsed = parsePagedResponse(payload, { page: 1, limit: 1000 });
        const data = extractList(parsed.data);

        const outRows = data
          .map((r) => {
            if (!r || typeof r !== "object") return null;
            const categoryObj = normalizeCategory(
              r.category ?? r.categoryName ?? r.category_name ?? r.name,
            );
            const qtySold = toPositiveInt(r.itemsSold ?? r.items_sold ?? r.qtySold, 0);
            const netSales = normalizeNumber(r.netSales ?? r.net_sales) ?? 0;
            const costOfGoods =
              normalizeNumber(r.costOfGoods ?? r.cost_of_goods ?? r.cogs) ?? 0;
            const grossProfit =
              normalizeNumber(r.grossProfit ?? r.gross_profit) ?? (netSales - costOfGoods);
            return {
              categoryId: categoryObj.id,
              categoryName: categoryObj.name || "--",
              qtySold,
              netSales: Math.round(netSales * 100) / 100,
              costOfGoods: Math.round(costOfGoods * 100) / 100,
              grossProfit: Math.round(grossProfit * 100) / 100,
            };
          })
          .filter(Boolean)
          .sort((a, b) => (b.netSales || 0) - (a.netSales || 0));

        const employeesFromReport = (() => {
          if (!employeePayload) return [];
          const src = parsePagedResponse(employeePayload, { page: 1, limit: 1000 }).data;
          return extractList(src)
            .map((r) => {
              if (!r || typeof r !== "object") return null;
              const id =
                r.employeeId ?? r.employee_id ?? r.id ?? r.userId ?? r.cashierId ?? null;
              if (!id) return null;
              const label =
                String(r.name ?? r.employeeName ?? r.employee_name ?? r.label ?? "").trim() ||
                String(id);
              return { id: String(id), label };
            })
            .filter(Boolean)
            .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
        })();

        if (fetchId !== lastFetchId.current) return;
        setRows(outRows);
        setEmployees(employeesFromReport);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message =
          e instanceof Error ? e.message : "Failed to load sales by category.";
        setError(`${message} (Showing demo data)`);
        setIsDemoData(true);
        setRows(generateDemoRows());
        setEmployees([{ id: "demo", label: "Demo employee" }]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, employeeId, endDate, reportStoreId, startDate]);

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
      "Category",
      "Items sold",
      "Net sales",
      "Cost of goods",
      "Gross profit",
    ];
    const csvRows = rows.map((r) => [
      r.categoryName,
      String(r.qtySold || 0),
      (r.netSales || 0).toFixed(2),
      (r.costOfGoods || 0).toFixed(2),
      (r.grossProfit || 0).toFixed(2),
    ]);
    const csv = `${toCsv([header, ...csvRows])}\n`;
    const filename = `sales-by-category_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [endDate, rows, startDate]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatShortDate(clamped.start)} - ${formatShortDate(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page salesByCategoryPage">
      <div className="salesSummaryHeaderBar" aria-label="Sales by category">
        <div className="salesSummaryHeaderTitle">Sales by category</div>
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
                const days = listDayKeysInRange(clamped.start, clamped.end).length;
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
                const days = listDayKeysInRange(clamped.start, clamped.end).length;
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

          <div className="salesSummaryFiltersRight">
            <div className="salesByItemRangeMeta" title={rangeLabel}>
              {rangeLabel}
            </div>
          </div>
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}
      {isDemoData ? (
        <div className="salesSummaryHint">Demo data is generated locally to preview the layout.</div>
      ) : null}

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
                <th className="salesByCategoryColCategory">Category</th>
                <th className="salesByItemColQty">Items sold</th>
                <th className="colMoney">Net sales</th>
                <th className="colMoney">Cost of goods</th>
                <th className="colMoney">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              {pagedRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="usersEmpty">
                    {isLoading ? "Loading..." : "No results."}
                  </td>
                </tr>
              ) : (
                pagedRows.map((r) => (
                  <tr key={r.categoryId || r.categoryName}>
                    <td className="salesByCategoryColCategory">{r.categoryName}</td>
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

      {dayPart !== "all" ? (
        <div className="salesSummaryHint">
          Some filters are placeholders and may require backend support.
        </div>
      ) : null}
    </div>
  );
}
