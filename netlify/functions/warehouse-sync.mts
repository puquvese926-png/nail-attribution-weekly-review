import { buildAndCacheWarehouseSource, json, resolveRequestRange } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    const url = new URL(req.url);
    const range = await resolveRequestRange(url);
    const result = await buildAndCacheWarehouseSource(range);
    return json({
      ok: true,
      status: "cached",
      cacheKey: result.cacheKey,
      meta: result.metadata
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config = {
  path: "/api/posts/warehouse-sync",
  method: ["GET", "POST"]
};
