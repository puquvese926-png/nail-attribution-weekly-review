const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  DEFAULT_DB_PATH,
  REQUIRED_PR_LABELS,
  buildLocalReviewCachePackage,
  dateKey
} = require("./local-review-cache-package.js");

const DEFAULT_LOG_DIR = "C:\\Users\\HP\\DataGripProjects\\weekly_review_cache_logs";
const DEFAULT_REPORT_PATH = path.join(DEFAULT_LOG_DIR, "pre-upload-validation-latest.json");
const DEFAULT_BASELINE_PATH = path.join(DEFAULT_LOG_DIR, "pre-upload-validation-baseline.json");

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function naturalWeekRange(date) {
  const base = startOfDay(date);
  const day = (base.getDay() + 6) % 7;
  const start = addDays(base, -day);
  return { start, end: addDays(start, 6) };
}

function expectedDelayedOffsiteWindow(today = new Date()) {
  return naturalWeekRange(addDays(startOfDay(today), -14));
}

function parseArgs(argv) {
  return {
    dbPath: readStringArg(argv, "--db-path") || process.env.LOCAL_REVIEW_DB_PATH || DEFAULT_DB_PATH,
    reportPath: readStringArg(argv, "--report-path") || DEFAULT_REPORT_PATH,
    baselinePath: readStringArg(argv, "--baseline-path") || DEFAULT_BASELINE_PATH,
    today: parseDateArg(readStringArg(argv, "--today")) || new Date(),
    minWideLatestRows: readNumberArg(argv, "--min-wide-latest-rows", 100),
    maxWarehouseAgeHours: readNumberArg(argv, "--max-warehouse-age-hours", 36),
    maxOffsiteAgeHours: readNumberArg(argv, "--max-offsite-age-hours", 192),
    maxPlatformMissingRate: readNumberArg(argv, "--max-platform-missing-rate", 0.05),
    maxPublishDateMissingRate: readNumberArg(argv, "--max-publish-date-missing-rate", 0.05),
    maxTitleAndLinkMissingRate: readNumberArg(argv, "--max-title-link-missing-rate", 0.2),
    maxDropRate: readNumberArg(argv, "--max-drop-rate", 0.5),
    maxGrowthRate: readNumberArg(argv, "--max-growth-rate", 2)
  };
}

function readStringArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

function readNumberArg(argv, name, fallback) {
  const raw = readStringArg(argv, name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} 必须是非负数字`);
  }
  return value;
}

function parseDateArg(raw) {
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error(`日期无效：${raw}`);
  return date;
}

function pushCheck(checks, name, ok, message, details = {}, severity = "error") {
  checks.push({ name, ok: Boolean(ok), severity, message, details });
}

function latestRun(db, kind) {
  try {
    return db.prepare(`
      SELECT *
      FROM sync_runs
      WHERE sync_type LIKE ?
      ORDER BY id DESC
      LIMIT 1
    `).get(`%:${kind}`) || null;
  } catch {
    return null;
  }
}

function hoursSince(value, now) {
  const time = Date.parse(value || "");
  if (Number.isNaN(time)) return Infinity;
  return (now.getTime() - time) / 36e5;
}

function missingStats(db) {
  return db.prepare(`
    WITH latest AS (
      SELECT w.*
      FROM warehouse_post_wide w
      JOIN (
        SELECT post_key, MAX(captured_at) AS captured_at
        FROM warehouse_post_wide
        GROUP BY post_key
      ) x ON x.post_key = w.post_key AND x.captured_at = w.captured_at
    )
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(TRIM(platform), '') = '' THEN 1 ELSE 0 END) AS missing_platform,
      SUM(CASE WHEN COALESCE(TRIM(publish_date), '') = '' THEN 1 ELSE 0 END) AS missing_publish_date,
      SUM(CASE WHEN COALESCE(TRIM(title), '') = '' AND COALESCE(TRIM(link), '') = '' THEN 1 ELSE 0 END) AS missing_title_and_link
    FROM latest
  `).get();
}

function countOffsiteRowsForWindow(db, window) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM offsite_rows
    WHERE review_start = ? AND review_end = ?
  `).get(window.start, window.end).count || 0);
}

