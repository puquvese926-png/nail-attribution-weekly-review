import { getStore } from "@netlify/blobs";
import mysql from "mysql2/promise";
import warehouseModule from "../../../offsite-lark-sync-server.js";

const { buildWarehousePosts, dateKey, parseDate, resolveWarehouseFullRange } = warehouseModule;

export const WAREHOUSE_CACHE_STORE = "weekly-dashboard-warehouse";
export const WAREHOUSE_ENV_KEYS = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"];
export const WAREHOUSE_UPLOAD_TOKEN_KEY = "WAREHOUSE_UPLOAD_TOKEN";

export function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export function getWarehouseStore() {
  return getStore({ name: WAREHOUSE_CACHE_STORE, consistency: "strong" });
}

export function warehouseEnv() {
  const env = {};
  WAREHOUSE_ENV_KEYS.forEach(key => {
    env[key] = globalThis.Netlify?.env?.get(key) || "";
  });
  return env;
}

export function warehouseEnvStatus() {
  const env = warehouseEnv();
  const present = {};
  WAREHOUSE_ENV_KEYS.forEach(key => {
    present[key] = Boolean(env[key]);
  });
  return {
    ok: WAREHOUSE_ENV_KEYS.every(key => present[key]),
    present,
    missing: WAREHOUSE_ENV_KEYS.filter(key => !present[key])
  };
}

export function assertUploadAuthorized(req) {
  const expected = globalThis.Netlify?.env?.get(WAREHOUSE_UPLOAD_TOKEN_KEY) || "";
  if (!expected) {
    throw new Error(`${WAREHOUSE_UPLOAD_TOKEN_KEY} 未配置，禁止写入缓存`);
  }
  const auth = req.headers.get("Authorization") || "";
  const provided = auth.replace(/^Bearer\s+/i, "").trim();
  if (provided !== expected) {
    throw new Error("上传鉴权失败");
  }
}

export function cacheKeyForRange(start, end, full) {
  if (full) return "posts/full.json";
  if (!start || !end) throw new Error("缺少有效 start/end 日期");
  return `posts/${dateKey(start)}_${dateKey(end)}.json`;
}

export function statusKeyForRange(start, end, full) {
  if (full) return "status/full.json";
  if (!start || !end) throw new Error("缺少有效 start/end 日期");
  return `status/${dateKey(start)}_${dateKey(end)}.json`;
}

export function resolveCacheRange(url) {
  const full = url.searchParams.get("full") === "1" || url.searchParams.get("full") === "true";
  if (full) return { start: null, end: null, full };
  const start = parseDate(url.searchParams.get("start"));
  const end = parseDate(url.searchParams.get("end"));
  if (!start || !end) throw new Error("缺少有效 start/end 日期");
  return { start, end, full };
}

export async function resolveRequestRange(url) {
  const full = url.searchParams.get("full") === "1" || url.searchParams.get("full") === "true";
  if (full) {
    const range = await resolveWarehouseFullRange({ env: warehouseEnv(), mysql });
    return { ...range, full };
  }
  const start = parseDate(url.searchParams.get("start"));
  const end = parseDate(url.searchParams.get("end"));
  if (!start || !end) throw new Error("缺少有效 start/end 日期");
  return { start, end, full };
}

export async function buildAndCacheWarehouseSource(range) {
  const source = await buildWarehousePosts(range.start, range.end, { env: warehouseEnv(), mysql });
  const key = cacheKeyForRange(range.start, range.end, range.full);
  const savedAt = new Date().toISOString();
  const body = JSON.stringify({ ok: true, source });
  const metadata = {
    savedAt,
    range: source.importMeta?.range || `${dateKey(range.start)} ~ ${dateKey(range.end)}`,
    posts: String(source.posts?.length || 0),
    rows: String(source.audit?.totalRows || 0),
    acceptedRows: String(source.audit?.acceptedRows || 0),
    full: range.full ? "1" : "0"
  };
  await getWarehouseStore().set(key, body, { metadata });
  return {
    cacheKey: key,
    metadata
  };
}

export async function writeWarehouseStatus(range, status) {
  const key = statusKeyForRange(range.start, range.end, range.full);
  await getWarehouseStore().setJSON(key, {
    ...status,
    updatedAt: new Date().toISOString()
  });
  return key;
}

export function uploadChunkKey(uploadId, index) {
  const safeId = String(uploadId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!safeId) throw new Error("缺少有效 uploadId");
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0) throw new Error("缺少有效 chunk index");
  return `uploads/${safeId}/${String(n).padStart(5, "0")}.txt`;
}
