import { assertUploadAuthorized, getWarehouseStore, json, uploadChunkKey } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    assertUploadAuthorized(req);
    const body = await req.json();
    const uploadId = String(body.uploadId || "");
    const index = Number(body.index);
    const total = Number(body.total);
    const chunk = typeof body.chunk === "string" ? body.chunk : "";
    if (!Number.isInteger(total) || total <= 0) throw new Error("缺少有效 chunk total");
    if (!chunk) throw new Error("缺少 chunk 内容");
    const key = uploadChunkKey(uploadId, index);
    await getWarehouseStore().set(key, chunk, {
      metadata: {
        uploadId,
        index: String(index),
        total: String(total),
        savedAt: new Date().toISOString()
      }
    });
    return json({ ok: true, uploadId, index, total, key });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

export const config = {
  path: "/api/posts/warehouse-upload-chunk",
  method: ["POST"]
};
