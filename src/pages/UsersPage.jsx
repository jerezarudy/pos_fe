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

const STORAGE_KEY = "pos.users.v1";
const STORES_STORAGE_KEY = "pos.stores.v1";
const USER_TYPES = ["admin", "owner", "employee", "cashier"];

function normalizeUserType(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const lowered = raw.toLowerCase();
  if (!lowered) return "employee";
  if (lowered === "store_owner" || lowered === "store-owner" || lowered === "store owner")
    return "owner";
  if (USER_TYPES.includes(lowered)) return lowered;
  return "employee";
}

function generatePosPin() {
  if (typeof crypto !== "undefined" && crypto?.getRandomValues) {
    const bytes = new Uint32Array(1);
    crypto.getRandomValues(bytes);
    const value = bytes[0] % 1000000;
    return String(value).padStart(6, "0");
  }
  const value = Math.floor(Math.random() * 1000000);
  return String(value).padStart(6, "0");
}

function extractUsersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.data)) return payload.data.data;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.users)) return payload.users;
  if (Array.isArray(payload?.data?.users)) return payload.data.users;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

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
    (apiStore.name ? `name:${apiStore.name}` : null);
  if (!id) return null;
  return { id: String(id), name: String(apiStore.name ?? "") };
}

function toUiUser(apiUser) {
  if (!apiUser || typeof apiUser !== "object") return null;

  const id =
    apiUser.id ??
    apiUser._id ??
    apiUser.userId ??
    apiUser.uuid ??
    (apiUser.email ? `email:${apiUser.email}` : null) ??
    makeId("u");

  const name =
    typeof apiUser.name === "string"
      ? apiUser.name
      : typeof apiUser.fullName === "string"
        ? apiUser.fullName
        : "";
  const email = typeof apiUser.email === "string" ? apiUser.email : "";
  const userType = normalizeUserType(apiUser.userType ?? apiUser.role ?? apiUser.type);
  const posPinRaw = apiUser.pos_pin ?? apiUser.posPin ?? apiUser.pin ?? "";
  const posPin = typeof posPinRaw === "string" || typeof posPinRaw === "number"
    ? String(posPinRaw)
    : "";
  const storeIdRaw =
    apiUser.storeId ??
    apiUser.store_id ??
    apiUser.assignedStoreId ??
    apiUser.assigned_store_id ??
    apiUser.store?.id ??
    apiUser.store?._id ??
    apiUser.store?.storeId ??
    "";
  const storeId =
    typeof storeIdRaw === "string" || typeof storeIdRaw === "number"
      ? String(storeIdRaw)
      : "";

  return {
    id: String(id),
    name,
    email,
    userType,
    posPin,
    storeId,
  };
}

