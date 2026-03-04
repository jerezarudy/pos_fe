import { useEffect, useMemo, useState } from "react";
import {
  buildQueryString,
  compareValues,
  getActorHeaders,
  getFetchCredentials,
  parsePagedResponse,
  toPositiveInt,
  readLocalStorage,
  safeParseList,
  writeLocalStorage,
} from "../utils/common.js";

const STORAGE_KEY = "pos.discounts.v1";

const moneyFormatter = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatDiscountValue(discount) {
  const raw = discount?.value;
  if (raw == null || raw === "") return "—";
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return "—";

  if (discount?.type === "amount") return moneyFormatter.format(value);
  return `${value}%`;
}

function extractDiscountsList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.discounts)) return payload.discounts;
  if (Array.isArray(payload?.data?.discounts)) return payload.data.discounts;
  return [];
}

function toUiDiscount(apiDiscount) {
  if (!apiDiscount || typeof apiDiscount !== "object") return null;

  const id =
    apiDiscount.id ??
    apiDiscount._id ??
    apiDiscount.discountId ??
    apiDiscount.uuid ??
    (apiDiscount.name ? `name:${apiDiscount.name}` : null);
  if (!id) return null;

  const typeRaw = apiDiscount.type ?? apiDiscount.discountType ?? apiDiscount.kind ?? "percentage";
  const type = String(typeRaw).toLowerCase() === "amount" ? "amount" : "percentage";
  const value = apiDiscount.value ?? apiDiscount.amount ?? apiDiscount.percent ?? null;

  return {
    id: String(id),
    name: String(apiDiscount.name ?? ""),
    type,
    value: value == null || value === "" ? null : Number(value),
    restrictedAccess: Boolean(apiDiscount.restrictedAccess ?? apiDiscount.restricted_access),
  };
}

