import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
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

function normalizeNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(value) {
  const normalized = normalizeNumber(value);
  if (!Number.isFinite(normalized)) return 0;
  return Math.round(normalized * 100) / 100;
}

function extractObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function getValueFromPaths(source, paths) {
  for (const path of paths) {
    const segments = String(path || "")
      .split(".")
      .filter(Boolean);
    let current = source;
    let missing = false;
    for (const segment of segments) {
      if (!current || typeof current !== "object" || !(segment in current)) {
        missing = true;
        break;
      }
      current = current[segment];
    }
    if (!missing && current != null && current !== "") return current;
  }
  return null;
}

function normalizeEndOfDayReport(payload) {
  const root = extractObject(payload?.data ?? payload);
  const summary = extractObject(root.summary);
  const cash = extractObject(root.cash);

  const money = (paths) => roundMoney(getValueFromPaths({ root, summary, cash }, paths));
  const count = (paths) => {
    const value = normalizeNumber(getValueFromPaths({ root, summary, cash }, paths));
    return Number.isFinite(value) ? Math.round(value) : 0;
  };

  return {
    summary: {
      grossSales: money([
        "summary.grossSales",
        "summary.gross_sales",
        "root.grossSales",
        "root.gross_sales",
      ]),
      netSales: money([
        "summary.netSales",
        "summary.net_sales",
        "root.netSales",
        "root.net_sales",
      ]),
      discounts: money([
        "summary.discounts",
        "summary.discountAmount",
        "summary.discount_amount",
        "root.discounts",
        "root.discountAmount",
        "root.discount_amount",
      ]),
      grossProfit: money([
        "summary.grossProfit",
        "summary.gross_profit",
        "root.grossProfit",
        "root.gross_profit",
      ]),
      costOfGoods: money([
        "summary.costOfGoods",
        "summary.cost_of_goods",
        "summary.cogs",
        "root.costOfGoods",
        "root.cost_of_goods",
        "root.cogs",
      ]),
      refundAmount: money([
        "summary.refundAmount",
        "summary.refund_amount",
        "root.refundAmount",
        "root.refund_amount",
      ]),
      salesTransactions: count([
        "summary.salesTransactions",
        "summary.sales_transactions",
        "root.salesTransactions",
        "root.sales_transactions",
      ]),
      refundTransactions: count([
        "summary.refundTransactions",
        "summary.refund_transactions",
        "root.refundTransactions",
        "root.refund_transactions",
      ]),
      receipts: count([
        "summary.receipts",
        "root.receipts",
      ]),
    },
    cash: {
      sales: money([
        "cash.sales",
        "cash.cashSales",
        "cash.cash_sales",
        "root.cashSales",
        "root.cash_sales",
      ]),
      refunds: money([
        "cash.refunds",
        "cash.cashRefunds",
        "cash.cash_refunds",
        "root.cashRefunds",
        "root.cash_refunds",
      ]),
      net: money([
        "cash.net",
        "cash.cashNet",
        "cash.cash_net",
        "root.cashNet",
        "root.cash_net",
      ]),
      cashReceived: money([
        "cash.cashReceived",
        "cash.cash_received",
        "root.cashReceived",
        "root.cash_received",
      ]),
      changeGiven: money([
        "cash.changeGiven",
        "cash.change_given",
        "root.changeGiven",
        "root.change_given",
      ]),
      cashCollected: money([
        "cash.cashCollected",
        "cash.cash_collected",
        "root.cashCollected",
        "root.cash_collected",
      ]),
    },
  };
}

function MetricCard({ label, value, helper, isLoading = false }) {
  return (
    <div className="card salesSummaryKpiCard">
      <div className="salesSummaryKpiLabel">{label}</div>
      <div className="salesSummaryKpiValue">{isLoading ? "--" : formatMoney(value)}</div>
      <div className="salesSummaryKpiDelta salesSummaryKpiDeltaUp">
        {isLoading ? "Loading..." : helper}
      </div>
    </div>
  );
}

export default function EndOfDayCashPage({
  apiBaseUrl,
  authToken,
  authUser,
  lockedEmployeeId = "",
  hideStoreFilter = false,
}) {
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const showGrossProfit = authRole !== "cashier";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const lockedCashierId = useMemo(() => String(lockedEmployeeId || "").trim(), [lockedEmployeeId]);

  const [date, setDate] = useState(() => todayKey);
  const [storeId, setStoreId] = useState(() => reportStoreId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState(() => ({
    summary: {
      grossSales: 0,
      netSales: 0,
      discounts: 0,
      grossProfit: 0,
      costOfGoods: 0,
      refundAmount: 0,
      salesTransactions: 0,
      refundTransactions: 0,
      receipts: 0,
    },
    cash: {
      sales: 0,
      refunds: 0,
      net: 0,
      cashReceived: 0,
      changeGiven: 0,
      cashCollected: 0,
    },
  }));

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
    if (!apiBaseUrl || !date) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const query = buildQueryString({
          startDate: date,
          endDate: date,
          from: date,
          to: date,
          storeId: storeId || undefined,
          allStores: canPickStore && !storeId ? true : undefined,
          employeeId: lockedCashierId || undefined,
        });

        const payload = await apiRequest(`/sales/reports/end-of-day-cash${query}`);
        if (fetchId !== lastFetchId.current) return;
        setReport(normalizeEndOfDayReport(payload));
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load end-of-day cash.");
        setReport({
          summary: {
            grossSales: 0,
            netSales: 0,
            discounts: 0,
            grossProfit: 0,
            costOfGoods: 0,
            refundAmount: 0,
            salesTransactions: 0,
            refundTransactions: 0,
            receipts: 0,
          },
          cash: {
            sales: 0,
            refunds: 0,
            net: 0,
            cashReceived: 0,
            changeGiven: 0,
            cashCollected: 0,
          },
        });
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, canPickStore, date, lockedCashierId, storeId]);

  const summaryCards = useMemo(() => {
    const helper = `For ${date || "--"}`;
    const cards = [
      { key: "grossSales", label: "Gross sales", value: report.summary.grossSales },
      { key: "netSales", label: "Net sales", value: report.summary.netSales },
      { key: "discounts", label: "Discounts", value: report.summary.discounts },
    ];
    if (showGrossProfit) {
      cards.push({
        key: "grossProfit",
        label: "Gross profit",
        value: report.summary.grossProfit,
      });
    }
    return cards.map((card) => ({ ...card, helper }));
  }, [date, report.summary, showGrossProfit]);

  return (
    <div className="page salesSummaryPage">
      <div className="salesSummaryHeaderBar" aria-label="End of Day Cash">
        <div className="salesSummaryHeaderTitle">End of Day Cash</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date">
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Report date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="salesSummaryFilterGroup">
            {hideStoreFilter ? null : (
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
            )}
          </div>
        </div>
      </div>

      {error ? <div className="authError salesSummaryError">{error}</div> : null}

      <div className="salesSummaryKpiGrid" aria-label="Key metrics">
        {summaryCards.map((card) => (
          <MetricCard key={card.key} {...card} isLoading={isLoading} />
        ))}
      </div>
    </div>
  );
}
