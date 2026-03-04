import { useEffect, useMemo, useRef, useState } from "react";

import {
  getActorHeaders,
  getFetchCredentials,
  loadCategoriesFromStorage,
  loadCategoryNamesFromStorage,
} from "../utils/common.js";

function toNumberOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntOrNull(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

export default function CreateItemPage({
  apiBaseUrl,
  authToken,
  authUser,
  itemId,
  onCancel,
  onSaved,
}) {
  const didAutoSkuRef = useRef(false);
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [isForSale, setIsForSale] = useState(true);
  const [soldBy, setSoldBy] = useState("each");
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [sku, setSku] = useState("");
  const [barcode, setBarcode] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Inventory (intentionally excludes "Composite item", Variants, and POS representation sections)
  const [trackStock, setTrackStock] = useState(false);
  const [inStock, setInStock] = useState("");

  const categories = useMemo(() => {
    const unique = new Set();
    for (const name of loadCategoryNamesFromStorage()) unique.add(name);
    if (category) unique.add(category);
    return Array.from(unique).filter(Boolean).sort();
  }, [category]);

  const categoryId = useMemo(() => {
    const selected = String(category || "").trim();
    if (!selected) return null;

    const list = loadCategoriesFromStorage();
    const match = list.find((c) => c?.name === selected);
    return match?.id ?? null;
  }, [category]);

  function getAuthHeaders() {
    const headers = { "Content-Type": "application/json" };
    if (authToken) headers.Authorization = `Bearer ${authToken}`;
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

  function extractSku(payload) {
    if (payload == null) return null;
    if (typeof payload === "string" || typeof payload === "number")
      return String(payload);
    if (typeof payload !== "object") return null;

    const skuValue =
      payload.sku ??
      payload.nextSku ??
      payload.next_sku ??
      payload?.data?.sku ??
      payload?.data?.nextSku ??
      payload?.data?.next_sku ??
      payload?.data ??
      null;

    if (skuValue == null) return null;
    if (typeof skuValue === "string" || typeof skuValue === "number")
      return String(skuValue);
    return null;
  }

  async function generateSku() {
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }

    const trimmed = sku.trim();
    if (trimmed) {
      const ok = window.confirm(
        "Generate a new SKU and replace the current one?",
      );
      if (!ok) return;
    }

    setError("");
    try {
      const payload = await apiRequest("/items/next-sku");
      const next = extractSku(payload);
      if (!next) throw new Error("Invalid SKU response from server.");
      setSku(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate SKU.");
    }
  }

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (itemId) return;
    if (didAutoSkuRef.current) return;
    if (sku.trim()) return;

    didAutoSkuRef.current = true;
    generateSku();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, itemId]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (!itemId) return;

    let cancelled = false;
    async function loadItem() {
      setIsLoading(true);
      setError("");
      try {
        const payload = await apiRequest(
          `/items/${encodeURIComponent(itemId)}`,
        );
        const data = payload?.data ?? payload?.item ?? payload;
        if (!data || typeof data !== "object")
          throw new Error("Invalid item payload.");

        if (cancelled) return;
        setName(String(data.name ?? ""));
        const categoryField = data.category ?? null;
        const loadedCategory =
          categoryField && typeof categoryField === "object"
            ? String(categoryField.name ?? "").trim()
            : String(
                data.categoryName ?? data.category_name ?? categoryField ?? "",
              ).trim();
        const loadedCategoryId =
          (categoryField && typeof categoryField === "object"
            ? categoryField.id ?? categoryField._id ?? null
            : null) ??
          data.categoryId ??
          data.category_id ??
          data.categoryID ??
          null;

        if (!loadedCategory && loadedCategoryId) {
          const fromStorage = loadCategoriesFromStorage().find(
            (c) => c?.id === String(loadedCategoryId),
          );
          setCategory(String(fromStorage?.name ?? ""));
        } else {
          setCategory(loadedCategory);
        }
        setDescription(String(data.description ?? ""));
        setIsForSale(Boolean(data.isForSale ?? data.is_for_sale ?? true));
        setSoldBy(String(data.soldBy ?? data.sold_by ?? "each"));
        setPrice(data.price == null ? "" : String(data.price));
        setCost(data.cost == null ? "" : String(data.cost));
        setSku(String(data.sku ?? ""));
        setBarcode(String(data.barcode ?? ""));

        const track = Boolean(data.trackStock ?? data.track_stock ?? true);
        setTrackStock(track);
        setInStock(data.inStock == null ? "" : String(data.inStock));
      } catch (e) {
        if (!cancelled)
          setError(e instanceof Error ? e.message : "Failed to load item.");
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    loadItem();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBaseUrl, authToken, itemId]);

  async function saveItem() {
    setError("");
    if (!apiBaseUrl) {
      setError("API base URL is not configured.");
      return;
    }
    if (!name.trim()) {
      setError("Name is required.");
      return;
    }

    setIsSaving(true);
    try {
      const skuValue = sku.trim();
      const skuNumber = toIntOrNull(skuValue);
      const categoryName = String(category || "").trim();
      const payload = {
        name: name.trim(),
        category: categoryName
          ? { id: categoryId || null, name: categoryName }
          : null,
        description: description || "",
        isForSale: Boolean(isForSale),
        soldBy,
        price: toNumberOrNull(price),
        cost: toNumberOrNull(cost),
        sku: skuNumber ?? (skuValue || ""),
        barcode: barcode || "",
        trackStock: Boolean(trackStock),
      };

      if (trackStock) {
        payload.inStock = toIntOrNull(inStock);
      }

      if (itemId) {
        await apiRequest(`/items/${encodeURIComponent(itemId)}`, {
          method: "PATCH",
          body: payload,
        });
      } else {
        await apiRequest("/items", { method: "POST", body: payload });
      }

      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save item.");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="page">
      <div className="pageHeader">
        <h1 className="pageTitle">{itemId ? "Edit item" : "Create item"}</h1>
        <div className="pageSubtitle">
          {isLoading ? "Loading…" : "Basic info and inventory"}
        </div>
      </div>

      <div className="createItemWrap">
        <section className="card" aria-label="Item details">
          <div className="cardHeader">
            <div className="cardTitle">Details</div>
            <div className="cardSubtitle">Name, category, pricing</div>
          </div>

          <div className="createItemBody">
            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Name</div>
                <input
                  className="textInput"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name"
                  disabled={isLoading || isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Category</div>
                <select
                  className="select"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  disabled={isLoading || isSaving}
                >
                  <option value="">No category</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field createItemField">
              <div className="fieldLabel">Description</div>
              <textarea
                className="textarea"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Description"
                rows={3}
                disabled={isLoading || isSaving}
              />
            </label>

            <label className="createItemCheck">
              <input
                type="checkbox"
                checked={isForSale}
                onChange={(e) => setIsForSale(e.target.checked)}
                disabled={isLoading || isSaving}
              />
              <span>The item is available for sale</span>
            </label>

            <div className="createItemSoldBy" aria-label="Sold by">
              <div className="fieldLabel">Sold by</div>
              <label className="radio">
                <input
                  type="radio"
                  name="soldBy"
                  value="each"
                  checked={soldBy === "each"}
                  onChange={(e) => setSoldBy(e.target.value)}
                  disabled={isLoading || isSaving}
                />
                <span>Each</span>
              </label>
              <label className="radio">
                <input
                  type="radio"
                  name="soldBy"
                  value="weight"
                  checked={soldBy === "weight"}
                  onChange={(e) => setSoldBy(e.target.value)}
                  disabled={isLoading || isSaving}
                />
                <span>Weight/Volume</span>
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">Price</div>
                <input
                  className="textInput"
                  inputMode="decimal"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading || isSaving}
                />
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Cost</div>
                <input
                  className="textInput"
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => setCost(e.target.value)}
                  placeholder="0.00"
                  disabled={isLoading || isSaving}
                />
              </label>
            </div>

            <div className="createItemGrid">
              <label className="field createItemField">
                <div className="fieldLabel">SKU</div>
                <div className="inputWithAction">
                  <input
                    className="textInput"
                    value={sku}
                    onChange={(e) => setSku(e.target.value)}
                    placeholder="SKU"
                    disabled={isLoading || isSaving}
                  />
                </div>
              </label>

              <label className="field createItemField">
                <div className="fieldLabel">Barcode</div>
                <input
                  className="textInput"
                  value={barcode}
                  onChange={(e) => setBarcode(e.target.value)}
                  placeholder="Barcode"
                  disabled={isLoading || isSaving}
                />
              </label>
            </div>

            {error ? <div className="authError">{error}</div> : null}
          </div>

          <div className="cardActions">
            <button className="btn btnGhost" type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              className="btn btnPrimary"
              type="button"
              onClick={saveItem}
              disabled={isLoading || isSaving}
            >
              Save
            </button>
          </div>
        </section>

        <section className="card" aria-label="Inventory">
          <div className="cardHeader">
            <div className="cardTitle">Inventory</div>
            <div className="cardSubtitle">Stock tracking</div>
          </div>

          <div className="list">
            <div className="row">
              <div className="rowMain">
                <div className="rowTitle">Track stock</div>
                <div className="rowSubtitle">
                  Count inventory for this item.
                </div>
              </div>
              <label className="switch">
                <input
                  type="checkbox"
                  checked={trackStock}
                  onChange={(e) => setTrackStock(e.target.checked)}
                  disabled={isLoading || isSaving}
                />
                <span className="switchTrack" aria-hidden="true" />
              </label>
            </div>

            {trackStock ? (
              <div className="row">
                <div className="rowMain">
                  <div className="rowTitle">In stock</div>
                  <div className="rowSubtitle">Starting quantity.</div>
                </div>
                <input
                  className="pageInput"
                  inputMode="numeric"
                  value={inStock}
                  onChange={(e) => setInStock(e.target.value)}
                  aria-label="In stock"
                  disabled={isLoading || isSaving}
                />
              </div>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
