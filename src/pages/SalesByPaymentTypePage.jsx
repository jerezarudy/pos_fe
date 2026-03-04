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

function normalizePaymentType(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "unknown";
  if (raw === "card" || raw === "debit" || raw === "credit") return "card";
  if (raw === "cash") return "cash";
  return raw;
}

function titlePaymentType(value) {
  if (value === "card") return "Card";
  if (value === "cash") return "Cash";
  if (value === "unknown") return "Unknown";
  return String(value)
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(" ");
}

function generateDemoRows() {
  const base = [
    {
      paymentType: "card",
      paymentTransactions: 4,
      paymentAmount: 600,
      refundTransactions: 0,
      refundAmount: 0,
    },
    {
      paymentType: "cash",
      paymentTransactions: 6,
      paymentAmount: 1650,
      refundTransactions: 0,
      refundAmount: 0,
    },
  ];
  return base.map((r) => ({ ...r, netAmount: (r.paymentAmount || 0) - (r.refundAmount || 0) }));
}

export default function SalesByPaymentTypePage({ apiBaseUrl, authToken, authUser }) {
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => {
    const end = new Date();
    return formatIsoDateInput(addDays(end, -29));
  });
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));

  const [dayPart, setDayPart] = useState("all");
  const [employeeId, setEmployeeId] = useState("all");

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
            `/sales/reports/by-payment-type${buildQueryString({
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

        const out = data
          .map((r) => {
            if (!r || typeof r !== "object") return null;
            const paymentType = normalizePaymentType(
              r.paymentType ?? r.payment_type ?? r.type ?? r.payment?.type ?? "",
            );
            const paymentTransactions =
              toPositiveInt(
                r.paymentTransactions ??
                  r.payment_transactions ??
                  r.transactions ??
                  r.count ??
                  0,
                0,
              ) || 0;
            const paymentAmount =
              normalizeNumber(r.paymentAmount ?? r.payment_amount ?? r.amount) ?? 0;
            const refundTransactions =
              toPositiveInt(
                r.refundTransactions ?? r.refund_transactions ?? r.refunds ?? 0,
                0,
              ) || 0;
            const refundAmount =
              normalizeNumber(r.refundAmount ?? r.refund_amount ?? 0) ?? 0;
            const netAmount =
              normalizeNumber(r.netAmount ?? r.net_amount) ??
              (paymentAmount - refundAmount);
            return {
              paymentType,
              paymentTransactions,
              paymentAmount: Math.round(paymentAmount * 100) / 100,
              refundTransactions,
              refundAmount: Math.round(refundAmount * 100) / 100,
              netAmount: Math.round(netAmount * 100) / 100,
            };
          })
          .filter(Boolean)
          .sort((a, b) => b.paymentAmount - a.paymentAmount);

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
        setRows(out);
        setEmployees(employeesFromReport);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message =
          e instanceof Error ? e.message : "Failed to load sales by payment type.";
        setError(`${message} (Showing demo data)`);
        setIsDemoData(true);
        setRows(generateDemoRows());
        setEmployees([{ id: "demo", label: "Owner" }]);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, employeeId, endDate, reportStoreId, startDate]);

  const totalsRow = useMemo(() => {
    const total = rows.reduce(
      (acc, r) => {
        acc.paymentTransactions += r.paymentTransactions || 0;
        acc.paymentAmount += r.paymentAmount || 0;
        acc.refundTransactions += r.refundTransactions || 0;
        acc.refundAmount += r.refundAmount || 0;
        return acc;
      },
      {
        paymentTransactions: 0,
        paymentAmount: 0,
        refundTransactions: 0,
        refundAmount: 0,
      },
    );
    return {
      paymentType: "total",
      paymentTransactions: total.paymentTransactions,
      paymentAmount: Math.round(total.paymentAmount * 100) / 100,
      refundTransactions: total.refundTransactions,
      refundAmount: Math.round(total.refundAmount * 100) / 100,
      netAmount: Math.round((total.paymentAmount - total.refundAmount) * 100) / 100,
    };
  }, [rows]);

  const exportCsv = useCallback(() => {
    const header = [
      "Payment type",
      "Payment transactions",
      "Payment amount",
      "Refund transactions",
      "Refund amount",
      "Net amount",
    ];
    const csvRows = [
      ...rows.map((r) => [
        titlePaymentType(r.paymentType),
        String(r.paymentTransactions || 0),
        (r.paymentAmount || 0).toFixed(2),
        String(r.refundTransactions || 0),
        (r.refundAmount || 0).toFixed(2),
        (r.netAmount || 0).toFixed(2),
      ]),
      [
        "Total",
        String(totalsRow.paymentTransactions || 0),
        (totalsRow.paymentAmount || 0).toFixed(2),
        String(totalsRow.refundTransactions || 0),
        (totalsRow.refundAmount || 0).toFixed(2),
        (totalsRow.netAmount || 0).toFixed(2),
      ],
    ];
    const csv = `${toCsv([header, ...csvRows])}\n`;
    const filename = `sales-by-payment-type_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [endDate, rows, startDate, totalsRow]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatShortDate(clamped.start)} - ${formatShortDate(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page salesByPaymentTypePage">
      <div className="salesSummaryHeaderBar" aria-label="Sales by payment type">
        <div className="salesSummaryHeaderTitle">Sales by payment type</div>
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
              disabled={isLoading}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="table">
            <thead>
              <tr>
                <th className="salesByPaymentTypeColType">Payment type</th>
                <th className="salesByPaymentTypeColCount">Payment transactions</th>
                <th className="colMoney">Payment amount</th>
                <th className="salesByPaymentTypeColCount">Refund transactions</th>
                <th className="colMoney">Refund amount</th>
                <th className="colMoney">Net amount</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="usersEmpty">
                    {isLoading ? "Loading..." : "No results."}
                  </td>
                </tr>
              ) : (
                <>
                  {rows.map((r) => (
                    <tr key={r.paymentType}>
                      <td className="salesByPaymentTypeColType">{titlePaymentType(r.paymentType)}</td>
                      <td className="salesByPaymentTypeColCount">{r.paymentTransactions || 0}</td>
                      <td className="colMoney">{formatMoney(r.paymentAmount)}</td>
                      <td className="salesByPaymentTypeColCount">{r.refundTransactions || 0}</td>
                      <td className="colMoney">{formatMoney(r.refundAmount)}</td>
                      <td className="colMoney">{formatMoney(r.netAmount)}</td>
                    </tr>
                  ))}
                  <tr className="salesByPaymentTypeTotalRow">
                    <td className="salesByPaymentTypeColType">Total</td>
                    <td className="salesByPaymentTypeColCount">{totalsRow.paymentTransactions || 0}</td>
                    <td className="colMoney">{formatMoney(totalsRow.paymentAmount)}</td>
                    <td className="salesByPaymentTypeColCount">{totalsRow.refundTransactions || 0}</td>
                    <td className="colMoney">{formatMoney(totalsRow.refundAmount)}</td>
                    <td className="colMoney">{formatMoney(totalsRow.netAmount)}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
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
