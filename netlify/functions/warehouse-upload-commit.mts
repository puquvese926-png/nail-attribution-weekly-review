import { assertUploadAuthorized, cacheKeyForRange, getWarehouseStore, json, resolveCacheRange, uploadChunkKey, writeWarehouseStatus } from "./_shared/warehouse-api.mjs";

export default async (req: Request) => {
  if (req.method !== "POST") {
    return json({ ok: false, error: "method not allowed" }, 405);
  }
  try {
    assertUploadAuthorized(req);
    const url = new URL(req.url);
    const range = resolveCacheRange(url);
    const body = await req.json();
    const uploadId = String(body.uploadId || "");
    const total = Number(body.total);
    if (!Number.isInteger(total) || total <= 0) throw new Error("缺少有效 chunk total");
    const store = getWarehouseStore();
    const chunks = [];
    for (let index = 0; index < total; index += 1) {
      const chunk = await store.get(uploadChunkKey(uploadId, index));
      if (chunk == null) throw new Error(`缺少分片 ${index + 1}/${total}`);
      chunks.push(chunk);
    }
    const payloadText = chunks.join("");
    const payload = JSON.parse(payloadText);
    if (!payload?.ok || !payload.source || !Array.isArray(payload.source.posts)) {
      throw new Error("上传内容不是有效的数仓帖子缓存");
    }
    const source = payload.source;
    const mode = String(body.mode || "replace");
    const targetFull = mode === "merge-full" || range.full;
    const key = targetFull ? cacheKeyForRange(null, null, true) : cacheKeyForRange(range.start, range.end, range.full);
    let outputPayloadText = payloadText;
    let outputSource = source;
    if (mode === "merge-full") {
      const existingText = await store.get(key);
      if (!existingText) throw new Error("增量合并需要先存在全量缓存，请先跑一次 --full");
      const existingPayload = JSON.parse(existingText);
      if (!existingPayload?.source || !Array.isArray(existingPayload.source.posts)) {
        throw new Error("现有全量缓存结构无效，无法增量合并");
      }
      outputSource = mergeWarehouseSources(existingPayload.source, source);
      outputPayloadText = JSON.stringify({ ok: true, source: outputSource });
    }
    const metadata = {
      savedAt: new Date().toISOString(),
      range: outputSource.importMeta?.range || outputSource.audit?.statDateRange || "",
      posts: String(outputSource.posts?.length || 0),
      rows: String(outputSource.audit?.totalRows || 0),
      acceptedRows: String(outputSource.audit?.acceptedRows || 0),
      full: targetFull ? "1" : "0",
      source: "local-upload",
      mode,
      uploadId
    };
    await store.set(key, outputPayloadText, { metadata });
    await writeWarehouseStatus(targetFull ? { start: null, end: null, full: true } : range, {
      ok: true,
      status: "done",
      cacheKey: key,
      meta: metadata,
      source: "local-upload"
    });
    for (let index = 0; index < total; index += 1) {
      await store.delete(uploadChunkKey(uploadId, index));
    }
    return json({ ok: true, cacheKey: key, meta: metadata });
  } catch (error) {
    return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 500);
  }
};

function mergeWarehouseSources(base, delta) {
  const posts = new Map();
  (base.posts || []).forEach(post => posts.set(postIdentity(post), clonePost(post)));
  (delta.posts || []).forEach(post => {
    const key = postIdentity(post);
    const existing = posts.get(key);
    if (!existing) {
      posts.set(key, clonePost(post));
      return;
    }
    Object.assign(existing, { ...post, snapshots: existing.snapshots || [] });
    const snapshots = new Map();
    (existing.snapshots || []).forEach(snapshot => snapshots.set(snapshot.capturedAt, { ...snapshot }));
    (post.snapshots || []).forEach(snapshot => snapshots.set(snapshot.capturedAt, { ...snapshot }));
    existing.snapshots = Array.from(snapshots.values())
      .sort((a, b) => String(a.capturedAt).localeCompare(String(b.capturedAt)))
      .map((snapshot, index) => ({ ...snapshot, weekIndex: index + 1 }));
    posts.set(key, existing);
  });
  const mergedPosts = Array.from(posts.values());
  const baseRange = base.importMeta?.range || "";
  const deltaRange = delta.importMeta?.range || "";
  return {
    ...base,
    ...delta,
    posts: mergedPosts,
    audit: {
      ...(base.audit || {}),
      ...(delta.audit || {}),
      totalRows: Math.max(Number(base.audit?.totalRows || 0), Number(delta.audit?.totalRows || 0)),
      acceptedRows: mergedPosts.length,
      source: "warehouse-local-upload",
      mergeMode: "incremental",
      lastDeltaRange: deltaRange,
      lastDeltaRows: Number(delta.audit?.totalRows || 0)
    },
    importMeta: {
      ...(base.importMeta || {}),
      ...(delta.importMeta || {}),
      fileName: "数仓本地增量同步",
      savedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      source: "warehouse-local-upload",
      range: baseRange || deltaRange,
      lastDeltaRange: deltaRange
    }
  };
}

function clonePost(post) {
  return {
    ...post,
    snapshots: (post.snapshots || []).map(snapshot => ({ ...snapshot }))
  };
}

function postIdentity(post) {
  return String(post.id || post.link || `${post.platform || ""}:${post.title || ""}:${post.publishDate || ""}`);
}

export const config = {
  path: "/api/posts/warehouse-upload-commit",
  method: ["POST"]
};
