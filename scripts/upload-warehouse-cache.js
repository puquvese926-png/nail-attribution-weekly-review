const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  DEFAULT_DB_PATH,
  buildLocalReviewCachePackage
} = require("./local-review-cache-package.js");
const {
  DEFAULT_BASELINE_PATH,
  DEFAULT_REPORT_PATH,
  validateLocalReviewUpload,
  writeReport
} = require("./validate-local-review-upload.js");

const DEFAULT_CHUNK_SIZE = 750 * 1024;
const DEFAULT_NETLIFY_SITE_URL = "https://nail-attribution-console-demo.netlify.app";

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

function readStringArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

function parseUploadArgs(argv) {
  return {
    dbPath: readStringArg(argv, "--db-path") || process.env.LOCAL_REVIEW_DB_PATH || DEFAULT_DB_PATH,
    reportPath: readStringArg(argv, "--report-path") || DEFAULT_REPORT_PATH,
    baselinePath: readStringArg(argv, "--baseline-path") || DEFAULT_BASELINE_PATH
  };
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(payload?.error || `${options.method || "GET"} ${url} failed: ${response.status}`);
  }
  return payload;
}

function loadUploadToken(filePath) {
  if (process.env.WAREHOUSE_UPLOAD_TOKEN || !fs.existsSync(filePath)) return;
  const token = fs.readFileSync(filePath, "utf8").trim();
  if (token) process.env.WAREHOUSE_UPLOAD_TOKEN = token;
}

function runPreUploadValidation(args) {
  const report = validateLocalReviewUpload(args);
  writeReport(args.reportPath, report);
  if (report.ok) {
    writeReport(args.baselinePath, report);
    return report;
  }
  const failed = report.checks
    .filter(check => !check.ok && check.severity === "error")
    .map(check => check.name);
  throw new Error(`上传前校验未通过，已阻止上传：${failed.join(", ")}`);
}

async function main() {
  loadDotEnv(path.join(__dirname, "..", ".env.local"));
  loadUploadToken(path.join(__dirname, "..", ".warehouse-upload-token.local"));
  if (!process.env.NETLIFY_SITE_URL) process.env.NETLIFY_SITE_URL = DEFAULT_NETLIFY_SITE_URL;
  requiredEnv(["WAREHOUSE_UPLOAD_TOKEN"]);

  const args = parseUploadArgs(process.argv.slice(2));
  const validation = runPreUploadValidation(args);
  const payload = buildLocalReviewCachePackage({ dbPath: args.dbPath });
  const source = payload.source;
  const payloadText = JSON.stringify({ ok: true, source });
  const siteUrl = process.env.NETLIFY_SITE_URL.replace(/\/$/, "");
  const uploadId = `wh-${new Date().toISOString().replace(/[^0-9]/g, "")}-${crypto.randomBytes(4).toString("hex")}`;
  const chunkSize = Number(process.env.WAREHOUSE_UPLOAD_CHUNK_SIZE || DEFAULT_CHUNK_SIZE);
  const total = Math.ceil(payloadText.length / chunkSize);
  const auth = `Bearer ${process.env.WAREHOUSE_UPLOAD_TOKEN}`;

  console.log(`Pre-upload validation passed: ${args.reportPath}`);
  console.log(`Uploading local SQLite package from ${args.dbPath}`);
  console.log(`Uploading ${source.posts.length} posts, ${source.audit.totalRows} snapshot rows, ${total} chunks, range ${source.importMeta.range}`);
  console.log(`Offsite range: ${validation.summary.offsiteRange?.start || "N/A"} ~ ${validation.summary.offsiteRange?.end || "N/A"}`);

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

  const result = await requestJson(`${siteUrl}/api/posts/warehouse-upload-commit?full=1`, {
    method: "POST",
    headers: {
      "Authorization": auth,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ uploadId, total, mode: "replace" })
  });
  console.log(`Committed cache ${result.cacheKey}: ${JSON.stringify(result.meta)}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
