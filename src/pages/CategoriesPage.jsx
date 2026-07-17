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

const STORAGE_KEY = "pos.categories.v1";

function extractCategoriesList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.categories)) return payload.categories;
  if (Array.isArray(payload?.data?.categories)) return payload.data.categories;
  return [];
}

function toUiCategory(apiCategory) {
  if (!apiCategory || typeof apiCategory !== "object") return null;
  const id =
    apiCategory.id ??
    apiCategory._id ??
    apiCategory.categoryId ??
    apiCategory.uuid ??
    (apiCategory.name ? `name:${apiCategory.name}` : null);
  if (!id) return null;
  return { id: String(id), name: String(apiCategory.name ?? "") };
}

export default function CategoriesPage({ apiBaseUrl, authToken, authUser, searchQuery }) {
  const [categories, setCategories] = useState(() => {
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

  useEffect(() => {
    writeLocalStorage(STORAGE_KEY, JSON.stringify(categories));
  }, [categories]);

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

  async function reloadCategories() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        search: (searchQuery || "").trim() || undefined,
      });
      const payload = await apiRequest(`/categories${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiCategories = extractCategoriesList({ ...payload, data: paged.data });
      setCategories(apiCategories.map(toUiCategory).filter(Boolean));
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load categories.");
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
        const payload = await apiRequest(`/categories${qs}`);
        const paged = parsePagedResponse(payload, { page, limit });
        const apiCategories = extractCategoriesList({ ...payload, data: paged.data });
        const uiCategories = apiCategories.map(toUiCategory).filter(Boolean);
        if (!cancelled) {
          setCategories(uiCategories);
          setTotal(paged.total ?? null);
          setHasNext(Boolean(paged.hasNext));
          setHasPrev(Boolean(paged.hasPrev));
          setPageInput(String(page));
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load categories.");
        }
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

  const filteredCategories = useMemo(() => {
    const q = (searchQuery || "").trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) =>
      String(c?.name ?? "").toLowerCase().includes(q),
    );
  }, [categories, searchQuery]);

  const sortedCategories = useMemo(() => {
    const factor = sort.direction === "asc" ? 1 : -1;
    return [...filteredCategories].sort((a, b) => {
      const primary = compareValues(a?.[sort.key], b?.[sort.key]);
      if (primary !== 0) return primary * factor;
      return compareValues(a?.id, b?.id);
    });
  }, [filteredCategories, sort.direction, sort.key]);

  function resetForm() {
    setEditingId(null);
    setError("");
    setName("");
  }

  function beginEdit(category) {
    setError("");
    setEditingId(category.id);
    setName(category.name || "");
  }

  function validateForm() {
    const trimmedName = name.trim();
    if (!trimmedName) return "Name is required.";
    return "";
  }

  async function upsertCategory() {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }

    const trimmedName = name.trim();
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      const payload = { name: trimmedName };
      if (editingId) {
        await apiRequest(`/categories/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/categories", { method: "POST", body: payload });
      }

      await reloadCategories();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save category.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteCategory(category) {
    const label = category?.name || "this category";
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/categories/${encodeURIComponent(category.id)}`, { method: "DELETE" });
      await reloadCategories();
      if (editingId === category.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete category.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Categories</h1>
        <div className="pageSubtitle">Manage item categories</div>
      </div>

      <div className="grid">
        <section className="card" aria-label={editingId ? "Edit category" : "Create category"}>
          <div className="cardHeader">
            <div className="cardTitle">{editingId ? "Edit category" : "Create category"}</div>
            <div className="cardSubtitle">Name only</div>
          </div>

          <div className="createItemBody">
            <label className="field createItemField">
              <div className="fieldLabel">Name</div>
              <input
                className="textInput"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Category name"
              />
            </label>

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
              onClick={upsertCategory}
              disabled={isSaving}
            >
              {editingId ? "Save changes" : "Create category"}
            </button>
          </div>
        </section>

        <section className="card" aria-label="Categories list">
          <div className="cardHeader">
            <div className="cardTitle">Categories</div>
            <div className="cardSubtitle">
              {sortedCategories.length} categor{sortedCategories.length === 1 ? "y" : "ies"}
              {searchQuery ? ` (filtered by “${searchQuery}”)` : ""}
              {isLoading ? " • Loading…" : ""}
            </div>
          </div>

          <div className="tableWrap">
            <table className="table" aria-label="Categories table">
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
                  <th className="colActions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedCategories.length === 0 ? (
                  <tr>
                    <td colSpan={2} className="usersEmpty">
                      No categories yet. Create one on the left.
                    </td>
                  </tr>
                ) : (
                  sortedCategories.map((c) => {
                    const isEditing = editingId === c.id;
                    return (
                      <tr key={c.id} aria-selected={isEditing || undefined}>
                        <td className="colName">{c.name}</td>
                        <td className="colActions">
                          <div className="usersActions">
                            <button
                              className="btn btnGhost btnSmall"
                              type="button"
                              onClick={() => {
                                beginEdit(c);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btnGhost btnSmall btnDanger"
                              type="button"
                              onClick={() => deleteCategory(c)}
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
              onClick={reloadCategories}
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