function prLabelsForWindow(db, window) {
  return db.prepare(`
    SELECT label, has_data
    FROM offsite_pr_metrics
    WHERE review_start = ? AND review_end = ?
  `).all(window.start, window.end);
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ratioChanged(previous, current, maxDropRate, maxGrowthRate) {
  if (!Number.isFinite(previous) || previous <= 0) return false;
  const ratio = current / previous;
  return ratio < maxDropRate || ratio > maxGrowthRate;
}

function validateLocalReviewUpload(options = {}) {
  const opts = {
    ...parseArgs([]),
    ...options
  };
  const db = options.db || new DatabaseSync(opts.dbPath, { readOnly: true });
  const shouldClose = !options.db;
  const checks = [];
  const now = opts.today || new Date();
  const expectedWindow = expectedDelayedOffsiteWindow(now);
  const expected = {
    start: dateKey(expectedWindow.start),
    end: dateKey(expectedWindow.end)
  };

  try {
    const warehouseRun = latestRun(db, "warehouse");
    const offsiteRun = latestRun(db, "offsite");
    const warehouseAge = hoursSince(warehouseRun?.finished_at, now);
    const offsiteAge = hoursSince(offsiteRun?.finished_at, now);
    pushCheck(
      checks,
      "latest-warehouse-sync",
      warehouseRun?.status === "done" && warehouseAge <= opts.maxWarehouseAgeHours,
      warehouseRun
        ? `最近帖子数仓同步：${warehouseRun.status}，${warehouseAge.toFixed(1)} 小时前完成`
        : "未找到帖子数仓同步记录",
      { run: warehouseRun, maxAgeHours: opts.maxWarehouseAgeHours, ageHours: warehouseAge }
    );
    pushCheck(
      checks,
      "latest-offsite-sync",
      offsiteRun?.status === "done" && offsiteAge <= opts.maxOffsiteAgeHours,
      offsiteRun
        ? `最近站外/PR 同步：${offsiteRun.status}，${offsiteAge.toFixed(1)} 小时前完成`
        : "未找到站外/PR 同步记录",
      { run: offsiteRun, maxAgeHours: opts.maxOffsiteAgeHours, ageHours: offsiteAge }
    );

    const payload = buildLocalReviewCachePackage({ db, now });
    const summary = payload.summary;
    pushCheck(
      checks,
      "warehouse-wide-row-count",
      summary.warehouseWideLatestRows >= opts.minWideLatestRows,
      `待上传最新宽表帖子 ${summary.warehouseWideLatestRows} 行`,
      { minWideLatestRows: opts.minWideLatestRows, warehouseWideRows: summary.warehouseWideRows }
    );
    pushCheck(
      checks,
      "offsite-window",
      summary.offsiteRange?.start === expected.start && summary.offsiteRange?.end === expected.end,
      `站外窗口 ${summary.offsiteRange?.start || "N/A"} ~ ${summary.offsiteRange?.end || "N/A"}，期望 ${expected.start} ~ ${expected.end}`,
      { expected, actual: summary.offsiteRange }
    );

    const offsiteRowsForExpected = countOffsiteRowsForWindow(db, expected);
    const prRows = prLabelsForWindow(db, expected);
    const prLabels = new Set(prRows.map(row => row.label));
    const missingPrLabels = REQUIRED_PR_LABELS.filter(label => !prLabels.has(label));
    pushCheck(
      checks,
      "offsite-rows-present",
      offsiteRowsForExpected > 0,
      `期望复盘周站外明细 ${offsiteRowsForExpected} 行`,
      { expected, rows: offsiteRowsForExpected }
    );
    pushCheck(
      checks,
      "pr-cards-complete",
      missingPrLabels.length === 0,
      missingPrLabels.length ? `PR 卡片缺失：${missingPrLabels.join(", ")}` : "PR 三张卡齐全",
      { expected, required: REQUIRED_PR_LABELS, actual: Array.from(prLabels), rows: prRows }
    );

    const missing = missingStats(db);
    const total = Number(missing.total || 0);
    const rates = {
      platform: total ? Number(missing.missing_platform || 0) / total : 1,
      publishDate: total ? Number(missing.missing_publish_date || 0) / total : 1,
      titleAndLink: total ? Number(missing.missing_title_and_link || 0) / total : 1
    };
    pushCheck(
      checks,
      "required-field-missing-rate",
      rates.platform <= opts.maxPlatformMissingRate &&
        rates.publishDate <= opts.maxPublishDateMissingRate &&
        rates.titleAndLink <= opts.maxTitleAndLinkMissingRate,
      `关键字段缺失率 platform=${formatRate(rates.platform)} publish_date=${formatRate(rates.publishDate)} title+link=${formatRate(rates.titleAndLink)}`,
      {
        total,
        missing,
        rates,
        thresholds: {
          platform: opts.maxPlatformMissingRate,
          publishDate: opts.maxPublishDateMissingRate,
          titleAndLink: opts.maxTitleAndLinkMissingRate
        }
      }
    );

    pushCheck(
      checks,
      "upload-package-consistency",
      summary.uploadPosts === summary.warehousePosts &&
        summary.uploadOffsiteRows === offsiteRowsForExpected &&
        summary.uploadPrMetrics === REQUIRED_PR_LABELS.length,
      "本地上传包汇总与 SQLite 计数一致",
      {
        summary,
        expectedUploadPosts: summary.warehousePosts,
        expectedUploadOffsiteRows: offsiteRowsForExpected,
        expectedUploadPrMetrics: REQUIRED_PR_LABELS.length
      }
    );

    const baseline = readJsonIfExists(opts.baselinePath);
    if (baseline?.summary) {
      const changed = ["warehouseWideLatestRows", "uploadOffsiteRows"].filter(key =>
        ratioChanged(Number(baseline.summary[key]), Number(summary[key]), opts.maxDropRate, opts.maxGrowthRate)
      );
      pushCheck(
        checks,
        "data-volume-fluctuation",
        changed.length === 0,
        changed.length ? `数据量相对上次通过校验异常波动：${changed.join(", ")}` : "数据量相对上次通过校验未异常波动",
        { previous: baseline.summary, current: summary, maxDropRate: opts.maxDropRate, maxGrowthRate: opts.maxGrowthRate }
      );
    } else {
      pushCheck(
        checks,
        "data-volume-fluctuation",
        true,
        "未找到上次通过校验基线，本次通过后将写入基线",
        { baselinePath: opts.baselinePath },
        "info"
      );
    }

    const ok = checks.every(check => check.ok || check.severity !== "error");
    return {
      ok,
      generatedAt: new Date().toISOString(),
      dbPath: opts.dbPath,
      expectedOffsiteWindow: expected,
      summary,
      checks
    };
  } finally {
    if (shouldClose) db.close();
  }
}

function formatRate(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

function writeReport(filePath, report) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const report = validateLocalReviewUpload(opts);
  writeReport(opts.reportPath, report);
  if (report.ok) {
    writeReport(opts.baselinePath, report);
  }
  console.log(JSON.stringify({
    ok: report.ok,
    reportPath: opts.reportPath,
    baselinePath: opts.baselinePath,
    failedChecks: report.checks.filter(check => !check.ok && check.severity === "error").map(check => check.name),
    summary: report.summary
  }, null, 2));
  if (!report.ok) process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.message || error);
    process.exit(1);
  }
}

module.exports = {
  DEFAULT_BASELINE_PATH,
  DEFAULT_REPORT_PATH,
  expectedDelayedOffsiteWindow,
  parseArgs,
  validateLocalReviewUpload,
  writeReport
};
