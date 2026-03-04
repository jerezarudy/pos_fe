import { useEffect, useMemo, useState } from "react";
import {
  buildQueryString,
  compareValues,
  getFetchCredentials,
  makeId,
  parsePagedResponse,
  toPositiveInt,
  readLocalStorage,
  safeParseList,
  writeLocalStorage,
} from "../utils/common.js";

const STORAGE_KEY = "pos.stores.v1";

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
    (apiStore.name ? `name:${apiStore.name}` : null) ??
    makeId("s");

  const country =
    typeof apiStore.country === "string" && apiStore.country.trim()
      ? apiStore.country.trim()
      : "Philippines";

  return {
    id: String(id),
    ownerId: apiStore.ownerId ?? apiStore.owner_id ?? apiStore.owner ?? "",
    name: apiStore.name ?? "",
    address: apiStore.address ?? "",
    city: apiStore.city ?? "",
    province: apiStore.province ?? "",
    postalCode: apiStore.postalCode ?? apiStore.postal_code ?? "",
    country,
    phone: apiStore.phone ?? "",
    description: apiStore.description ?? "",
  };
}

export default function StoresPage({
  apiBaseUrl,
  authToken,
  authUser,
  searchQuery,
}) {
  const [stores, setStores] = useState(() => {
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

  const [ownerId, setOwnerId] = useState("");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Philippines");
  const [phone, setPhone] = useState("");
  const [description, setDescription] = useState("");

  function getAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (authToken) {
      headers.Authorization = `Bearer ${authToken}`;
    }
    return headers;
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

  useEffect(() => {
    writeLocalStorage(STORAGE_KEY, JSON.stringify(stores));
  }, [stores]);

  useEffect(() => {
    if (page !== 1) setPage(1);
    if (pageInput !== "1") setPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  async function reloadStores() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        search: (searchQuery || "").trim() || undefined,
      });
      const payload = await apiRequest(`/stores${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiStores = extractStoresList({ ...payload, data: paged.data });
      setStores(apiStores.map(toUiStore).filter(Boolean));
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load stores.");
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
        const payload = await apiRequest(`/stores${qs}`);
        const paged = parsePagedResponse(payload, { page, limit });
        const apiStores = extractStoresList({ ...payload, data: paged.data });
        const uiStores = apiStores.map(toUiStore).filter(Boolean);
        if (!cancelled) {
          setStores(uiStores);
          setTotal(paged.total ?? null);
          setHasNext(Boolean(paged.hasNext));
          setHasPrev(Boolean(paged.hasPrev));
          setPageInput(String(page));
        }
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load stores.");
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

  const editingStore = useMemo(() => {
    if (!editingId) return null;
    return stores.find((s) => s.id === editingId) || null;
  }, [editingId, stores]);

  useEffect(() => {
    if (!editingStore) {
      setOwnerId("");
      setName("");
      setAddress("");
      setCity("");
      setProvince("");
      setPostalCode("");
      setCountry("Philippines");
      setPhone("");
      setDescription("");
      return;
    }
    setOwnerId(editingStore.ownerId || "");
    setName(editingStore.name || "");
    setAddress(editingStore.address || "");
    setCity(editingStore.city || "");
    setProvince(editingStore.province || "");
    setPostalCode(editingStore.postalCode || "");
    setCountry(editingStore.country || "Philippines");
    setPhone(editingStore.phone || "");
    setDescription(editingStore.description || "");
  }, [editingStore]);

  useEffect(() => {
    if (!authUser) return;
    if (editingId) return;
    if (ownerId.trim()) return;
    const id =
      authUser?.id ?? authUser?._id ?? authUser?.userId ?? authUser?.uuid ?? "";
    if (id) setOwnerId(String(id));
  }, [authUser, editingId, ownerId]);

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

  const filteredStores = useMemo(() => {
    const q = (searchQuery || "").trim().toLowerCase();
    if (!q) return stores;
    return stores.filter((s) => {
      const haystack =
        `${s?.name ?? ""} ${s?.address ?? ""} ${s?.city ?? ""} ${s?.province ?? ""} ` +
        `${s?.postalCode ?? ""} ${s?.country ?? ""} ${s?.phone ?? ""}`;
      return haystack.toLowerCase().includes(q);
    });
  }, [searchQuery, stores]);

  const sortedStores = useMemo(() => {
    const factor = sort.direction === "asc" ? 1 : -1;

    return [...filteredStores].sort((a, b) => {
      const primary = compareValues(a?.[sort.key], b?.[sort.key]);
      if (primary !== 0) return primary * factor;
      return compareValues(a?.id, b?.id);
    });
  }, [filteredStores, sort.direction, sort.key]);

  function resetForm() {
    setEditingId(null);
    setError("");
    setName("");
    setAddress("");
    setCity("");
    setProvince("");
    setPostalCode("");
    setCountry("Philippines");
    setPhone("");
    setDescription("");
  }

  function validateForm() {
    if (!ownerId.trim()) return "Owner is required.";
    if (!name.trim()) return "Name is required.";
    return "";
  }

  async function upsertStore() {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      const payload = {
        ownerId: ownerId.trim(),
        name: name.trim(),
        address: address.trim(),
        city: city.trim(),
        province: province.trim(),
        postalCode: postalCode.trim(),
        country: (country || "Philippines").trim(),
        phone: phone.trim(),
        description: description.trim(),
      };

      if (editingId) {
        await apiRequest(`/stores/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/stores", { method: "POST", body: payload });
      }

      await reloadStores();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save store.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteStore(store) {
    const label = store?.name || "this store";
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/stores/${encodeURIComponent(store.id)}`, {
        method: "DELETE",
      });
      await reloadStores();
      if (editingId === store.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete store.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Stores</h1>
        <div className="pageSubtitle">Create, edit, and remove stores</div>
      </div>

      <div className="grid">
        <section
          className="card"
          aria-label={editingId ? "Edit store" : "Create store"}
        >
          <div className="cardHeader">
            <div className="cardTitle">
              {editingId ? "Edit store" : "Create store"}
            </div>
            <div className="cardSubtitle">
              Owner: {authUser?.email ? String(authUser.email) : "ID required"}
            </div>
          </div>

          <div className="createItemBody">
            <label className="field createItemField">
              <div className="fieldLabel">Name</div>
              <input
                className="textInput"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Store name"
              />
            </label>

            <label className="field createItemField">
              <div className="fieldLabel">Address</div>
              <input
                className="textInput"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Address"
              />
            </label>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">City</div>
                <input
                  className="textInput"
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                />
              </label>
              <label className="field createItemField">
                <div className="fieldLabel">Province</div>
                <input
                  className="textInput"
                  type="text"
                  value={province}
                  onChange={(e) => setProvince(e.target.value)}
                  placeholder="Province"
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Postal code</div>
                <input
                  className="textInput"
                  type="text"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="Postal code"
                />
              </label>
              <label className="field createItemField">
                <div className="fieldLabel">Country</div>
                <input
                  className="textInput"
                  type="text"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  placeholder="Philippines"
                />
              </label>
            </div>

            <label className="field createItemField">
              <div className="fieldLabel">Phone</div>
              <input
                className="textInput"
                type="text"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone"
              />
            </label>

            <label className="field createItemField">
              <div className="fieldLabel">Description</div>
              <textarea
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                rows={3}
              />
            </label>

            {error ? <div className="authError">{error}</div> : null}
          </div>

          <div className="cardActions">
            {editingId ? (
              <button
                className="btn btnGhost"
                type="button"
                onClick={resetForm}
              >
                Cancel
              </button>
            ) : null}
            <button
              className="btn btnPrimary"
              type="button"
              onClick={upsertStore}
              disabled={isSaving}
            >
              {editingId ? "Save changes" : "Create store"}
            </button>
          </div>
        </section>

        <section className="card" aria-label="Stores list">
          <div className="cardHeader">
            <div className="cardTitle">Stores</div>
            <div className="cardSubtitle">
              {sortedStores.length} store{sortedStores.length === 1 ? "" : "s"}
              {searchQuery ? ` (filtered by “${searchQuery}”)` : ""}
              {isLoading ? " • Loading…" : ""}
            </div>
          </div>

          <div className="tableWrap">
            <table className="table" aria-label="Stores table">
              <thead>
                <tr>
                  <th className="colName" aria-sort={ariaSort("name")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("name")}
                    >
                      Name{" "}
                      <span className="sortArrow">{sortArrow("name")}</span>
                    </button>
                  </th>
                  <th className="colCity" aria-sort={ariaSort("city")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("city")}
                    >
                      City{" "}
                      <span className="sortArrow">{sortArrow("city")}</span>
                    </button>
                  </th>
                  <th className="colProvince" aria-sort={ariaSort("province")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("province")}
                    >
                      Province{" "}
                      <span className="sortArrow">{sortArrow("province")}</span>
                    </button>
                  </th>
                  <th className="colCountry" aria-sort={ariaSort("country")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("country")}
                    >
                      Country{" "}
                      <span className="sortArrow">{sortArrow("country")}</span>
                    </button>
                  </th>
                  <th className="colPhone" aria-sort={ariaSort("phone")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("phone")}
                    >
                      Phone{" "}
                      <span className="sortArrow">{sortArrow("phone")}</span>
                    </button>
                  </th>
                  <th className="colActions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedStores.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="usersEmpty">
                      No stores yet. Create one on the left.
                    </td>
                  </tr>
                ) : (
                  sortedStores.map((s) => {
                    const isEditing = editingId === s.id;
                    return (
                      <tr key={s.id} aria-selected={isEditing || undefined}>
                        <td className="colName">{s.name}</td>
                        <td className="colCity">{s.city || "—"}</td>
                        <td className="colProvince">{s.province || "—"}</td>
                        <td className="colCountry">{s.country || "—"}</td>
                        <td className="colPhone">{s.phone || "—"}</td>
                        <td className="colActions">
                          <div className="usersActions">
                            <button
                              className="btn btnGhost btnSmall"
                              type="button"
                              onClick={() => {
                                setError("");
                                setEditingId(s.id);
                              }}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btnGhost btnSmall btnDanger"
                              type="button"
                              onClick={() => deleteStore(s)}
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
              onClick={reloadStores}
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
                  const clamped = totalPages
                    ? Math.min(next, totalPages)
                    : next;
                  setPage(clamped);
                }}
                onBlur={() => {
                  const next = toPositiveInt(pageInput, page);
                  const clamped = totalPages
                    ? Math.min(next, totalPages)
                    : next;
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
