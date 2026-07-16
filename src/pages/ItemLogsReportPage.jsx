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

const ITEM_LOG_ENDPOINTS = ["/audit-logs/items", "/audit-logs/items/crud", "/items/audit-logs"];

function formatIsoDateInput(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dateFromIsoDateInput(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
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
  return start <= end ? { start, end } : { start: end, end: start };
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
    return String(
      value.name ?? value.fullName ?? value.email ?? value.label ?? value.title ?? value.id ?? "",
    ).trim();
  }
  return String(value).trim();
}

function readPath(source, path) {
  let current = source;
  for (const key of String(path || "").split(".")) {
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

function parsePagedResponse(payload, fallbacks = {}) {
  const root = payload && typeof payload === "object" ? payload : {};
  const nested =
    root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data : {};
  const page = toPositiveInt(root.page ?? nested.page, fallbacks.page ?? 1);
  const limit = toPositiveInt(root.limit ?? nested.limit, fallbacks.limit ?? 20);
  const total = toNonNegativeInt(root.total ?? nested.total, fallbacks.total ?? null);
  const hasNext =
    typeof (root.hasNext ?? nested.hasNext) === "boolean"
      ? Boolean(root.hasNext ?? nested.hasNext)
      : typeof (root.has_next ?? nested.has_next) === "boolean"
        ? Boolean(root.has_next ?? nested.has_next)
        : total != null
          ? page * limit < total
          : fallbacks.hasNext ?? false;
  return { data: extractLogsList(payload), page, limit, total, hasNext };
}

function normalizeItemLogAction(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (value.includes("delete") || value.includes("remove")) return "deleted";
  if (value.includes("create") || value.includes("add")) return "created";
  if (value.includes("update") || value.includes("edit") || value.includes("patch")) return "updated";
  return "";
}

function formatAction(action) {
  if (action === "created") return "Created";
  if (action === "deleted") return "Deleted";
  if (action === "updated") return "Updated";
  return "--";
}

function normalizeItemLog(raw) {
  if (!raw || typeof raw !== "object") return null;

  const id = firstValue(raw, ["id", "_id", "auditId", "audit_id", "logId", "log_id"]);
  if (!id) return null;

  const rawAction = firstValue(raw, [
    "itemAction",
    "item_action",
    "action",
    "event",
    "type",
    "operation",
    "method",
  ]);
  const action = normalizeItemLogAction(rawAction);
  if (!action) return null;

  const rawActionText = String(rawAction || "").toLowerCase();
  if (rawActionText.includes("stock") || rawActionText.includes("transfer")) return null;

  const itemId = firstValue(raw, [
    "itemId",
    "item_id",
    "resourceId",
    "resource_id",
    "item.id",
    "item._id",
    "entity.id",
    "entity._id",
    "metadata.itemId",
    "metadata.item_id",
  ]);
  const itemName =
    readText(
      firstValue(raw, [
        "itemName",
        "item_name",
        "resourceName",
        "resource_name",
        "item.name",
        "entity.name",
        "metadata.itemName",
        "metadata.item_name",
      ]),
    ) || (itemId ? String(itemId) : "");

  const userId = firstValue(raw, [
    "userId",
    "user_id",
    "actorId",
    "actor_id",
    "user.id",
    "user._id",
    "actor.id",
    "actor._id",
    "metadata.userId",
    "metadata.user_id",
  ]);
  const userName =
    readText(
      firstValue(raw, [
        "userName",
        "user_name",
        "actorName",
        "actor_name",
        "user.name",
        "user.fullName",
        "actor.name",
        "actor.fullName",
        "user.email",
        "actor.email",
      ]),
    ) || (userId ? String(userId) : "");

  const storeId = firstValue(raw, [
    "storeId",
    "store_id",
    "store.id",
    "store._id",
    "item.storeId",
    "item.store_id",
    "item.store.id",
    "item.store._id",
    "entity.storeId",
    "entity.store_id",
    "entity.store.id",
    "entity.store._id",
    "metadata.storeId",
    "metadata.store_id",
  ]);
  const storeName =
    readText(
      firstValue(raw, [
        "storeName",
        "store_name",
        "store.name",
        "store.label",
        "item.storeName",
        "item.store_name",
        "item.store.name",
        "item.store.label",
        "entity.storeName",
        "entity.store_name",
        "entity.store.name",
        "entity.store.label",
        "metadata.storeName",
        "metadata.store_name",
      ]),
    ) || (storeId ? String(storeId) : "");

  return {
    id: String(id),
    itemId: itemId == null ? "" : String(itemId),
    itemName: itemName || "--",
    userId: userId == null ? "" : String(userId),
    userName: userName || "--",
    storeId: storeId == null ? "" : String(storeId),
    storeName: storeName || "",
    action,
    actionLabel: formatAction(action),
    date: firstValue(raw, ["createdAt", "created_at", "timestamp", "date", "loggedAt"]),
  };
}

function uniqOptions(list) {
  const map = new Map();
  for (const option of list || []) {
    if (!option?.id) continue;
    map.set(String(option.id), { id: String(option.id), label: String(option.label || option.id) });
  }
  return Array.from(map.values()).sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
  );
}

export default function ItemLogsReportPage({ apiBaseUrl, authToken, authUser }) {
  const authRole = useMemo(() => getAuthUserRole(authUser), [authUser]);
  const canPickStore = authRole === "admin" || authRole === "owner";
  const reportStoreId = useMemo(() => getReportStoreId(authUser), [authUser]);
  const todayKey = useMemo(() => formatIsoDateInput(new Date()), []);
  const [startDate, setStartDate] = useState(() => formatIsoDateInput(new Date()));
  const [endDate, setEndDate] = useState(() => formatIsoDateInput(new Date()));
  const [itemId, setItemId] = useState("all");
  const [userId, setUserId] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [storeId, setStoreId] = useState(() => reportStoreId);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(1000);

  const [logs, setLogs] = useState([]);
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
        const errorWithStatus = new Error(String(message));
        errorWithStatus.status = response.status;
        throw errorWithStatus;
      }
      return payload;
    },
    [apiBaseUrl, getAuthHeaders],
  );

  const { stores, isStoresLoading } = useStoresList({ apiBaseUrl, apiRequest });
  const storeOptions = useMemo(
    () => makeStoreOptions({ stores, activeStoreId: storeId }),
    [storeId, stores],
  );
  const storeNameById = useMemo(() => {
    const map = new Map();
    for (const store of storeOptions) map.set(String(store.id), String(store.name || store.id));
    return map;
  }, [storeOptions]);
  const visibleStoreOptions = useMemo(() => {
    if (canPickStore) return storeOptions;
    const active = String(storeId || "").trim();
    return active ? storeOptions.filter((store) => String(store.id) === active) : [];
  }, [canPickStore, storeId, storeOptions]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!canPickStore) setStoreId(reportStoreId);
  }, [canPickStore, reportStoreId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPage(1);
  }, [actionFilter, endDate, itemId, limit, startDate, storeId, userId]);

  useEffect(() => {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const clamped = clampDateRange({ start, end });
    if (!clamped.start || !clamped.end) return;

    const fetchId = ++lastFetchId.current;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoading(true);
    setError("");

    (async () => {
      let lastError = null;
      for (const endpoint of ITEM_LOG_ENDPOINTS) {
        try {
          const collected = [];
          const pageSize = 200;
          let currentPage = 1;
          for (let guard = 0; guard < 50; guard += 1) {
            const payload = await apiRequest(
              `${endpoint}${buildQueryString({
                from: formatIsoDateInput(clamped.start),
                to: formatIsoDateInput(clamped.end),
                page: currentPage,
                limit: pageSize,
                ...(storeId ? { storeId } : null),
              })}`,
            );
            const parsed = parsePagedResponse(payload, { page: currentPage, limit: pageSize });
            collected.push(...parsed.data.map(normalizeItemLog).filter(Boolean));
            if (!parsed.hasNext || parsed.data.length === 0) break;
            currentPage += 1;
          }
          if (fetchId !== lastFetchId.current) return;
          setLogs(collected);
          return;
        } catch (e) {
          lastError = e;
          if (![404, 405].includes(Number(e?.status))) break;
        }
      }

      if (fetchId !== lastFetchId.current) return;
      setError(lastError instanceof Error ? lastError.message : "Failed to load item logs.");
      setLogs([]);
    })().finally(() => {
      if (fetchId === lastFetchId.current) setIsLoading(false);
    });
  }, [apiRequest, endDate, startDate, storeId]);

  const itemOptions = useMemo(
    () => uniqOptions(logs.map((row) => ({ id: row.itemId || row.id, label: row.itemName }))),
    [logs],
  );
  const userOptions = useMemo(
    () => uniqOptions(logs.map((row) => ({ id: row.userId || row.id, label: row.userName }))),
    [logs],
  );

  const getStoreName = useCallback(
    (row) => row.storeName || storeNameById.get(String(row.storeId || "")) || row.storeId || "--",
    [storeNameById],
  );

  const filteredRows = useMemo(() => {
    return logs.filter((row) => {
      if (itemId !== "all" && row.itemId !== itemId) return false;
      if (userId !== "all" && row.userId !== userId) return false;
      if (actionFilter !== "all" && row.action !== actionFilter) return false;
      if (storeId && String(row.storeId || "") !== String(storeId)) return false;
      return true;
    });
  }, [actionFilter, itemId, logs, storeId, userId]);

  const total = filteredRows.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const rows = useMemo(() => {
    const start = (page - 1) * limit;
    return filteredRows.slice(start, start + limit);
  }, [filteredRows, limit, page]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (selected && !rows.some((row) => row.id === selected.id)) setSelected(null);
  }, [rows, selected]);

  const exportCsv = useCallback(() => {
    const csv = `${toCsv([
      ["Item", "Store", "User", "Action", "Date", "Item ID", "Store ID", "User ID", "Log ID"],
      ...rows.map((row) => [
        row.itemName,
        getStoreName(row),
        row.userName,
        row.actionLabel,
        row.date ? new Date(row.date).toISOString() : "",
        row.itemId,
        row.storeId,
        row.userId,
        row.id,
      ]),
    ])}\n`;
    downloadTextFile({
      filename: `item-logs_${startDate || "start"}_${endDate || "end"}.csv`,
      content: `\uFEFF${csv}`,
      mime: "text/csv;charset=utf-8",
    });
  }, [endDate, getStoreName, rows, startDate]);

  const rangeLabel = useMemo(() => {
    const clamped = clampDateRange({ start: new Date(startDate), end: new Date(endDate) });
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
                const clamped = clampDateRange({ start: new Date(startDate), end: new Date(endDate) });
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
            <button
              className="salesSummaryRangeBtn"
              type="button"
              aria-label="Next period"
              onClick={() => {
                const clamped = clampDateRange({ start: new Date(startDate), end: new Date(endDate) });
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
              value={actionFilter}
              onChange={(e) => setActionFilter(e.target.value)}
              aria-label="Action filter"
              disabled={isLoading}
            >
              <option value="all">All actions</option>
              <option value="created">Created</option>
              <option value="updated">Updated</option>
              <option value="deleted">Deleted</option>
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
                    <th className="receiptsColStore">Store</th>
                    <th className="receiptsColEmployee">User</th>
                    <th className="receiptsColType">Action</th>
                    <th className="receiptsColDate">Date / Time</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="usersEmpty">
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
                        <td className="receiptsColStore">{getStoreName(row)}</td>
                        <td className="receiptsColEmployee">{row.userName || "--"}</td>
                        <td className="receiptsColType">{row.actionLabel}</td>
                        <td className="receiptsColDate">{formatLogDate(row.date)}</td>
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
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  {"<"}
                </button>
                <button
                  className="pagerBtn"
                  type="button"
                  aria-label="Next page"
                  disabled={page >= totalPages || isLoading}
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
                  <option value="1000">1000</option>
                  <option value="1500">1500</option>
                  <option value="2000">2000</option>
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

              <div className="receiptsDrawerTotal">{selected.itemName || selected.itemId}</div>
              <div className="receiptsDrawerTotalLabel">{selected.actionLabel}</div>
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
                  <span className="receiptsDrawerMetaLabel">Store</span>
                  <span className="receiptsDrawerMetaValue">{getStoreName(selected)}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">User</span>
                  <span className="receiptsDrawerMetaValue">{selected.userName || "--"}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Action</span>
                  <span className="receiptsDrawerMetaValue">{selected.actionLabel}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Date / Time</span>
                  <span className="receiptsDrawerMetaValue">{formatLogDate(selected.date)}</span>
                </div>
                <div className="receiptsDrawerMetaRow">
                  <span className="receiptsDrawerMetaLabel">Log ID</span>
                  <span className="receiptsDrawerMetaValue">{selected.id}</span>
                </div>
              </div>
            </div>
          ) : (
            <div className="receiptsDrawerEmpty">Select an item log entry to view details.</div>
          )}
        </aside>
      </div>
    </div>
  );
}
