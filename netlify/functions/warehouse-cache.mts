import { cacheKeyForRange, getWarehouseStore, json, resolveCacheRange } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "GET") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    const url = new URL(req.url);
    const range = resolveCacheRange(url);
    const key = cacheKeyForRange(range.start, range.end, range.full);
    const store = getWarehouseStore();
    const metadata = await store.getMetadata(key);
    if (!metadata) {
      return json({ ok: false, error: "warehouse cache not found", cacheKey: key }, 404);
    }
    if (url.searchParams.get("meta") === "1") {
      return json({ ok: true, cacheKey: key, meta: metadata });
    }
    const stream = await store.get(key, { type: "stream" });
    if (!stream) {
      return json({ ok: false, error: "warehouse cache body not found", cacheKey: key }, 404);
    }
    return new Response(stream, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config = {
  path: "/api/posts/warehouse-cache",
  method: ["GET"]
};
