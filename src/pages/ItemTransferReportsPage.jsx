import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  downloadTextFile,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  parsePagedResponse,
  toCsv,
  toPositiveInt,
} from "../utils/common.js";
import { makeStoreOptions, useStoresList } from "../utils/stores.js";

function formatIsoDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTransferDate(value) {
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

function extractTransfersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.transfers)) return payload.transfers;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.transfers)) return payload.data.transfers;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function readText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    return String(
      value.name ?? value.storeName ?? value.itemName ?? value.fullName ?? value.email ?? value.id ?? value._id ?? "",
    ).trim();
  }
  return String(value).trim();
}

function readNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstValue(raw, keys) {
  for (const key of keys) {
    const path = String(key).split(".");
    let current = raw;
    for (const part of path) {
      if (current == null || typeof current !== "object") {
        current = undefined;
        break;
      }
      current = current[part];
    }
    if (current !== undefined && current !== null && current !== "") return current;
  }
  return null;
}

function normalizeTransfer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = firstValue(raw, ["id", "_id", "transferId", "transfer_id", "uuid"]);
  const itemId = firstValue(raw, ["itemId", "item_id", "item.id", "item._id"]);
  const itemName = readText(firstValue(raw, ["itemName", "item_name", "item.name", "name"])) || (itemId ? String(itemId) : "--");
  const fromStoreId = firstValue(raw, [
    "fromStoreId",
    "from_store_id",
    "originStoreId",
    "origin_store_id",
    "storeOriginId",
    "fromStore.id",
    "fromStore._id",
    "originStore.id",
    "originStore._id",
  ]);
  const toStoreId = firstValue(raw, [
    "toStoreId",
    "to_store_id",
    "destinationStoreId",
    "destination_store_id",
    "storeDestinationId",
    "toStore.id",
    "toStore._id",
    "destinationStore.id",
    "destinationStore._id",
  ]);
  const fromStoreName =
    readText(firstValue(raw, ["fromStoreName", "from_store_name", "fromStore.name", "originStore.name"])) ||
    (fromStoreId ? String(fromStoreId) : "--");
  const toStoreName =
    readText(firstValue(raw, ["toStoreName", "to_store_name", "toStore.name", "destinationStore.name"])) ||
    (toStoreId ? String(toStoreId) : "--");
  const actor =
    readText(firstValue(raw, ["user", "actor", "createdBy", "created_by", "userName", "actorName"])) || "--";
  const date = firstValue(raw, ["createdAt", "created_at", "transferredAt", "transferred_at", "date", "timestamp"]);
  const amount = readNumber(firstValue(raw, ["amount", "quantity", "qty", "count"]));

  return {
    id: id == null ? `${itemId || itemName}-${fromStoreId || ""}-${toStoreId || ""}-${date || ""}` : String(id),
    itemId: itemId == null ? "" : String(itemId),
    itemName,
    fromStoreId: fromStoreId == null ? "" : String(fromStoreId),
    fromStoreName,
    toStoreId: toStoreId == null ? "" : String(toStoreId),
    toStoreName,
    amount,
    actor,
    date,
  };
}

