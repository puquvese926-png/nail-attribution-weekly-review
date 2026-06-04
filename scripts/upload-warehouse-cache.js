const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  buildWarehousePosts,
  resolveWarehouseFullRange
} = require("../offsite-lark-sync-server.js");

const DEFAULT_CHUNK_SIZE = 750 * 1024;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  lines.forEach(line => {
    const text = line.trim();
    if (!text || text.startsWith("#")) return;
    const eq = text.indexOf("=");
    if (eq < 1) return;
    const key = text.slice(0, eq).trim();
    const value = text.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  });
}

function requiredEnv(keys) {
  const missing = keys.filter(key => !process.env[key]);
  if (missing.length) throw new Error(`缺少环境变量：${missing.join(", ")}`);
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `${options.method || "GET"} ${url} failed: ${response.status}`);
  }
  return payload;
}

async function main() {
  loadDotEnv(path.join(__dirname, "..", ".env.local"));
  loadUploadToken(path.join(__dirname, "..", ".warehouse-upload-token.local"));
  requiredEnv(["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD", "NETLIFY_SITE_URL", "WAREHOUSE_UPLOAD_TOKEN"]);

  const incremental = process.argv.includes("--incremental");
  const full = !incremental && (process.argv.includes("--full") || !process.argv.includes("--range"));
  const siteUrl = process.env.NETLIFY_SITE_URL.replace(/\/$/, "");
  const uploadId = `wh-${new Date().toISOString().replace(/[^0-9]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
  const chunkSize = Number(process.env.WAREHOUSE_UPLOAD_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const range = incremental
    ? incrementalRangeFromArgs()
    : full
    ? await resolveWarehouseFullRange({ env: process.env })
    : parseRangeFromArgs();
  const source = await buildWarehousePosts(range.start, range.end, { env: process.env });
  const payloadText = JSON.stringify({ ok: true, source });
  const total = Math.ceil(payloadText.length / chunkSize);
  const auth = `Bearer ${process.env.WAREHOUSE_UPLOAD_TOKEN}`;
  console.log(`Uploading ${source.posts.length} posts, ${source.audit.totalRows} rows, ${total} chunks, range ${source.importMeta.range}`);

  for (let index = 0; index < total; index += 1) {
    const chunk = payloadText.slice(index * chunkSize, (index + 1) * chunkSize);
    await requestJson(`${siteUrl}/api/posts/warehouse-upload-chunk`, {
      method: "POST",
      headers: {
        "Authorization": auth,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ uploadId, index, total, chunk })
    });
    console.log(`Uploaded chunk ${index + 1}/${total}`);
  }

  const mode = incremental ? "merge-full" : "replace";
  const commitUrl = `${siteUrl}/api/posts/warehouse-upload-commit?full=${full || incremental ? "1" : "0"}`;
  const result = await requestJson(commitUrl, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ uploadId, total, mode })
  });
  console.log(`Committed cache ${result.cacheKey}: ${JSON.stringify(result.meta)}`);
}

function incrementalRangeFromArgs() {
  const daysIndex = process.argv.indexOf("--days");
  const days = daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) : 14;
  if (!Number.isFinite(days) || days <= 0) throw new Error("--days 必须是正数");
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - days + 1);
  return { start, end };
}

function parseRangeFromArgs() {
  const startIndex = process.argv.indexOf("--start");
  const endIndex = process.argv.indexOf("--end");
  if (startIndex < 0 || endIndex < 0) throw new Error("指定 --range 时必须提供 --start YYYY-MM-DD --end YYYY-MM-DD");
  const start = new Date(process.argv[startIndex + 1]);
  const end = new Date(process.argv[endIndex + 1]);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("start/end 日期无效");
  }
  return { start, end };
}

function loadUploadToken(filePath) {
  if (process.env.WAREHOUSE_UPLOAD_TOKEN || !fs.existsSync(filePath)) return;
  const token = fs.readFileSync(filePath, "utf8").trim();
  if (token) process.env.WAREHOUSE_UPLOAD_TOKEN = token;
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
