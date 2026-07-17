import { useCallback, useEffect, useMemo, useState } from "react";

import {
  buildQueryString,
  compareValues,
  getActorHeaders,
  getFetchCredentials,
  makeId,
  parsePagedResponse,
  readLocalStorage,
  safeParseList,
  toPositiveInt,
  writeLocalStorage,
} from "../utils/common.js";

const STORAGE_KEY = "pos.customers.v1";

const moneylessCountryList = [
  "Philippines",
  "United States",
  "Canada",
  "Australia",
  "United Kingdom",
  "Singapore",
  "Malaysia",
  "Japan",
  "South Korea",
  "United Arab Emirates",
];

function extractCustomersList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.customers)) return payload.customers;
  if (Array.isArray(payload?.data?.customers)) return payload.data.customers;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.results)) return payload.data.results;
  return [];
}

function toUiCustomer(apiCustomer) {
  if (!apiCustomer || typeof apiCustomer !== "object") return null;

  const id =
    apiCustomer.id ??
    apiCustomer._id ??
    apiCustomer.customerId ??
    apiCustomer.uuid ??
    (apiCustomer.email ? `email:${apiCustomer.email}` : null) ??
    makeId("c");

  const name =
    typeof apiCustomer.name === "string"
      ? apiCustomer.name
      : typeof apiCustomer.fullName === "string"
        ? apiCustomer.fullName
        : typeof apiCustomer.customerName === "string"
          ? apiCustomer.customerName
          : "";

  const email =
    typeof apiCustomer.email === "string"
      ? apiCustomer.email
      : typeof apiCustomer.customerEmail === "string"
        ? apiCustomer.customerEmail
        : "";

  const phone =
    typeof apiCustomer.phone === "string" || typeof apiCustomer.phone === "number"
      ? String(apiCustomer.phone)
      : typeof apiCustomer.mobile === "string" || typeof apiCustomer.mobile === "number"
        ? String(apiCustomer.mobile)
        : "";

  const address = typeof apiCustomer.address === "string" ? apiCustomer.address : "";
  const city = typeof apiCustomer.city === "string" ? apiCustomer.city : "";
  const province =
    typeof apiCustomer.province === "string"
      ? apiCustomer.province
      : typeof apiCustomer.state === "string"
        ? apiCustomer.state
        : "";
  const postalCode =
    typeof apiCustomer.postalCode === "string" || typeof apiCustomer.postalCode === "number"
      ? String(apiCustomer.postalCode)
      : typeof apiCustomer.postal_code === "string" || typeof apiCustomer.postal_code === "number"
        ? String(apiCustomer.postal_code)
        : "";

  const country =
    typeof apiCustomer.country === "string" && apiCustomer.country.trim()
      ? apiCustomer.country.trim()
      : "Philippines";

  const customerCode =
    typeof apiCustomer.customerCode === "string" || typeof apiCustomer.customerCode === "number"
      ? String(apiCustomer.customerCode)
      : typeof apiCustomer.code === "string" || typeof apiCustomer.code === "number"
        ? String(apiCustomer.code)
        : "";

  const note =
    typeof apiCustomer.note === "string"
      ? apiCustomer.note
      : typeof apiCustomer.notes === "string"
        ? apiCustomer.notes
        : "";

  const storeId =
    apiCustomer.storeId ??
    apiCustomer.store_id ??
    apiCustomer.assignedStoreId ??
    apiCustomer.assigned_store_id ??
    apiCustomer.store?.id ??
    apiCustomer.store?._id ??
    apiCustomer.store?.storeId ??
    "";

  return {
    id: String(id),
    name: String(name || "").trim(),
    email: String(email || "").trim(),
    phone: String(phone || "").trim(),
    address: String(address || "").trim(),
    city: String(city || "").trim(),
    province: String(province || "").trim(),
    postalCode: String(postalCode || "").trim(),
    country: String(country || "").trim(),
    customerCode: String(customerCode || "").trim(),
    note: String(note || "").trim(),
    storeId:
      typeof storeId === "string" || typeof storeId === "number" ? String(storeId) : "",
  };
}

