import { buildAndCacheWarehouseSource, resolveRequestRange, writeWarehouseStatus } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  const url = new URL(req.url);
  let range = null;
  try {
    range = await resolveRequestRange(url);
    await writeWarehouseStatus(range, {
      ok: true,
      status: "running",
      startedAt: new Date().toISOString()
    });
    const result = await buildAndCacheWarehouseSource(range);
    await writeWarehouseStatus(range, {
      ok: true,
      status: "done",
      cacheKey: result.cacheKey,
      meta: result.metadata
    });
  } catch (error) {
    if (range) {
      await writeWarehouseStatus(range, {
        ok: false,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      });
    }
    throw error;
  }
};

export const config = {
  path: "/api/posts/warehouse-sync-background",
  method: ["GET", "POST"]
};
