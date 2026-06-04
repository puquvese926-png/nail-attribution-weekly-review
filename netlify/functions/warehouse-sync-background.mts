import { buildAndCacheWarehouseSource, cacheKeyForRange, getWarehouseStore, resolveCacheRange, resolveRequestRange, writeWarehouseStatus } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  const url = new URL(req.url);
  const statusRange = resolveCacheRange(url);
  try {
    await writeWarehouseStatus(statusRange, {
      ok: true,
      status: "running",
      startedAt: new Date().toISOString()
    });
    const range = await resolveRequestRange(url);
    const result = await buildAndCacheWarehouseSource(range);
    await writeWarehouseStatus(statusRange, {
      ok: true,
      status: "done",
      cacheKey: result.cacheKey,
      meta: result.metadata
    });
  } catch (error) {
    const cacheKey = cacheKeyForRange(statusRange.start, statusRange.end, statusRange.full);
    const cacheMeta = await getWarehouseStore().getMetadata(cacheKey);
    if (cacheMeta) {
      await writeWarehouseStatus(statusRange, {
        ok: true,
        status: "done",
        cacheKey,
        meta: cacheMeta.metadata || null,
        lastRefreshError: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
    await writeWarehouseStatus(statusRange, {
      ok: false,
      status: "error",
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
};

export const config = {
  path: "/api/posts/warehouse-sync-background",
  method: ["GET", "POST"]
};
