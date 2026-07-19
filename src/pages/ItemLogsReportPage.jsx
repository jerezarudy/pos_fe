import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  buildQueryString,
  downloadTextFile,
  getActorHeaders,
  getAuthUserRole,
  getFetchCredentials,
  getReportStoreId,
  toCsv,
  toNonNegativeInt,
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

function formatLogDate(value) {
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

function readText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (typeof value === "object") {
    const preferred =
      value.name ??
      value.fullName ??
      value.email ??
      value.label ??
      value.title ??
      value.id ??
      value._id ??
      "";
    return String(preferred || "").trim();
  }
  return String(value).trim();
}

function readPath(source, path) {
  const keys = String(path || "").split(".");
  let current = source;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function firstValue(source, paths) {
  for (const path of paths) {
    const value = readPath(source, path);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

function extractLogsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.logs)) return payload.logs;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.data?.logs)) return payload.data.logs;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  return [];
}

function parseLogsPagedResponse(payload, fallbacks = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const nested =
    root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};

  const data = extractLogsList(payload);
  const page = toPositiveInt(root.page ?? nested.page, fallbacks.page ?? 1);
  const limit = toPositiveInt(root.limit ?? nested.limit, fallbacks.limit ?? 20);
  const total = toNonNegativeInt(root.total ?? nested.total, fallbacks.total ?? null);
  const hasNext =
    typeof (root.hasNext ?? nested.hasNext) === "boolean"
      ? Boolean(root.hasNext ?? nested.hasNext)
      : typeof (root.has_next ?? nested.has_next) === "boolean"
        ? Boolean(root.has_next ?? nested.has_next)
        : fallbacks.hasNext ?? false;

  return { data, page, limit, total, hasNext };
}

function normalizeLogType(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (lowered.includes("delete")) return "delete";
  if (lowered.includes("edit") || lowered.includes("update")) return "edit";
  if (lowered.includes("create")) return "create";
  return lowered || "edit";
}