export default function DiscountsPage({ apiBaseUrl, authToken, authUser, searchQuery }) {
  const [discounts, setDiscounts] = useState(() => {
    return safeParseList(readLocalStorage(STORAGE_KEY, ""));
  });
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : null;
  const [pageInput, setPageInput] = useState("1");

  const [sort, setSort] = useState({ key: "name", direction: "asc" });

  const [name, setName] = useState("");
  const [type, setType] = useState("percentage"); // percentage | amount
  const [value, setValue] = useState("");
  const [restrictedAccess, setRestrictedAccess] = useState(false);

  useEffect(() => {
    writeLocalStorage(STORAGE_KEY, JSON.stringify(discounts));
  }, [discounts]);

  useEffect(() => {
    if (page !== 1) setPage(1);
    if (pageInput !== "1") setPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  function getAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return { ...headers, ...getActorHeaders(authUser) };
  }

  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  async function apiRequest(path, { method = "GET", body } = {}) {
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: getFetchCredentials(),
      headers: getAuthHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });

    const payload = await readJsonSafely(response);
    if (!response.ok) {
      const apiMessage =
        (payload && (payload.message || payload.error)) ||
        `Request failed (HTTP ${response.status}).`;
      throw new Error(String(apiMessage));
    }
    return payload;
  }

  async function reloadDiscounts() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        search: (searchQuery || "").trim() || undefined,
      });
      const payload = await apiRequest(`/discounts${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiDiscounts = extractDiscountsList({ ...payload, data: paged.data });
      setDiscounts(apiDiscounts.map(toUiDiscount).filter(Boolean));
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load discounts.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    let cancelled = false;

    async function load() {
      setIsLoading(true);
      setError("");
      try {
        const qs = buildQueryString({
          page,
          limit,
          search: (searchQuery || "").trim() || undefined,
        });
        const payload = await apiRequest(`/discounts${qs}`);
        const paged = parsePagedResponse(payload, { page, limit });
        const apiDiscounts = extractDiscountsList({ ...payload, data: paged.data });
        const uiDiscounts = apiDiscounts.map(toUiDiscount).filter(Boolean);
        if (!cancelled) {
          setDiscounts(uiDiscounts);
          setTotal(paged.total ?? null);
          setHasNext(Boolean(paged.hasNext));
          setHasPrev(Boolean(paged.hasPrev));
          setPageInput(String(page));
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load discounts.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, limit, page, searchQuery]);

  function toggleSort(key) {
    setSort((prev) => {
      if (prev.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" };
      }
      return { key, direction: "asc" };
    });
  }

  function sortArrow(key) {
    if (sort.key !== key) return null;
    return sort.direction === "asc" ? "↑" : "↓";
  }

  function ariaSort(key) {
    if (sort.key !== key) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  const filteredDiscounts = useMemo(() => {
    const q = (searchQuery || "").trim().toLowerCase();
    if (!q) return discounts;
    return discounts.filter((d) => {
      const haystack = `${d?.name ?? ""} ${d?.type ?? ""}`.trim().toLowerCase();
      return haystack.includes(q);
    });
  }, [discounts, searchQuery]);

  const sortedDiscounts = useMemo(() => {
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...filteredDiscounts].sort((a, b) => {
      const aValue = sort.key === "value" ? Number(a?.value) : a?.[sort.key];
      const bValue = sort.key === "value" ? Number(b?.value) : b?.[sort.key];
      const primary = compareValues(aValue, bValue);
      if (primary !== 0) return primary * factor;
      return compareValues(a?.id, b?.id);
    });
  }, [filteredDiscounts, sort.direction, sort.key]);

  function resetForm() {
    setEditingId(null);
    setError("");
    setName("");
    setType("percentage");
    setValue("");
    setRestrictedAccess(false);
  }

  function validateForm() {
    const trimmedName = name.trim();
    if (!trimmedName) return "Name is required.";

    const duplicate = discounts.some(
      (d) =>
        d.id !== editingId &&
        String(d.name || "").trim().toLowerCase() === trimmedName.toLowerCase(),
    );
    if (duplicate) return "A discount with this name already exists.";

    if (value !== "") {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)) return "Value must be a number.";
      if (numberValue < 0) return "Value must be 0 or higher.";
      if (type === "percentage" && numberValue > 100) return "Percentage must be 100 or less.";
    }

    if (type !== "percentage" && type !== "amount") return "Type is invalid.";
    return "";
  }

  async function upsertDiscount() {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedName = name.trim();
    const parsedValue = value === "" ? null : Number(value);

    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      const payload = {
        name: trimmedName,
        type,
        value: parsedValue,
        restrictedAccess: Boolean(restrictedAccess),
      };

      if (editingId) {
        await apiRequest(`/discounts/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/discounts", { method: "POST", body: payload });
      }

      await reloadDiscounts();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save discount.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteDiscount(discount) {
    const label = discount?.name || "this discount";
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;

    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/discounts/${encodeURIComponent(discount.id)}`, { method: "DELETE" });
      await reloadDiscounts();
      if (editingId === discount.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete discount.");
    } finally {
      setIsSaving(false);
    }
  }

  function beginEdit(discount) {
    setError("");
    setEditingId(discount.id);
    setName(discount.name || "");
    setType(discount.type === "amount" ? "amount" : "percentage");
    setValue(discount.value == null || discount.value === "" ? "" : String(discount.value));
    setRestrictedAccess(Boolean(discount.restrictedAccess));
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Discounts</h1>
        <div className="pageSubtitle">Create percentage or amount discounts</div>
      </div>

      <div className="grid">
        <section className="card" aria-label={editingId ? "Edit discount" : "Create discount"}>
          <div className="cardHeader">
            <div className="cardTitle">{editingId ? "Edit discount" : "Create discount"}</div>
            <div className="cardSubtitle">Name, type, value, and restricted access</div>
          </div>

          <div className="createItemBody">
            <label className="field createItemField">
              <div className="fieldLabel">Name</div>
              <input
                className="textInput"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Discount name"
              />
            </label>

            <div className="createItemSoldBy" aria-label="Type">
              <div className="fieldLabel">Type</div>
              <label className="radio">
                <input
                  type="radio"
                  name="discountType"
                  value="percentage"
                  checked={type === "percentage"}
                  onChange={(e) => setType(e.target.value)}
                />
                <span>Percentage</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="discountType"
                  value="amount"
                  checked={type === "amount"}
                  onChange={(e) => setType(e.target.value)}
                />
                <span>Amount</span>
              </label>
            </div>

            <label className="field createItemField">
              <div className="fieldLabel">Value</div>
              <input
                className="textInput"
                inputMode="decimal"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={type === "amount" ? "0.00" : "0"}
              />
              <div className="rowSubtitle">
                To indicate the value upon sale, leave the field blank.
              </div>
            </label>

            <div className="row" aria-label="Restricted access">
              <div className="rowMain">
                <div className="rowTitle">Restricted access</div>
                <div className="rowSubtitle">
                  Only employees with appropriate access can apply this discount.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={restrictedAccess}
                  onChange={(e) => setRestrictedAccess(e.target.checked)}
                />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>

            {error ? <div className="authError">{error}</div> : null}
          </div>

          <div className="cardActions">
            {editingId ? (
              <button className="btn btnGhost" type="button" onClick={resetForm}>
                Cancel
              </button>
            ) : null}
            <button
              className="btn btnPrimary"
              type="button"
              onClick={upsertDiscount}
              disabled={isSaving}
            >
              Save
            </button>
          </div>
        </section>

        <section className="card" aria-label="Discounts list">
          <div className="cardHeader">
            <div className="cardTitle">Discounts</div>
            <div className="cardSubtitle">
              {sortedDiscounts.length} discount{sortedDiscounts.length === 1 ? "" : "s"}
              {searchQuery ? ` (filtered by “${searchQuery}”)` : ""}
              {isLoading ? " • Loading…" : ""}
            </div>
          </div>

          <div className="tableWrap">
            <table className="table" aria-label="Discounts table">
              <thead>
                <tr>
                  <th className="colName" aria-sort={ariaSort("name")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("name")}
                    >
                      Name <span className="sortArrow">{sortArrow("name")}</span>
                    </button>
                  </th>
                  <th className="colType" aria-sort={ariaSort("type")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("type")}
                    >
                      Type <span className="sortArrow">{sortArrow("type")}</span>
                    </button>
                  </th>
                  <th className="colMoney" aria-sort={ariaSort("value")}>
                    <button
                      type="button"
                      className="thSortBtn thSortBtnRight"
                      onClick={() => toggleSort("value")}
                    >
                      Value <span className="sortArrow">{sortArrow("value")}</span>
                    </button>
                  </th>
                  <th className="colRestricted" aria-sort={ariaSort("restrictedAccess")}>
                    <button
                      type="button"
                      className="thSortBtn thSortBtnRight"
                      onClick={() => toggleSort("restrictedAccess")}
                    >
                      Restricted{" "}
                      <span className="sortArrow">{sortArrow("restrictedAccess")}</span>
                    </button>
                  </th>
                  <th className="colActions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedDiscounts.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="usersEmpty">
                      No discounts yet. Create one on the left.
                    </td>
                  </tr>
                ) : (
                  sortedDiscounts.map((d) => {
                    const isEditing = editingId === d.id;
                    return (
                      <tr key={d.id} aria-selected={isEditing || undefined}>
                        <td className="colName">{d.name}</td>
                        <td className="colType">
                          <span className="cellSelect">{d.type}</span>
                        </td>
                        <td className="colMoney">{formatDiscountValue(d)}</td>
                        <td className="colRestricted">{d.restrictedAccess ? "Yes" : "No"}</td>
                        <td className="colActions">
                          <div className="usersActions">
                            <button
                              className="btn btnGhost btnSmall"
                              type="button"
                              onClick={() => beginEdit(d)}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btnGhost btnSmall btnDanger"
                              type="button"
                              onClick={() => deleteDiscount(d)}
                              disabled={isSaving}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="cardActions">
            <button className="btn btnGhost" type="button" onClick={resetForm}>
              Clear form
            </button>
            <button
              className="btn btnGhost"
              type="button"
              onClick={reloadDiscounts}
              disabled={isLoading || isSaving}
            >
              Refresh
            </button>
          </div>

          <div className="itemListFooter" aria-label="Pagination">
            <div className="pagerButtons" aria-label="Page controls">
              <button
                className="pagerBtn"
                type="button"
                aria-label="Previous page"
                disabled={!hasPrev || page <= 1 || isLoading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ‹
              </button>
              <button
                className="pagerBtn"
                type="button"
                aria-label="Next page"
                disabled={!hasNext || isLoading}
                onClick={() => setPage((p) => p + 1)}
              >
                ›
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
                  const clamped = totalPages ? Math.min(next, totalPages) : next;
                  setPage(clamped);
                }}
                onBlur={() => {
                  const next = toPositiveInt(pageInput, page);
                  const clamped = totalPages ? Math.min(next, totalPages) : next;
                  setPageInput(String(clamped));
                  setPage(clamped);
                }}
                aria-label="Page number"
              />
              <span>of {totalPages ?? "—"}</span>
            </div>

            <div className="pagerMeta">
              <span>Rows per page:</span>
              <select
                className="select selectSmall"
                value={String(limit)}
                onChange={(e) => {
                  const nextLimit = toPositiveInt(e.target.value, limit);
                  setLimit(nextLimit);
                  setPageInput("1");
                  setPage(1);
                }}
                aria-label="Rows per page"
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
              </select>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