export default function ItemTransferReportsPage({ apiBaseUrl, authToken, authUser }) {
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [fromStoreId, setFromStoreId] = useState("");
  const [toStoreId, setToStoreId] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [pageInput, setPageInput] = useState("1");
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const lastFetchId = useRef(0);

  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);

  const getAuthHeaders = useCallback(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  const apiRequest = useCallback(
    async (path) => {
      const response = await fetch(`${apiBaseUrl}${path}`, {
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
  const storeOptions = useMemo(
    () => makeStoreOptions({ stores, activeStoreId: fromStoreId || toStoreId || reportStoreId }),
    [fromStoreId, reportStoreId, stores, toStoreId],
  );

  useEffect(() => {
    if (canPickStore) return;
    if (!reportStoreId) return;
    setFromStoreId((current) => current || reportStoreId);
  }, [canPickStore, reportStoreId]);

  useEffect(() => {
    setPage(1);
    setPageInput("1");
  }, [endDate, fromStoreId, limit, startDate, toStoreId]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const payload = await apiRequest(
          `/items/reports/transfers${buildQueryString({
            from: startDate || undefined,
            to: endDate || undefined,
            fromStoreId: fromStoreId || undefined,
            toStoreId: toStoreId || undefined,
            page,
            limit,
          })}`,
        );
        if (fetchId !== lastFetchId.current) return;
        const parsed = parsePagedResponse(payload, { page, limit });
        const normalized = extractTransfersList({ ...payload, data: parsed.data })
          .map(normalizeTransfer)
          .filter(Boolean);
        setRows(normalized);
        setTotal(parsed.total ?? null);
        setHasNext(Boolean(parsed.hasNext));
        setHasPrev(Boolean(parsed.hasPrev));
        setPageInput(String(page));
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setRows([]);
        setTotal(null);
        setHasNext(false);
        setHasPrev(false);
        setError(e instanceof Error ? e.message : "Failed to load item transfer reports.");
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiBaseUrl, apiRequest, endDate, fromStoreId, limit, page, startDate, toStoreId]);

  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : null;
  const rangeLabel = `${startDate || "start"} - ${endDate || "end"}`;

  const exportCsv = useCallback(() => {
    const csv = `${toCsv([
      ["Item", "Amount", "From store", "To store", "User", "Date", "Item ID", "From Store ID", "To Store ID", "Transfer ID"],
      ...rows.map((row) => [
        row.itemName,
        row.amount == null ? "" : row.amount,
        row.fromStoreName,
        row.toStoreName,
        row.actor,
        row.date ? new Date(row.date).toISOString() : "",
        row.itemId,
        row.fromStoreId,
        row.toStoreId,
        row.id,
      ]),
    ])}\n`;
    downloadTextFile({
      filename: `item-transfers_${startDate || "start"}_${endDate || "end"}.csv`,
      content: `\uFEFF${csv}`,
      mime: "text/csv;charset=utf-8",
    });
  }, [endDate, rows, startDate]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Item Transfer Reports">
        <div className="salesSummaryHeaderTitle">Item Transfer Reports</div>
      </div>

      <div className="card salesSummaryFiltersCard">
        <div className="salesSummaryFilters">
          <div className="salesSummaryFilterGroup" aria-label="Date range">
            <div className="salesSummaryRangeInputs">
              <input
                className="salesSummaryDateInput"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value > todayKey ? todayKey : e.target.value)}
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
                onChange={(e) => setEndDate(e.target.value > todayKey ? todayKey : e.target.value)}
                aria-label="End date"
                max={todayKey}
                disabled={isLoading}
              />
            </div>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={fromStoreId}
              onChange={(e) => setFromStoreId(e.target.value)}
              aria-label="Origin store filter"
              disabled={isLoading || isStoresLoading || !canPickStore}
            >
              {canPickStore ? <option value="">All origin stores</option> : null}
              {!canPickStore && !fromStoreId ? <option value="">No store assigned</option> : null}
              {storeOptions.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name || store.id}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={toStoreId}
              onChange={(e) => setToStoreId(e.target.value)}
              aria-label="Destination store filter"
              disabled={isLoading || isStoresLoading}
            >
              <option value="">All destination stores</option>
              {storeOptions.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name || store.id}
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

      <div className="card salesSummaryTableCard">
        <div className="salesSummaryTableHeader">
          <div className="salesSummaryExportLabel">EXPORT</div>
          <div className="receiptsReportHeaderRight">
            <button
              className="btn btnGhost btnSmall"
              type="button"
              onClick={exportCsv}
              disabled={isLoading || rows.length === 0}
            >
              Download CSV
            </button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="table receiptsTable" aria-label="Item transfer reports table">
            <thead>
              <tr>
                <th className="colName">Item</th>
                <th className="colStock">Amount</th>
                <th className="colStore">From store</th>
                <th className="colStore">To store</th>
                <th className="receiptsColEmployee">User</th>
                <th className="receiptsColDate">Date</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="usersEmpty">
                    {isLoading ? "Loading..." : "No item transfers found."}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id}>
                    <td className="colName">{row.itemName}</td>
                    <td className="colStock">{row.amount ?? "--"}</td>
                    <td className="colStore">{row.fromStoreName}</td>
                    <td className="colStore">{row.toStoreName}</td>
                    <td className="receiptsColEmployee">{row.actor}</td>
                    <td className="receiptsColDate">{formatTransferDate(row.date)}</td>
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
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              {"<"}
            </button>
            <button
              className="pagerBtn"
              type="button"
              aria-label="Next page"
              disabled={!hasNext || isLoading}
              onClick={() => setPage((current) => current + 1)}
            >
              {">"}
            </button>
          </div>

          <div className="pagerMeta">
            <span>Page:</span>
            <input
              className="pageInput"
              type="text"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const next = toPositiveInt(pageInput, page);
                setPage(totalPages ? Math.min(next, totalPages) : next);
              }}
              onBlur={() => {
                const next = toPositiveInt(pageInput, page);
                const clamped = totalPages ? Math.min(next, totalPages) : next;
                setPageInput(String(clamped));
                setPage(clamped);
              }}
              aria-label="Page number"
              disabled={isLoading}
            />
            <span>of {totalPages ?? "--"}</span>
          </div>

          <div className="pagerMeta">
            <span>Rows per page:</span>
            <select
              className="select selectSmall"
              value={String(limit)}
              onChange={(e) => {
                setLimit(toPositiveInt(e.target.value, limit));
                setPage(1);
                setPageInput("1");
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
    </div>
  );
}