function formatLogType(value) {
  const normalized = normalizeLogType(value);
  if (normalized === "create") return "Create";
  if (normalized === "edit") return "Edit";
  if (normalized === "delete") return "Delete";
  return normalized
    .split(/[_\s-]+/g)
    .filter(Boolean)
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

function toFiniteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatQuantity(value) {
  return Number.isFinite(value) ? String(value) : "--";
}

function formatStoreLabel(storeName, storeId) {
  const name = String(storeName || "").trim();
  const id = String(storeId || "").trim();
  return name || id || "--";
}

function uniqOptions(list) {
  const map = new Map();
  for (const option of list || []) {
    if (!option?.id) continue;
    map.set(String(option.id), {
      id: String(option.id),
      label: String(option.label || option.id),
    });
  }
  return Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

function normalizeItemLog(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = firstValue(raw, ["id", "_id", "auditId", "audit_id", "logId", "log_id"]);
  const itemId = firstValue(raw, ["itemId", "item_id", "item.id", "item._id"]);
  const userId = firstValue(raw, ["userId", "user_id", "user.id", "user._id", "actor.id"]);
  const storeId = firstValue(raw, ["storeId", "store_id", "store.id", "store._id"]);
  const transactionDate = firstValue(raw, [
    "transactionDate",
    "transaction_date",
    "createdAt",
    "created_at",
    "timestamp",
    "date",
    "loggedAt",
  ]);
  const transactionType = normalizeLogType(
    firstValue(raw, ["transactionType", "transaction_type", "action", "event", "type"]),
  );

  const fallbackId = [
    itemId || "item",
    userId || "user",
    storeId || "store",
    transactionType,
    transactionDate || Date.now(),
  ].join(":");

  const itemName =
    readText(firstValue(raw, ["itemName", "item_name", "item.name", "resourceName"])) ||
    (itemId ? String(itemId) : "");
  const userName =
    readText(
      firstValue(raw, [
        "userName",
        "user_name",
        "user.name",
        "user.fullName",
        "user.email",
        "actorName",
        "actor.name",
      ]),
    ) || (userId ? String(userId) : "");
  const storeName =
    readText(firstValue(raw, ["storeName", "store_name", "store.name", "store.label"])) ||
    (storeId ? String(storeId) : "");

  return {
    id: String(id || fallbackId),
    itemId: itemId == null ? "" : String(itemId),
    itemName: itemName || "--",
    transactionDate,
    transactionType,
    transactionTypeLabel: formatLogType(transactionType),
    quantity: toFiniteNumber(firstValue(raw, ["quantity", "qty", "stock", "body.quantity"])),
    userId: userId == null ? "" : String(userId),
    userName: userName || "--",
    storeId: storeId == null ? "" : String(storeId),
    storeName: storeName || "",
    storeLabel: formatStoreLabel(storeName, storeId),
    raw,
  };
}

export default function ItemLogsReportPage({ apiBaseUrl, authToken, authUser }) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const [storeId, setStoreId] = useState(() => reportStoreId);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [itemId, setItemId] = useState("all");
  const [userId, setUserId] = useState("all");
  const [transactionType, setTransactionType] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(500);

  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [selected, setSelected] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const lastFetchId = useRef(0);

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
  const storeOptions = useMemo(() => {
    return makeStoreOptions({ stores, activeStoreId: storeId });
  }, [storeId, stores]);

  const visibleStoreOptions = useMemo(() => {
    if (canPickStore) return storeOptions;
    const active = String(storeId || "").trim();
    if (!active) return [];
    return storeOptions.filter((store) => String(store.id) === active);
  }, [canPickStore, storeId, storeOptions]);

  useEffect(() => {
    if (!canPickStore) setStoreId(reportStoreId);
  }, [canPickStore, reportStoreId]);

  useEffect(() => {
    setPage(1);
  }, [endDate, itemId, limit, startDate, storeId, transactionType, userId]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    setIsLoading(true);
    setError("");

    (async () => {
      try {
        const payload = await apiRequest(
          `/audit-logs/items/logs${buildQueryString({
            from: formatIsoDateInput(clamped.start),
            to: formatIsoDateInput(clamped.end),
            page,
            limit,
            ...(itemId !== "all" ? { itemId } : null),
            ...(userId !== "all" ? { userId } : null),
            ...(storeId ? { storeId } : null),
            ...(transactionType !== "all" ? { transactionType } : null),
          })}`,
        );

        const parsed = parseLogsPagedResponse(payload, { page, limit });
        const normalized = parsed.data.map(normalizeItemLog).filter(Boolean);
        if (fetchId !== lastFetchId.current) return;
        setRows(normalized);
        setTotal(parsed.total ?? normalized.length);
      } catch (e) {
        if (fetchId !== lastFetchId.current) return;
        setError(e instanceof Error ? e.message : "Failed to load item logs.");
        setRows([]);
        setTotal(0);
      } finally {
        if (fetchId === lastFetchId.current) setIsLoading(false);
      }
    })();
  }, [apiRequest, endDate, itemId, limit, page, startDate, storeId, transactionType, userId]);

  const itemOptions = useMemo(() => {
    return uniqOptions(
      rows.map((row) => ({
        id: row.itemId || row.id,
        label: row.itemName || row.itemId || row.id,
      })),
    );
  }, [rows]);

  const userOptions = useMemo(() => {
    return uniqOptions(
      rows.map((row) => ({
        id: row.userId || row.id,
        label: row.userName || row.userId || row.id,
      })),
    );
  }, [rows]);

  const totalPages = Math.max(1, Math.ceil(total / limit));
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    if (!selected) return;
    if (rows.some((row) => row.id === selected.id)) return;
    setSelected(null);
  }, [rows, selected]);

  const exportCsv = useCallback(() => {
    const csv = `${toCsv([
      [
        "Item",
        "Transaction date",
        "Transaction type",
        "Quantity",
        "User",
        "Store",
        "Item ID",
        "User ID",
        "Store ID",
        "Log ID",
      ],
      ...rows.map((row) => [
        row.itemName,
        row.transactionDate ? new Date(row.transactionDate).toISOString() : "",
        row.transactionTypeLabel,
        formatQuantity(row.quantity),
        row.userName,
        row.storeLabel,
        row.itemId,
        row.userId,
        row.storeId,
        row.id,
      ]),
    ])}\n`;
    const filename = `item-logs_${startDate || "start"}_${endDate || "end"}_${transactionType}.csv`;
    downloadTextFile({ filename, content: `\uFEFF${csv}`, mime: "text/csv;charset=utf-8" });
  }, [endDate, rows, startDate, transactionType]);

  const rangeLabel = useMemo(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return "--";
    return `${formatIsoDateInput(clamped.start)} - ${formatIsoDateInput(clamped.end)}`;
  }, [endDate, startDate]);

  return (
    <div className="page receiptsReportPage">
      <div className="salesSummaryHeaderBar" aria-label="Item logs">
        <div className="salesSummaryHeaderTitle">Item logs</div>
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
              value={transactionType}
              onChange={(e) => setTransactionType(e.target.value)}
              aria-label="Transaction type filter"
              disabled={isLoading}
            >
              <option value="all">All transactions</option>
              <option value="create">Create</option>
              <option value="edit">Edit</option>
              <option value="delete">Delete</option>
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={itemId}
              onChange={(e) => setItemId(e.target.value)}
              aria-label="Item filter"
              disabled={isLoading}
            >
              <option value="all">All items</option>
              {itemOptions.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              aria-label="User filter"
              disabled={isLoading}
            >
              <option value="all">All users</option>
              {userOptions.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.label}
                </option>
              ))}
            </select>
          </div>

          <div className="salesSummaryFilterGroup">
            <select
              className="select"
              value={storeId}
              onChange={(e) => setStoreId(e.target.value)}
              aria-label="Store filter"
              disabled={isLoading || isStoresLoading || !canPickStore}
            >
              {canPickStore ? <option value="">All stores</option> : null}
              {!canPickStore && !storeId ? <option value="">No store assigned</option> : null}
              {visibleStoreOptions.map((store) => (
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

      <div className="receiptsReportContent">
        <div className="receiptsReportMain">
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
              <table className="table receiptsTable" aria-label="Item logs table">
                <thead>
                  <tr>
                    <th className="colName">Item</th>
                    <th className="receiptsColDate">Transaction date</th>
                    <th className="receiptsColType">Type</th>
                    <th className="colStock">Quantity</th>
                    <th className="receiptsColEmployee">User</th>
                    <th className="colStore">Store</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="usersEmpty">
                        {isLoading ? "Loading..." : "No item logs found."}
                      </td>
                    </tr>
                  ) : (
                    rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`receiptsRow ${selected?.id === row.id ? "receiptsRowActive" : ""}`}
                        onClick={() => setSelected(row)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") setSelected(row);
                        }}
                      >
                        <td className="colName">{row.itemName || row.itemId || row.id}</td>
                        <td className="receiptsColDate">{formatLogDate(row.transactionDate)}</td>
                        <td className="receiptsColType">{row.transactionTypeLabel}</td>
                        <td className="colStock">{formatQuantity(row.quantity)}</td>
                        <td className="receiptsColEmployee">{row.userName || "--"}</td>
                        <td className="colStore">{row.storeLabel || "--"}</td>
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
                  disabled={!hasPrev || isLoading}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={!hasNext || isLoading}
                  onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
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
                  <option value="500">500</option>
                  <option value="1000">1000</option>
                  <option value="1500">1500</option>
                </select>
              </div>
            </div>
          </div>
        </div>

        <aside className={`receiptsReportDrawer ${selected ? "receiptsReportDrawerOpen" : ""}`}>
          {selected ? (
            <div className="receiptsDrawerBody" role="dialog" aria-label="Item log details">
              <div className="receiptsDrawerTop">
                <button
                  className="receiptsDrawerClose"
                  type="button"
                  aria-label="Close details"
                  onClick={() => setSelected(null)}
                >
                  &times;
                </button>
              </div>

              <div className="receiptsDrawerTotal">{selected.transactionTypeLabel}</div>
              <div className="receiptsDrawerTotalLabel">Transaction type</div>
              <div className="receiptsDrawerDivider" aria-hidden="true" />

              <div className="receiptsDrawerMeta">
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemName || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Item ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.itemId || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Quantity</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatQuantity(selected.quantity)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">User</span>
                  <span className="receiptsDrawerMetaValue">{selected.userName || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">User ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.userId || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Store</span>
                  <span className="receiptsDrawerMetaValue">{selected.storeLabel || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Transaction date</span>
                  <span className="receiptsDrawerMetaValue">
                    {formatLogDate(selected.transactionDate)}
                  </span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Log ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.id}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">Select an item log to view details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