export default function UsersPage({
  apiBaseUrl,
  authToken,
  currentRole = "employee",
  searchQuery,
}) {
  const [users, setUsers] = useState(() => {
    return safeParseList(readLocalStorage(STORAGE_KEY, ""));
  });
  const [stores, setStores] = useState(() => {
    return safeParseList(readLocalStorage(STORES_STORAGE_KEY, ""));
  });
  const [editingId, setEditingId] = useState(null);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isStoresLoading, setIsStoresLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(null);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const totalPages = total ? Math.max(1, Math.ceil(total / limit)) : null;
  const [pageInput, setPageInput] = useState("1");

  const [sort, setSort] = useState({ key: "name", direction: "asc" });

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [userType, setUserType] = useState("employee");
  const [password, setPassword] = useState("");
  const [posPin, setPosPin] = useState("");
  const [storeId, setStoreId] = useState("");

  const canManageUsers = currentRole === "admin" || currentRole === "owner";

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
    writeLocalStorage(STORAGE_KEY, JSON.stringify(users));
  }, [users]);

  useEffect(() => {
    writeLocalStorage(STORES_STORAGE_KEY, JSON.stringify(stores));
  }, [stores]);

  useEffect(() => {
    if (!apiBaseUrl) return;

    let cancelled = false;
    async function loadUsers() {
      setIsLoading(true);
      setError("");
      try {
        const qs = buildQueryString({
          page,
          limit,
          search: (searchQuery || "").trim() || undefined,
        });
        const payload = await apiRequest(`/users${qs}`);
        const paged = parsePagedResponse(payload, { page, limit });
        const apiUsers = extractUsersList({ ...payload, data: paged.data });
        const uiUsers = apiUsers.map(toUiUser).filter(Boolean);
        if (!cancelled) {
          setUsers(uiUsers);
          setTotal(paged.total ?? null);
          setHasNext(Boolean(paged.hasNext));
          setHasPrev(Boolean(paged.hasPrev));
          setPageInput(String(page));
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load users.");
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadUsers();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, limit, page, searchQuery]);

  useEffect(() => {
    if (!apiBaseUrl) return;

    let cancelled = false;
    async function loadStores() {
      setIsStoresLoading(true);
      try {
        const pageSize = 200;
        let currentPage = 1;
        const collected = [];

        for (let guard = 0; guard < 50; guard += 1) {
          const payload = await apiRequest(
            `/stores${buildQueryString({ page: currentPage, limit: pageSize })}`,
          );
          const paged = parsePagedResponse(payload, { page: currentPage, limit: pageSize });
          const apiStores = extractStoresList({ ...payload, data: paged.data });
          collected.push(...apiStores.map(toUiStore).filter(Boolean));
          if (!paged.hasNext) break;
          currentPage += 1;
        }

        const byId = new Map();
        for (const store of collected) {
          if (!store?.id) continue;
          byId.set(String(store.id), store);
        }
        const uiStores = Array.from(byId.values()).sort((a, b) =>
          compareValues(a.name, b.name),
        );

        if (!cancelled) setStores(uiStores);
      } catch {
        // optional: users CRUD can still work without stores list
      } finally {
        if (!cancelled) setIsStoresLoading(false);
      }
    }

    loadStores();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken]);

  const editingUser = useMemo(() => {
    if (!editingId) return null;
    return users.find((u) => u.id === editingId) || null;
  }, [editingId, users]);

  const storeById = useMemo(() => {
    const map = new Map();
    for (const s of stores) {
      if (!s?.id) continue;
      map.set(String(s.id), s);
    }
    return map;
  }, [stores]);

  const storeOptions = useMemo(() => {
    return [...stores]
      .filter((s) => s && typeof s === "object" && s.id)
      .map((s) => ({ id: String(s.id), name: String(s.name ?? "") }))
      .sort((a, b) => compareValues(a.name, b.name));
  }, [stores]);

  useEffect(() => {
    if (!editingUser) {
      setName("");
      setEmail("");
      setUserType("employee");
      setPassword("");
      setPosPin("");
      setStoreId("");
      return;
    }
    setName(editingUser.name || "");
    setEmail(editingUser.email || "");
    setUserType(editingUser.userType || "employee");
    setPassword("");
    setPosPin(editingUser.posPin || "");
    setStoreId(editingUser.storeId || "");
  }, [editingUser]);

  useEffect(() => {
    if (userType === "cashier") {
      if (!posPin && !editingId) setPosPin(generatePosPin());
      return;
    }
    if (posPin) setPosPin("");
  }, [editingId, posPin, userType]);

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

  const filteredUsers = useMemo(() => {
    const q = (searchQuery || "").trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const storeName = u?.storeId ? storeById.get(String(u.storeId))?.name ?? "" : "";
      const haystack = `${u?.name ?? ""} ${u?.email ?? ""} ${u?.userType ?? ""} ${u?.posPin ?? ""} ${storeName}`
        .trim()
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [searchQuery, storeById, users]);

  const sortedUsers = useMemo(() => {
    const factor = sort.direction === "asc" ? 1 : -1;

    return [...filteredUsers].sort((a, b) => {
      const aValue =
        sort.key === "storeName"
          ? (a?.storeId ? storeById.get(String(a.storeId))?.name ?? "" : "")
          : a?.[sort.key];
      const bValue =
        sort.key === "storeName"
          ? (b?.storeId ? storeById.get(String(b.storeId))?.name ?? "" : "")
          : b?.[sort.key];

      const primary = compareValues(aValue, bValue);
      if (primary !== 0) return primary * factor;
      return compareValues(a?.id, b?.id);
    });
  }, [filteredUsers, sort.direction, sort.key, storeById]);

  function resetForm() {
    setEditingId(null);
    setError("");
    setName("");
    setEmail("");
    setUserType("employee");
    setPassword("");
    setPosPin("");
    setStoreId("");
  }

  function validateForm() {
    const trimmedName = name.trim();
    const trimmedEmail = email.trim();

    if (!trimmedName) return "Name is required.";
    if (!trimmedEmail) return "Email is required.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail))
      return "Email is invalid.";
    if (!USER_TYPES.includes(userType)) return "User type is invalid.";

    const emailTaken = users.some(
      (u) =>
        u.email &&
        String(u.email).toLowerCase() === trimmedEmail.toLowerCase() &&
        u.id !== editingId,
    );
    if (emailTaken) return "Email is already used by another user.";

    if (!editingId && !password) return "Password is required for new users.";
    if (userType === "cashier") {
      if (posPin && !/^\d{6}$/.test(String(posPin || ""))) {
        return "POS PIN must be a 6-digit number.";
      }
    }
    return "";
  }

  async function reloadUsers() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        search: (searchQuery || "").trim() || undefined,
      });
      const payload = await apiRequest(`/users${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiUsers = extractUsersList({ ...payload, data: paged.data });
      setUsers(apiUsers.map(toUiUser).filter(Boolean));
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users.");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (page !== 1) setPage(1);
    if (pageInput !== "1") setPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

  async function upsertUser() {
    if (!canManageUsers) {
      setError("You do not have permission to create or edit users.");
      return;
    }
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
        name: name.trim(),
        email: email.trim(),
        role: userType,
      };
      if (password) payload.password = password;
      if (userType === "cashier") {
        payload.pos_pin = posPin || generatePosPin();
      }
      if (storeId) {
        payload.storeId = storeId;
      } else if (editingId && editingUser?.storeId) {
        payload.storeId = null;
      }

      if (editingId) {
        await apiRequest(`/users/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/users", { method: "POST", body: payload });
      }

      await reloadUsers();
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save user.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteUser(user) {
    if (!canManageUsers) {
      setError("You do not have permission to delete users.");
      return;
    }
    const label = user?.email || user?.name || "this user";
    const ok = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!ok) return;

    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
      await reloadUsers();
      if (editingId === user.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete user.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Users</h1>
        <div className="pageSubtitle">Create, edit, and remove users</div>
      </div>

      <div className="grid">
        <section className="card" aria-label={editingId ? "Edit user" : "Create user"}>
          <div className="cardHeader">
            <div className="cardTitle">{editingId ? "Edit user" : "Create user"}</div>
            <div className="cardSubtitle">
              Assign a user type: admin, owner, or employee
            </div>
          </div>

          <div className="createItemBody">
            {!canManageUsers ? (
              <div className="authError">
                Your role ({currentRole}) cannot create or edit users.
              </div>
            ) : null}

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Name</div>
                <input
                  className="textInput"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Full name"
                  disabled={!canManageUsers || isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Email</div>
                <input
                  className="textInput"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                  disabled={!canManageUsers || isSaving}
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">User type</div>
                <select
                  className="select"
                  value={userType}
                  onChange={(e) => setUserType(e.target.value)}
                  disabled={!canManageUsers || isSaving}
                >
                  {USER_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">
                  Password {editingId ? "(leave blank to keep)" : ""}
                </div>
                <input
                  className="textInput"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={editingId ? "••••••••" : "Password"}
                  autoComplete={editingId ? "new-password" : "new-password"}
                  disabled={!canManageUsers || isSaving}
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Assigned store</div>
                <select
                  className="select"
                  value={storeId}
                  onChange={(e) => setStoreId(e.target.value)}
                  disabled={!canManageUsers || isStoresLoading || isSaving}
                >
                  <option value="">{isStoresLoading ? "Loading..." : "Unassigned"}</option>
                  {storeOptions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.id}
                    </option>
                  ))}
                </select>
              </label>

              <div className="field createItemField" aria-label="Selected store">
                <div className="fieldLabel">&nbsp;</div>
                <div className="rowSubtitle">
                  {storeId ? storeById.get(String(storeId))?.name || storeId : ""}
                </div>
              </div>
            </div>

            {userType === "cashier" ? (
              <div className="createItemGrid">
                <label className="field createItemField">
                  <div className="fieldLabel">POS PIN</div>
                  <input
                    className="textInput posPinInput"
                    type="text"
                    inputMode="numeric"
                    readOnly
                    value={posPin}
                    aria-label="POS PIN"
                  />
                </label>

                <div className="field createItemField" aria-label="PIN actions">
                  <div className="fieldLabel">&nbsp;</div>
                  <button
                    className="btn btnGhost btnSmall"
                    type="button"
                    onClick={() => setPosPin(generatePosPin())}
                    disabled={!canManageUsers || isSaving}
                  >
                    {posPin ? "Regenerate PIN" : "Generate PIN"}
                  </button>
                </div>
              </div>
            ) : null}

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
              onClick={upsertUser}
              disabled={!canManageUsers || isSaving}
            >
              {editingId ? "Save changes" : "Create user"}
            </button>
          </div>
        </section>

        <section className="card" aria-label="User list">
          <div className="cardHeader">
            <div className="cardTitle">User list</div>
            <div className="cardSubtitle">
              {sortedUsers.length} user{sortedUsers.length === 1 ? "" : "s"}
              {searchQuery ? ` (filtered by “${searchQuery}”)` : ""}
              {isLoading ? " • Loading…" : ""}
            </div>
          </div>

          <div className="tableWrap">
            <table className="table" aria-label="Users table">
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
                  <th className="colEmail" aria-sort={ariaSort("email")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("email")}
                    >
                      Email <span className="sortArrow">{sortArrow("email")}</span>
                    </button>
                  </th>
                  <th className="colType" aria-sort={ariaSort("userType")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("userType")}
                    >
                      User type{" "}
                      <span className="sortArrow">{sortArrow("userType")}</span>
                    </button>
                  </th>
                  <th className="colStore" aria-sort={ariaSort("storeName")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("storeName")}
                    >
                      Store <span className="sortArrow">{sortArrow("storeName")}</span>
                    </button>
                  </th>
                  <th className="colPin" aria-sort={ariaSort("posPin")}>
                    <button
                      type="button"
                      className="thSortBtn"
                      onClick={() => toggleSort("posPin")}
                    >
                      POS PIN <span className="sortArrow">{sortArrow("posPin")}</span>
                    </button>
                  </th>
                  <th className="colActions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="usersEmpty">
                      No users yet. Create one on the left.
                    </td>
                  </tr>
                ) : (
                  sortedUsers.map((u) => {
                    const isEditing = editingId === u.id;
                    return (
                      <tr key={u.id} aria-selected={isEditing || undefined}>
                        <td className="colName">{u.name}</td>
                        <td className="colEmail">{u.email || "—"}</td>
                        <td className="colType">
                          <span className="cellSelect">{u.userType}</span>
                        </td>
                        <td className="colStore">
                          {u.storeId ? storeById.get(String(u.storeId))?.name || u.storeId : "—"}
                        </td>
                        <td className="colPin">{u.userType === "cashier" ? u.posPin || "—" : "—"}</td>
                        <td className="colActions">
                          <div className="usersActions">
                            <button
                              className="btn btnGhost btnSmall"
                              type="button"
                              onClick={() => {
                                setError("");
                                setEditingId(u.id);
                              }}
                              disabled={!canManageUsers}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btnGhost btnSmall btnDanger"
                              type="button"
                              onClick={() => deleteUser(u)}
                              disabled={!canManageUsers}
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
              onClick={reloadUsers}
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
