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

function formatReceiptDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat("en-PH", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function normalizePaymentMethod(value) {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!raw) return "";
  if (raw === "cash") return "cash";
  if (raw === "card" || raw === "debit" || raw === "credit") return "card";
  return raw;
}

function titlePaymentMethod(value) {
  if (value === "cash") return "CASH";
  if (value === "card") return "GCASH";
  if (value === "split") return "Split";
  if (!value) return "--";
  return String(value)
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
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

function toMoneyNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value == null || value === "") return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function extractPaymentDetails(raw) {
  if (!raw || typeof raw !== "object") return [];
  const candidates = [
    raw.paymentDetails,
    raw.payment_details,
    raw.payments,
    raw.payment?.payments,
    raw.payment?.paymentDetails,
    raw.payment?.payment_details,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function normalizePaymentBreakdown(raw, paymentMethod, total) {
  const breakdown = { cash: 0, card: 0 };
  for (const detail of extractPaymentDetails(raw)) {
    if (!detail || typeof detail !== "object") continue;
    const method = normalizePaymentMethod(
      detail.type ?? detail.paymentType ?? detail.payment_type ?? detail.method,
    );
    const amount = toMoneyNumber(detail.amount ?? detail.total ?? detail.value);
    if (method === "cash") breakdown.cash += amount;
    if (method === "card") breakdown.card += amount;
  }

  if (breakdown.cash <= 0 && breakdown.card <= 0) {
    if (paymentMethod === "cash") breakdown.cash = total;
    if (paymentMethod === "card") breakdown.card = total;
  }

  return breakdown;
}

function unwrapSalePayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const data = payload.data && typeof payload.data === "object" ? payload.data : null;
  return (
    data?.sale ||
    data?.data ||
    payload.sale ||
    payload.receipt ||
    payload.order ||
    data ||
    payload
  );
}

function extractSaleItems(sale) {
  if (!sale || typeof sale !== "object") return [];
  const candidates = [
    sale.items,
    sale.lineItems,
    sale.line_items,
    sale.products,
    sale.productItems,
    sale.product_items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }
  return [];
}

function toItemName(raw) {
  if (!raw || typeof raw !== "object") return "";
  const direct =
    raw.name ??
    raw.itemName ??
    raw.item_name ??
    raw.title ??
    raw.label ??
    raw.productName ??
    raw.product_name ??
    raw.item?.name ??
    raw.product?.name ??
    "";
  const s = String(direct || "").trim();
  if (s) return s;
  const id = raw.itemId ?? raw.item_id ?? raw.productId ?? raw.product_id ?? raw.id ?? raw._id ?? null;
  return id == null ? "" : String(id);
}

function toItemQty(raw) {
  if (!raw || typeof raw !== "object") return 0;
  return toPositiveInt(
    raw.qty ?? raw.quantity ?? raw.count ?? raw.q ?? raw.amount ?? raw.units ?? 0,
    0,
  );
}

function summarizeSaleItems(payload, { maxItems = null } = {}) {
  const sale = unwrapSalePayload(payload);
  const items = extractSaleItems(sale);
  if (!items.length) return { label: "", totalQty: 0 };

  const normalized = items
    .map((it) => {
      const name = toItemName(it);
      const qty = toItemQty(it);
      if (!name || qty <= 0) return null;
      return { name, qty };
    })
    .filter(Boolean);

  if (!normalized.length) return { label: "", totalQty: 0 };

  const totalQty = normalized.reduce((sum, it) => sum + (it.qty || 0), 0);
  const shouldTrim = Number.isFinite(maxItems) && maxItems > 0;
  const shown = shouldTrim ? normalized.slice(0, Math.max(1, maxItems)) : normalized;
  const remaining = shouldTrim ? Math.max(0, normalized.length - shown.length) : 0;
  const label =
    shown.map((it) => `${it.name} ×${it.qty}`).join("\n") +
    (remaining ? `\n+${remaining} more` : "");
  return { label, totalQty };
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

function normalizeReceipt(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id ?? raw._id ?? raw.receiptId ?? raw.uuid ?? null;
  const receiptNo = raw.receiptNo ?? raw.receipt_no ?? raw.number ?? raw.no ?? "";
  const date = raw.date ?? raw.createdAt ?? raw.created_at ?? null;
  const employee =
    raw.employee ??
    raw.cashier ??
    raw.employeeName ??
    raw.cashierName ??
    raw.employee_name ??
    "";
  const customer = raw.customer ?? raw.customerName ?? raw.customer_name ?? "";
  const type = raw.type ?? raw.saleType ?? raw.kind ?? "";
  const paymentMethod = normalizePaymentMethod(
    raw.paymentType ?? raw.payment_type ?? raw.paymentMethod ?? raw.payment_method ?? raw.payment?.type ?? "",
  );
  const total = raw.total ?? raw.amount ?? raw.netSales ?? raw.net_sales ?? null;
  const normalizedTotal = toMoneyNumber(total);
  const paymentBreakdown = normalizePaymentBreakdown(
    raw,
    paymentMethod,
    normalizedTotal,
  );
  const currency = raw.currency ?? "PHP";
  if (!id) return null;
  return {
    id: String(id),
    receiptNo: String(receiptNo || "").trim(),
    date,
    employee: String(employee || "").trim(),
    customer: String(customer || "").trim(),
    type: String(type || "").trim(),
    paymentMethod,
    paymentBreakdown,
    total: normalizedTotal,
    currency: String(currency || "PHP"),
    raw,
  };
}

export default function ReceiptsReportPage({
  apiBaseUrl,
  authToken,
  authUser,
  lockedEmployeeId = "",
  hideEmployeeFilter = false,
  hideStoreFilter = false,
  hideSummary = false,
  replaceEmployeeColumnWithItems = false,
}) {
  const lockedEmployeeIdValue = String(lockedEmployeeId || "").trim();

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
  const [paymentMethodFilter, setPaymentMethodFilter] = useState("all");
  const [employeeId, setEmployeeId] = useState(() => lockedEmployeeIdValue || "all");
  const [q, setQ] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(10);
  const [total, setTotal] = useState(null);
  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : 1;
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [isDemoData, setIsDemoData] = useState(false);

  const [employees, setEmployees] = useState([]);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ allReceipts: 0, sales: 0, refunds: 0 });

  const [selected, setSelected] = useState(null);
  const lastFetchId = useRef(0);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path) => {
      const url = `${apiBaseUrl}${path}`;
      const response = await fetch(url, {
        method: "GET",
        headers: getAuthHeaders(),
        credentials: getFetchCredentials(),
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
    setPage(1);
  }, [paymentMethodFilter, startDate, endDate, employeeId, q, limit]);

  useEffect(() => {
    if (!lockedEmployeeIdValue) return;
    setEmployeeId(lockedEmployeeIdValue);
  }, [lockedEmployeeIdValue]);

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
        const from = formatIsoDateInput(clamped.start);
        const to = formatIsoDateInput(clamped.end);
        const baseParams = { from, to, storeId: storeId || undefined };

        const employeeIdForQuery = lockedEmployeeIdValue || (employeeId !== "all" ? employeeId : "");

        const receiptsQs = buildQueryString({
          ...baseParams,
          ...(paymentMethodFilter !== "all" ? { paymentType: paymentMethodFilter } : null),
          ...(employeeIdForQuery ? { employeeId: employeeIdForQuery } : null),
          ...(q.trim() ? { q: q.trim() } : null),
          page,
          limit,
        });

        const employeesQs = buildQueryString({ ...baseParams, page: 1, limit: 1000 });

        const [payload, employeePayload] = await Promise.all([
          apiRequest(`/sales/reports/receipts${receiptsQs}`),
          lockedEmployeeIdValue
            ? Promise.resolve(null)
            : apiRequest(`/sales/reports/by-employee${employeesQs}`).catch(() => null),
        ]);

        const parsed = parsePagedResponse(payload, { page, limit });
        const list = extractList(parsed.data)
          .map(normalizeReceipt)
          .filter(Boolean)
          .filter((row) => paymentMethodFilter === "all" || row.paymentMethod === paymentMethodFilter);

        const listWithItems = replaceEmployeeColumnWithItems
          ? await Promise.all(
              list.map(async (row) => {
                try {
                  const salePayload = await apiRequest(
                    `/sales/${encodeURIComponent(row.id)}`,
                  );
                  const summary = summarizeSaleItems(salePayload);
                  return { ...row, itemsSummary: summary.label, itemsQty: summary.totalQty };
                } catch {
                  return { ...row, itemsSummary: "", itemsQty: 0 };
                }
              }),
            )
          : list;

        const summaryPayload =
          payload?.summary && typeof payload.summary === "object"
            ? payload.summary
            : payload?.data?.summary && typeof payload.data.summary === "object"
              ? payload.data.summary
              : {};

        const nextSummary = {
          allReceipts: toPositiveInt(summaryPayload.allReceipts ?? summaryPayload.all_receipts ?? 0, 0),
          sales: toPositiveInt(summaryPayload.sales ?? 0, 0),
          refunds: toPositiveInt(summaryPayload.refunds ?? 0, 0),
        };

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
        setRows(listWithItems);
        setSummary(nextSummary);
        setEmployees(lockedEmployeeIdValue ? [] : employeesFromReport);
        setTotal(parsed.total ?? null);
        setHasNext(Boolean(parsed.hasNext));
        setHasPrev(Boolean(parsed.hasPrev));
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        const message = e instanceof Error ? e.message : "Failed to load receipts.";
        setError(`${message} (Showing demo data)`);
        setIsDemoData(true);
        setEmployees(lockedEmployeeIdValue ? [] : [{ id: "demo", label: "Owner" }]);
        setSummary({ allReceipts: 10, sales: 10, refunds: 0 });
        setRows([
          normalizeReceipt({
            id: "demo:1",
            receiptNo: "1-0010",
            date: new Date().toISOString(),
            employee: "Owner",
            customer: "--",
            type: "Sale",
            paymentType: "cash",
            total: 450,
            currency: "PHP",
          }),
          normalizeReceipt({
            id: "demo:2",
            receiptNo: "1-0011",
            date: new Date().toISOString(),
            employee: "Owner",
            customer: "--",
            type: "Sale",
            paymentType: "card",
            total: 125,
            currency: "PHP",
          }),
          normalizeReceipt({
            id: "demo:3",
            receiptNo: "1-0012",
            date: new Date().toISOString(),
            employee: "Owner",
            customer: "--",
            type: "Sale",
            paymentType: "split",
            paymentDetails: [
              { type: "cash", amount: 50 },
              { type: "card", amount: 75 },
            ],
            total: 125,
            currency: "PHP",
          }),
        ].filter(Boolean));
        setTotal(1);
        setHasNext(false);
        setHasPrev(false);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [
    apiRequest,
    employeeId,
    endDate,
    limit,
    lockedEmployeeIdValue,
    page,
    q,
    replaceEmployeeColumnWithItems,
    paymentMethodFilter,
    startDate,
    storeId,
  ]);

  const visibleRows = useMemo(() => {
    if (paymentMethodFilter === "all") return rows;
    return rows.filter((row) => row.paymentMethod === paymentMethodFilter);
  }, [paymentMethodFilter, rows]);

  useEffect(() => {
    if (!selected) return;
    if (visibleRows.some((row) => row.id === selected.id)) return;
    setSelected(null);
  }, [selected, visibleRows]);

  const exportCsv = useCallback(() => {
    const header = replaceEmployeeColumnWithItems
      ? ["Receipt no.", "Date", "Items", "Customer", "Type", "Payment", "Cash", "GCash", "Total"]
      : ["Receipt no.", "Date", "Employee", "Customer", "Type", "Payment", "Cash", "GCash", "Total"];
    const csvRows = visibleRows.map((r) => [
      r.receiptNo,
      r.date ? new Date(r.date).toISOString() : "",
      replaceEmployeeColumnWithItems
        ? String(r.itemsSummary || "").replaceAll("\n", "; ")
        : r.employee,
      r.customer,
      r.type,
      titlePaymentMethod(r.paymentMethod),
      (Number(r.paymentBreakdown?.cash) || 0).toFixed(2),
      (Number(r.paymentBreakdown?.card) || 0).toFixed(2),
      (Number(r.total) || 0).toFixed(2),
    ]);
    const csv = `${toCsv([header, ...csvRows])}\n`;
    const filename = `receipts_${startDate || "start"}_${endDate || "end"}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [endDate, replaceEmployeeColumnWithItems, startDate, visibleRows]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Receipts">
        <div className="salesSummaryHeaderTitle">Receipts</div>
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
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
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
                const days = Math.max(1, Math.round((clamped.end - clamped.start) / 86400000) + 1);
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
              value={paymentMethodFilter}
              onChange={(e) => setPaymentMethodFilter(e.target.value)}
              aria-label="Payment method filter"
              disabled={isLoading}
            >
              <option value="all">All payments</option>
              <option value="cash">Cash</option>
              <option value="card">GCash</option>
              <option value="split">Split</option>
            </select>
          </div>

          {!hideEmployeeFilter && !lockedEmployeeIdValue ? (
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
          ) : null}

          {!hideStoreFilter ? (
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
          ) : null}

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

      <div className="receiptsReportContent">
        <div className="receiptsReportMain">
          {!hideSummary ? (
            <div className="card receiptsReportStats">
              <div className="receiptsStat">
                <div className="receiptsStatLabel">All receipts</div>
                <div className="receiptsStatValue">{summary.allReceipts || 0}</div>
              </div>
              <div className="receiptsStatDivider" aria-hidden="true" />
              <div className="receiptsStat">
                <div className="receiptsStatLabel">Sales</div>
                <div className="receiptsStatValue">{summary.sales || 0}</div>
              </div>
              <div className="receiptsStatDivider" aria-hidden="true" />
              <div className="receiptsStat">
                <div className="receiptsStatLabel">Refunds</div>
                <div className="receiptsStatValue">{summary.refunds || 0}</div>
              </div>
            </div>
          ) : null}

          <div className="card salesSummaryTableCard">
            <div className="salesSummaryTableHeader">
              <div className="salesSummaryExportLabel">EXPORT</div>
              <div className="receiptsReportHeaderRight">
                <input
                  className="receiptsSearchInput"
                  type="search"
                  placeholder="Search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  disabled={isLoading}
                  aria-label="Search receipts"
                />
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
              <table className="table receiptsTable">
                <thead>
                  <tr>
                    <th className="receiptsColNo">Receipt no.</th>
                    <th className="receiptsColDate">Date</th>
                    <th className="receiptsColEmployee">
                      {replaceEmployeeColumnWithItems ? "Items" : "Employee"}
                    </th>
                    <th className="receiptsColCustomer">Customer</th>
                    <th className="receiptsColType">Type</th>
                    <th className="receiptsColPayment">Payment</th>
                    <th className="colMoney receiptsColPaymentAmount">Cash</th>
                    <th className="colMoney receiptsColPaymentAmount">GCash</th>
                    <th className="colMoney">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="usersEmpty">
                        {isLoading ? "Loading..." : "No results."}
                      </td>
                    </tr>
                  ) : (
                    visibleRows.map((r) => (
                      <tr
                        key={r.id}
                        className={`receiptsRow ${selected?.id === r.id ? "receiptsRowActive" : ""}`}
                        onClick={() => setSelected(r)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setSelected(r);
                        }}
                      >
                        <td className="receiptsColNo">{r.receiptNo || r.id}</td>
                        <td className="receiptsColDate">{formatReceiptDate(r.date)}</td>
                        <td
                          className="receiptsColEmployee"
                          title={replaceEmployeeColumnWithItems ? r.itemsSummary : r.employee}
                          style={
                            replaceEmployeeColumnWithItems
                              ? { whiteSpace: "pre-line" }
                              : undefined
                          }
                        >
                          {replaceEmployeeColumnWithItems
                            ? r.itemsSummary || "--"
                            : r.employee || "--"}
                        </td>
                        <td className="receiptsColCustomer">{r.customer || "--"}</td>
                        <td className="receiptsColType">{r.type || "--"}</td>
                        <td className="receiptsColPayment">{titlePaymentMethod(r.paymentMethod)}</td>
                        <td className="colMoney receiptsColPaymentAmount">
                          {r.paymentBreakdown?.cash
                            ? formatMoney(r.paymentBreakdown.cash)
                            : "--"}
                        </td>
                        <td className="colMoney receiptsColPaymentAmount">
                          {r.paymentBreakdown?.card
                            ? formatMoney(r.paymentBreakdown.card)
                            : "--"}
                        </td>
                        <td className="colMoney">{formatMoney(r.total)}</td>
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
                  disabled={!hasPrev || page <= 1 || isLoading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={!hasNext || page >= totalPages || isLoading}
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
                  value={String(limit)}
                  onChange={(e) => setLimit(toPositiveInt(e.target.value, limit))}
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
        </div>

        <aside className={`receiptsReportDrawer ${selected ? "receiptsReportDrawerOpen" : ""}`}>
          {selected ? (
            <div className="receiptsDrawerBody" role="dialog" aria-label="Receipt details">
              <div className="receiptsDrawerTop">
                <button
                  className="receiptsDrawerClose"
                  type="button"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
              </div>
              <div className="receiptsDrawerTotal">{formatMoney(selected.total)}</div>
              <div className="receiptsDrawerTotalLabel">Total</div>
              <div className="receiptsDrawerDivider" aria-hidden="true" />
              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">
                    {replaceEmployeeColumnWithItems ? "Items" : "Employee"}
                  </span>
                  <span
                    className="receiptsDrawerMetaValue"
                    style={
                      replaceEmployeeColumnWithItems
                        ? { whiteSpace: "pre-line" }
                        : undefined
                    }
                  >
                    {replaceEmployeeColumnWithItems
                      ? selected.itemsSummary || "--"
                      : selected.employee || "--"}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Customer</span>
                  <span className="receiptsDrawerMetaValue">{selected.customer || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Type</span>
                  <span className="receiptsDrawerMetaValue">{selected.type || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Payment</span>
                  <span className="receiptsDrawerMetaValue">
                    {titlePaymentMethod(selected.paymentMethod)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Cash</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.paymentBreakdown?.cash
                      ? formatMoney(selected.paymentBreakdown.cash)
                      : "--"}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">GCash</span>
                  <span className="receiptsDrawerMetaValue">
                    {selected.paymentBreakdown?.card
                      ? formatMoney(selected.paymentBreakdown.card)
                      : "--"}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Date</span>
                  <span className="receiptsDrawerMetaValue">{formatReceiptDate(selected.date)}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Receipt no.</span>
                  <span className="receiptsDrawerMetaValue">{selected.receiptNo || selected.id}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">Select a receipt to view details.</div>
          )}
        </aside>
      </div>

      {dayPart !== "all" ? (
        <div className="salesSummaryHint">
          Some filters are placeholders and may require backend support.
        </div>
      ) : null}
    </div>
  );
}
