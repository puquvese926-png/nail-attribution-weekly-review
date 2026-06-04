import { cacheKeyForRange, getWarehouseStore, json, resolveCacheRange, statusKeyForRange, warehouseEnvStatus } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "GET") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    const url = new URL(req.url);
    const range = resolveCacheRange(url);
    const store = getWarehouseStore();
    const cacheKey = cacheKeyForRange(range.start, range.end, range.full);
    const statusKey = statusKeyForRange(range.start, range.end, range.full);
    const [cacheMeta, status] = await Promise.all([
      store.getMetadata(cacheKey),
      store.get(statusKey, { type: "json" })
    ]);
    const env = warehouseEnvStatus();
    const cacheExists = Boolean(cacheMeta);
    const effectiveStatus = cacheExists && status?.status === "error"
      ? { ...status, usableCache: true }
      : (status || { status: "idle" });
    return json({
      ok: cacheExists,
      env,
      cache: {
        exists: cacheExists,
        key: cacheKey,
        meta: cacheMeta || null
      },
      sync: effectiveStatus
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config = {
  path: "/api/posts/warehouse-health",
  method: ["GET"]
};
