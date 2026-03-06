import { useEffect, useMemo, useState } from "react";

import {
  buildQueryString,
  parsePagedResponse,
  readLocalStorage,
  safeParseList,
  writeLocalStorage,
} from "./common.js";

export const STORES_STORAGE_KEY = "pos.stores.v1";

export function extractStoresList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.stores)) return payload.stores;
  if (Array.isArray(payload?.data?.stores)) return payload.data.stores;
  return [];
}

export function toUiStore(apiStore) {
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

export function makeStoreOptions({ stores, activeStoreId }) {
  const map = new Map();
  for (const s of stores || []) {
    if (!s?.id) continue;
    map.set(String(s.id), { id: String(s.id), name: String(s.name ?? "") });
  }

  const active = String(activeStoreId || "").trim();
  if (active && !map.has(active)) map.set(active, { id: active, name: active });

  return Array.from(map.values()).sort((a, b) =>
    String(a.name || a.id).localeCompare(String(b.name || b.id), undefined, {
      sensitivity: "base",
    }),
  );
}

export function useStoresList({ apiBaseUrl, apiRequest }) {
  const [stores, setStores] = useState(() => {
    return safeParseList(readLocalStorage(STORES_STORAGE_KEY, ""))
      .map(toUiStore)
      .filter(Boolean);
  });
  const [isStoresLoading, setIsStoresLoading] = useState(false);

  useEffect(() => {
    writeLocalStorage(STORES_STORAGE_KEY, JSON.stringify(stores));
  }, [stores]);

  useEffect(() => {
    if (!apiBaseUrl) return;
    if (typeof apiRequest !== "function") return;

    let cancelled = false;
    async function loadStores() {
      setIsStoresLoading(true);
      try {
        const qs = buildQueryString({ page: 1, limit: 200 });
        const payload = await apiRequest(`/stores${qs}`);
        const paged = parsePagedResponse(payload, { page: 1, limit: 200 });
        const apiStores = extractStoresList({ ...payload, data: paged.data });
        const ui = apiStores.map(toUiStore).filter(Boolean);
        if (!cancelled && ui.length) setStores(ui);
      } catch {
        // optional: reports can still load without stores list
      } finally {
        if (!cancelled) setIsStoresLoading(false);
      }
    }

    loadStores();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, apiRequest]);

  return useMemo(() => ({ stores, isStoresLoading }), [stores, isStoresLoading]);
}