export default function CustomersPage({
  apiBaseUrl,
  authToken,
  authUser,
  searchQuery,
}) {
  const [customers, setCustomers] = useState(() => {
    return safeParseList(readLocalStorage(STORAGE_KEY, "")).map(toUiCustomer).filter(Boolean);
  });

  const [editingId, setEditingId] = useState(null);
  const editingCustomer = useMemo(
    () => customers.find((c) => c.id === editingId) || null,
    [customers, editingId],
  );

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
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [province, setProvince] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("Philippines");
  const [customerCode, setCustomerCode] = useState("");
  const [note, setNote] = useState("");

  const countries = useMemo(() => {
    const unique = new Set(moneylessCountryList);
    if (country) unique.add(country);
    return Array.from(unique).filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [country]);

  const authHeaders = useMemo(() => {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
    return { ...headers, ...getActorHeaders(authUser) };
  }, [authToken, authUser]);

  async function readJsonSafely(response) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  const apiRequest = useCallback(
    async (path, { method = "GET", body } = {}) => {
      if (!apiBaseUrl) throw new Error("API base URL is not configured.");
      const trimmedBase = String(apiBaseUrl).replace(/\/$/, "");
      const response = await fetch(`${trimmedBase}${path}`, {
        method,
        credentials: getFetchCredentials(),
        headers: authHeaders,
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
    },
    [apiBaseUrl, authHeaders],
  );

  useEffect(() => {
    writeLocalStorage(STORAGE_KEY, JSON.stringify(customers));
  }, [customers]);

  useEffect(() => {
    if (page !== 1) setPage(1);
    if (pageInput !== "1") setPageInput("1");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery]);

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
          q: (searchQuery || "").trim() || undefined,
        });
        const payload = await apiRequest(`/customers${qs}`);
        const paged = parsePagedResponse(payload, { page, limit });
        const apiCustomers = extractCustomersList({ ...payload, data: paged.data });
        if (cancelled) return;
        setCustomers(apiCustomers.map(toUiCustomer).filter(Boolean));
        setTotal(paged.total ?? null);
        setHasNext(Boolean(paged.hasNext));
        setHasPrev(Boolean(paged.hasPrev));
        setPageInput(String(page));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Failed to load customers.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [apiRequest, apiBaseUrl, page, limit, searchQuery]);

  function toggleSort(key) {
    setSort((prev) => {
      const direction =
        prev.key === key ? (prev.direction === "asc" ? "desc" : "asc") : "asc";
      return { key, direction };
    });
  }

  function sortArrow(key) {
    if (sort.key !== key) return "↕";
    return sort.direction === "asc" ? "↑" : "↓";
  }

  function ariaSort(key) {
    if (sort.key !== key) return "none";
    return sort.direction === "asc" ? "ascending" : "descending";
  }

  const sortedCustomers = useMemo(() => {
    const list = [...customers];
    const dir = sort.direction === "asc" ? 1 : -1;
    list.sort((a, b) => {
      const aValue =
        sort.key === "email"
          ? a.email
          : sort.key === "phone"
            ? a.phone
            : sort.key === "code"
              ? a.customerCode
              : sort.key === "city"
                ? a.city
                : a.name;
      const bValue =
        sort.key === "email"
          ? b.email
          : sort.key === "phone"
            ? b.phone
            : sort.key === "code"
              ? b.customerCode
              : sort.key === "city"
                ? b.city
                : b.name;
      return compareValues(aValue, bValue) * dir;
    });
    return list;
  }, [customers, sort]);

  useEffect(() => {
    if (!editingCustomer) return;
    setName(editingCustomer.name || "");
    setEmail(editingCustomer.email || "");
    setPhone(editingCustomer.phone || "");
    setAddress(editingCustomer.address || "");
    setCity(editingCustomer.city || "");
    setProvince(editingCustomer.province || "");
    setPostalCode(editingCustomer.postalCode || "");
    setCountry(editingCustomer.country || "Philippines");
    setCustomerCode(editingCustomer.customerCode || "");
    setNote(editingCustomer.note || "");
  }, [editingCustomer]);

  function resetForm() {
    setEditingId(null);
    setError("");
    setName("");
    setEmail("");
    setPhone("");
    setAddress("");
    setCity("");
    setProvince("");
    setPostalCode("");
    setCountry("Philippines");
    setCustomerCode("");
    setNote("");
  }

  function validate() {
    if (!name.trim()) return "Name is required.";
    if (note && note.length > 255) return "Note must be 255 characters or less.";
    return "";
  }

  async function saveCustomer() {
    const message = validate();
    if (message) {
      setError(message);
      return;
    }

    const payload = {
      name: name.trim(),
      email: email.trim() || null,
      phone: phone.trim() || null,
      address: address.trim() || null,
      city: city.trim() || null,
      province: province.trim() || null,
      postalCode: postalCode.trim() || null,
      country: country.trim() || null,
      customerCode: customerCode.trim() || null,
      note: note.trim() || null,
    };

    setIsSaving(true);
    setError("");
    try {
      if (editingId) {
        const result = await apiRequest(`/customers/${encodeURIComponent(editingId)}`, {
          method: "PATCH",
          body: payload,
        });
        const updated = toUiCustomer(result?.data ?? result?.customer ?? result);
        if (updated) {
          setCustomers((prev) => prev.map((c) => (c.id === editingId ? updated : c)));
        }
      } else {
        const result = await apiRequest("/customers", { method: "POST", body: payload });
        const created = toUiCustomer(result?.data ?? result?.customer ?? result);
        if (created) {
          setCustomers((prev) => [created, ...prev]);
        }
      }
      resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save customer.");
    } finally {
      setIsSaving(false);
    }
  }

  async function deleteCustomer(customer) {
    if (!customer) return;
    const ok = window.confirm(`Delete customer "${customer.name || customer.email || customer.id}"?`);
    if (!ok) return;

    setIsSaving(true);
    setError("");
    try {
      await apiRequest(`/customers/${encodeURIComponent(customer.id)}`, { method: "DELETE" });
      setCustomers((prev) => prev.filter((c) => c.id !== customer.id));
      if (editingId === customer.id) resetForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete customer.");
    } finally {
      setIsSaving(false);
    }
  }

  async function reloadCustomers() {
    if (!apiBaseUrl) return;
    setIsLoading(true);
    setError("");
    try {
      const qs = buildQueryString({
        page,
        limit,
        q: (searchQuery || "").trim() || undefined,
      });
      const payload = await apiRequest(`/customers${qs}`);
      const paged = parsePagedResponse(payload, { page, limit });
      const apiCustomers = extractCustomersList({ ...payload, data: paged.data });
      setCustomers(apiCustomers.map(toUiCustomer).filter(Boolean));
      setTotal(paged.total ?? null);
      setHasNext(Boolean(paged.hasNext));
      setHasPrev(Boolean(paged.hasPrev));
      setPageInput(String(page));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customers.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">Customers</h1>
        <div className="pageSubtitle">Add and manage customers</div>
      </div>

      <div className="grid">
        <section className="card" aria-label="Customer form">
          <div className="cardHeader">
            <div className="cardTitle">{editingId ? "Edit customer" : "New customer"}</div>
            <div className="cardSubtitle">Customer details</div>
          </div>

          <div className="customerFormBody">
            <div className="customerAvatar" aria-hidden="true">
              <div className="customerAvatarInner" />
            </div>

            <label className="field">
              <div className="fieldLabel">Name</div>
              <input
                className="textInput"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Name"
                disabled={isSaving}
              />
            </label>

            <label className="field">
              <div className="fieldLabel">Email</div>
              <input
                className="textInput"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                disabled={isSaving}
              />
            </label>

            <label className="field">
              <div className="fieldLabel">Phone</div>
              <input
                className="textInput"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="Phone"
                disabled={isSaving}
              />
            </label>

            <label className="field">
              <div className="fieldLabel">Address</div>
              <input
                className="textInput"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Address"
                disabled={isSaving}
              />
            </label>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">City</div>
                <input
                  className="textInput"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="City"
                  disabled={isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Province</div>
                <input
                  className="textInput"
                  value={province}
                  onChange={(e) => setProvince(e.target.value)}
                  placeholder="Province"
                  disabled={isSaving}
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Postal code</div>
                <input
                  className="textInput"
                  value={postalCode}
                  onChange={(e) => setPostalCode(e.target.value)}
                  placeholder="Postal code"
                  disabled={isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Country</div>
                <select
                  className="select"
                  value={country}
                  onChange={(e) => setCountry(e.target.value)}
                  disabled={isSaving}
                  aria-label="Country"
                >
                  {countries.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field">
              <div className="fieldLabel">Customer code</div>
              <input
                className="textInput"
                value={customerCode}
                onChange={(e) => setCustomerCode(e.target.value)}
                placeholder="Customer code"
                disabled={isSaving}
              />
            </label>

            <label className="field">
              <div className="fieldLabel">Note</div>
              <textarea
                className="textInput customerNote"
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, 255))}
                placeholder="Note"
                disabled={isSaving}
              />
              <div className="customerNoteCount">{note.length} / 255</div>
            </label>

            {error ? <div className="authError">{error}</div> : null}
          </div>

          <div className="cardActions">
            <button className="btn btnGhost" type="button" onClick={resetForm} disabled={isSaving}>
              Clear form
            </button>
            <button
              className="btn btnPrimary"
              type="button"
              onClick={saveCustomer}
              disabled={isSaving}
            >
              {editingId ? "Save changes" : "Add customer"}
            </button>
          </div>
        </section>

        <section className="card" aria-label="Customers list">
          <div className="cardHeader">
            <div className="cardTitle">Customer list</div>
            <div className="cardSubtitle">
              {isLoading ? "Loading…" : `${customers.length} loaded`}
            </div>
          </div>

          <div className="tableWrap">
            <table className="table" aria-label="Customers table">
              <thead>
                <tr>
                  <th className="colName" aria-sort={ariaSort("name")}>
                    <button type="button" className="thSortBtn" onClick={() => toggleSort("name")}>
                      Name <span className="sortArrow">{sortArrow("name")}</span>
                    </button>
                  </th>
                  <th className="colEmail" aria-sort={ariaSort("email")}>
                    <button type="button" className="thSortBtn" onClick={() => toggleSort("email")}>
                      Email <span className="sortArrow">{sortArrow("email")}</span>
                    </button>
                  </th>
                  <th className="colPhone" aria-sort={ariaSort("phone")}>
                    <button type="button" className="thSortBtn" onClick={() => toggleSort("phone")}>
                      Phone <span className="sortArrow">{sortArrow("phone")}</span>
                    </button>
                  </th>
                  <th className="colCity" aria-sort={ariaSort("city")}>
                    <button type="button" className="thSortBtn" onClick={() => toggleSort("city")}>
                      City <span className="sortArrow">{sortArrow("city")}</span>
                    </button>
                  </th>
                  <th className="colRestricted" aria-sort={ariaSort("code")}>
                    <button
                      type="button"
                      className="thSortBtn thSortBtnRight"
                      onClick={() => toggleSort("code")}
                    >
                      Code <span className="sortArrow">{sortArrow("code")}</span>
                    </button>
                  </th>
                  <th className="colActions" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {sortedCustomers.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="usersEmpty">
                      {isLoading ? "Loading…" : "No customers yet. Create one on the left."}
                    </td>
                  </tr>
                ) : (
                  sortedCustomers.map((c) => {
                    const isEditing = editingId === c.id;
                    return (
                      <tr key={c.id} aria-selected={isEditing || undefined}>
                        <td className="colName">{c.name || "—"}</td>
                        <td className="colEmail">{c.email || "—"}</td>
                        <td className="colPhone">{c.phone || "—"}</td>
                        <td className="colCity">{c.city || "—"}</td>
                        <td className="colRestricted">{c.customerCode || "—"}</td>
                        <td className="colActions">
                          <div className="usersActions">
                            <button
                              className="btn btnGhost btnSmall"
                              type="button"
                              onClick={() => {
                                setError("");
                                setEditingId(c.id);
                              }}
                              disabled={isSaving}
                            >
                              Edit
                            </button>
                            <button
                              className="btn btnGhost btnSmall btnDanger"
                              type="button"
                              onClick={() => deleteCustomer(c)}
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
            <button className="btn btnGhost" type="button" onClick={reloadCustomers} disabled={isLoading || isSaving}>
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
