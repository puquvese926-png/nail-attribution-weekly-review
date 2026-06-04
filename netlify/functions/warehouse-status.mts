import { getWarehouseStore, json, resolveCacheRange, statusKeyForRange } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "GET") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    const url = new URL(req.url);
    const range = resolveCacheRange(url);
    const key = statusKeyForRange(range.start, range.end, range.full);
    const status = await getWarehouseStore().get(key, { type: "json" });
    if (!status) {
      return json({ ok: true, status: "idle", cacheKey: key });
    }
    return json({ ok: true, cacheKey: key, ...status });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config = {
  path: "/api/posts/warehouse-status",
  method: ["GET"]
};
