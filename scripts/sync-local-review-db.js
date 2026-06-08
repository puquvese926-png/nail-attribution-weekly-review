const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const {
  buildDtcSection,
  buildWarehousePosts,
  dateKey,
  parseDate,
  resolveWarehouseFullRange
} = require("../offsite-lark-sync-server.js");

const DEFAULT_PROJECT_DIR = "C:\\Users\\HP\\DataGripProjects\\数仓";
const DEFAULT_DB_PATH = path.join(DEFAULT_PROJECT_DIR, "local_cache", "weekly_review_cache.sqlite");
const DEFAULT_INCREMENTAL_LOOKBACK_DAYS = 35;
const DEFAULT_FULL_OFFSITE_WEEKS = 12;
const DEFAULT_INCREMENTAL_OFFSITE_WEEKS = 4;

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

function parseArgs(argv) {
  const args = {
    full: argv.includes("--full"),
    incremental: argv.includes("--incremental"),
    warehouseOnly: argv.includes("--warehouse-only"),
    offsiteOnly: argv.includes("--offsite-only"),
    lookbackDays: readNumberArg(argv, "--lookback-days"),
    offsiteWeeks: readNumberArg(argv, "--offsite-weeks"),
    dbPath: readStringArg(argv, "--db-path") || process.env.LOCAL_REVIEW_DB_PATH || DEFAULT_DB_PATH
  };
  if (!args.full && !args.incremental) args.incremental = true;
  if (args.full && args.incremental) args.incremental = false;
  if (args.warehouseOnly && args.offsiteOnly) {
    throw new Error("--warehouse-only 和 --offsite-only 不能同时使用");
  }
  return args;
}

function readStringArg(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : "";
}

function readNumberArg(argv, name) {
  const raw = readStringArg(argv, name);
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} 必须是正数`);
  }
  return value;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function naturalWeekRange(date) {
  const base = startOfDay(date);
  const day = (base.getDay() + 6) % 7;
  const start = addDays(base, -day);
  return { start, end: addDays(start, 6) };
}

function delayedOffsiteAnchorWeek(anchorDate) {
  return naturalWeekRange(addDays(anchorDate, -14));
}

function offsiteWindows(count, anchorDate) {
  const latest = delayedOffsiteAnchorWeek(anchorDate);
  return Array.from({ length: count }, (_, index) => {
    const start = addDays(latest.start, -7 * index);
    return { start, end: addDays(start, 6) };
  });
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function ensureSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      status TEXT NOT NULL,
      warehouse_range_start TEXT,
      warehouse_range_end TEXT,
      offsite_anchor_start TEXT,
      offsite_anchor_end TEXT,
      offsite_weeks INTEGER NOT NULL DEFAULT 0,
      posts_count INTEGER NOT NULL DEFAULT 0,
      snapshots_count INTEGER NOT NULL DEFAULT 0,
      offsite_rows_count INTEGER NOT NULL DEFAULT 0,
      offsite_pr_count INTEGER NOT NULL DEFAULT 0,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS warehouse_posts (
      post_key TEXT PRIMARY KEY,
      post_id TEXT,
      record_id TEXT,
      link TEXT,
      title TEXT,
      platform TEXT,
      channel_type TEXT,
      channel_name TEXT,
      owner TEXT,
      content_format TEXT,
      content_topic TEXT,
      featured_quality TEXT,
      product_line_1 TEXT,
      product_line_2 TEXT,
      collab_requirement TEXT,
      funnel_stage TEXT,
      content_source TEXT,
      viewers REAL,
      sku_count REAL,
      publish_date TEXT,
      project TEXT,
      project_key TEXT,
      project_links INTEGER,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS warehouse_post_snapshots (
      post_key TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      week_index INTEGER,
      exposure REAL,
      likes REAL,
      comments REAL,
      shares REAL,
      saves REAL,
      interaction REAL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (post_key, captured_at),
      FOREIGN KEY (post_key) REFERENCES warehouse_posts(post_key) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS warehouse_post_wide (
      post_key TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      week_index INTEGER,
      post_id TEXT,
      record_id TEXT,
      publish_date TEXT,
      platform TEXT,
      channel_type TEXT,
      channel_name TEXT,
      owner TEXT,
      project TEXT,
      project_key TEXT,
      project_links INTEGER,
      product_line_1 TEXT,
      product_line_2 TEXT,
      content_topic TEXT,
      content_format TEXT,
      title TEXT,
      link TEXT,
      content_source TEXT,
      featured_quality TEXT,
      collab_requirement TEXT,
      funnel_stage TEXT,
      viewers REAL,
      sku_count REAL,
      exposure REAL,
      likes REAL,
      comments REAL,
      shares REAL,
      saves REAL,
      interaction REAL,
      source_updated_at TEXT NOT NULL,
      PRIMARY KEY (post_key, captured_at)
    );

    CREATE TABLE IF NOT EXISTS post_notes (
      post_key TEXT PRIMARY KEY,
      post_title TEXT,
      post_link TEXT,
      note TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS product_line_master (
      first_type TEXT NOT NULL,
      second_type TEXT NOT NULL DEFAULT '',
      detail_type TEXT NOT NULL DEFAULT '',
      msku_count REAL,
      asin_count REAL,
      first_order_date TEXT,
      product_planner TEXT,
      sku_operator_name TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (first_type, second_type, detail_type)
    );

    CREATE INDEX IF NOT EXISTS idx_warehouse_posts_publish_date ON warehouse_posts(publish_date);
    CREATE INDEX IF NOT EXISTS idx_warehouse_posts_platform ON warehouse_posts(platform);
    CREATE INDEX IF NOT EXISTS idx_warehouse_post_snapshots_captured_at ON warehouse_post_snapshots(captured_at);
    CREATE INDEX IF NOT EXISTS idx_warehouse_post_wide_publish_date ON warehouse_post_wide(publish_date);
    CREATE INDEX IF NOT EXISTS idx_warehouse_post_wide_platform ON warehouse_post_wide(platform);
    CREATE INDEX IF NOT EXISTS idx_warehouse_post_wide_captured_at ON warehouse_post_wide(captured_at);
    CREATE INDEX IF NOT EXISTS idx_product_line_master_first_type ON product_line_master(first_type);

    CREATE TABLE IF NOT EXISTS offsite_rows (
      review_start TEXT NOT NULL,
      review_end TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT,
      channel TEXT,
      site TEXT,
      metric TEXT,
      content_count REAL,
      current_value REAL,
      previous_value REAL,
      last_year_value REAL,
      interaction REAL,
      exposure_share REAL,
      source_note TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (review_start, review_end, label, type, channel, site, metric)
    );

    CREATE TABLE IF NOT EXISTS offsite_pr_metrics (
      review_start TEXT NOT NULL,
      review_end TEXT NOT NULL,
      label TEXT NOT NULL,
      value_text TEXT,
      format_type TEXT,
      has_data INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (review_start, review_end, label)
    );

    CREATE VIEW IF NOT EXISTS v_warehouse_post_daily AS
    SELECT
      s.captured_at,
      s.week_index,
      p.publish_date,
      p.platform,
      p.channel_type,
      p.channel_name,
      p.owner,
      p.project,
      p.product_line_1,
      p.product_line_2,
      p.content_topic,
      p.content_format,
      p.title,
      p.link,
      p.content_source,
      p.featured_quality,
      s.exposure,
      s.likes,
      s.comments,
      s.shares,
      s.saves,
      s.interaction,
      p.post_key,
      p.post_id
    FROM warehouse_post_snapshots s
    JOIN warehouse_posts p ON p.post_key = s.post_key;

    CREATE VIEW IF NOT EXISTS v_offsite_latest_rows AS
    SELECT r.*
    FROM offsite_rows r
    JOIN (
      SELECT review_start, review_end
      FROM offsite_rows
      ORDER BY review_end DESC, review_start DESC
      LIMIT 1
    ) latest
      ON latest.review_start = r.review_start
     AND latest.review_end = r.review_end;
  `);
}

function warehouseHasData(db) {
  const row = db.prepare("SELECT COUNT(*) AS count FROM warehouse_post_snapshots").get();
  return Number(row?.count || 0) > 0;
}

function incrementalWarehouseRange(lookbackDays) {
  const anchor = addDays(startOfDay(new Date()), -1);
  return {
    start: addDays(anchor, -lookbackDays + 1),
    end: anchor
  };
}

async function resolveWarehouseRange(db, args) {
  if (args.full || !warehouseHasData(db)) {
    return resolveWarehouseFullRange({ env: process.env });
  }
  return incrementalWarehouseRange(args.lookbackDays || DEFAULT_INCREMENTAL_LOOKBACK_DAYS);
}

function beginRun(db, syncType, warehouseRange, offsiteWindowList) {
  const stmt = db.prepare(`
    INSERT INTO sync_runs (
      sync_type, status, warehouse_range_start, warehouse_range_end,
      offsite_anchor_start, offsite_anchor_end, offsite_weeks, started_at
    ) VALUES (?, 'running', ?, ?, ?, ?, ?, ?)
  `);
  const anchor = offsiteWindowList[0] || { start: null, end: null };
  const result = stmt.run(
    syncType,
    warehouseRange?.start ? dateKey(warehouseRange.start) : null,
    warehouseRange?.end ? dateKey(warehouseRange.end) : null,
    anchor.start ? dateKey(anchor.start) : null,
    anchor.end ? dateKey(anchor.end) : null,
    offsiteWindowList.length,
    nowIso()
  );
  return Number(result.lastInsertRowid);
}

function finishRun(db, runId, status, stats = {}, errorText = "") {
  db.prepare(`
    UPDATE sync_runs
    SET status = ?,
        posts_count = ?,
        snapshots_count = ?,
        offsite_rows_count = ?,
        offsite_pr_count = ?,
        finished_at = ?,
        error_text = ?
    WHERE id = ?
  `).run(
    status,
    Number(stats.postsCount || 0),
    Number(stats.snapshotsCount || 0),
    Number(stats.offsiteRowsCount || 0),
    Number(stats.offsitePrCount || 0),
    nowIso(),
    errorText || null,
    runId
  );
}

function upsertWarehouse(db, source) {
  const postStmt = db.prepare(`
    INSERT INTO warehouse_posts (
      post_key, post_id, record_id, link, title, platform, channel_type, channel_name,
      owner, content_format, content_topic, featured_quality, product_line_1, product_line_2,
      collab_requirement, funnel_stage, content_source, viewers, sku_count, publish_date,
      project, project_key, project_links, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_key) DO UPDATE SET
      post_id = excluded.post_id,
      record_id = excluded.record_id,
      link = excluded.link,
      title = excluded.title,
      platform = excluded.platform,
      channel_type = excluded.channel_type,
      channel_name = excluded.channel_name,
      owner = excluded.owner,
      content_format = excluded.content_format,
      content_topic = excluded.content_topic,
      featured_quality = excluded.featured_quality,
      product_line_1 = excluded.product_line_1,
      product_line_2 = excluded.product_line_2,
      collab_requirement = excluded.collab_requirement,
      funnel_stage = excluded.funnel_stage,
      content_source = excluded.content_source,
      viewers = excluded.viewers,
      sku_count = excluded.sku_count,
      publish_date = excluded.publish_date,
      project = excluded.project,
      project_key = excluded.project_key,
      project_links = excluded.project_links,
      updated_at = excluded.updated_at
  `);
  const snapshotStmt = db.prepare(`
    INSERT INTO warehouse_post_snapshots (
      post_key, captured_at, week_index, exposure, likes, comments, shares, saves, interaction, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(post_key, captured_at) DO UPDATE SET
      week_index = excluded.week_index,
      exposure = excluded.exposure,
      likes = excluded.likes,
      comments = excluded.comments,
      shares = excluded.shares,
      saves = excluded.saves,
      interaction = excluded.interaction,
      updated_at = excluded.updated_at
  `);
  const updatedAt = nowIso();
  let snapshotCount = 0;

  db.exec("BEGIN");
  try {
    source.posts.forEach(post => {
      const postKey = String(post.postKey || "").trim();
      if (!postKey) {
        throw new Error(`帖子缺少原始 postKey，无法写入本地库：${post.id || post.title || "unknown"}`);
      }
      postStmt.run(
        postKey,
        post.postId || "",
        post.id || "",
        post.link || "",
        post.title || "",
        post.platform || "",
        post.channelType || "",
        post.channelName || "",
        post.owner || "",
        post.contentFormat || "",
        post.contentTopic || "",
        post.featuredQuality || "",
        post.productLine1 || "",
        post.productLine2 || "",
        post.collabRequirement || "",
        post.funnelStage || "",
        post.contentSource || "",
        Number(post.viewers || 0),
        Number(post.skuCount || 0),
        post.publishDate || "",
        post.project || "",
        post.projectKey || "",
        Number(post.projectLinks || 0),
        updatedAt
      );
      post.snapshots.forEach(snapshot => {
        snapshotStmt.run(
          postKey,
          snapshot.capturedAt,
          Number(snapshot.weekIndex || 0),
          Number(snapshot.exposure || 0),
          Number(snapshot.likes || 0),
          Number(snapshot.comments || 0),
          Number(snapshot.shares || 0),
          Number(snapshot.saves || 0),
          Number(snapshot.interaction || 0),
          updatedAt
        );
        snapshotCount += 1;
      });
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return { postsCount: source.posts.length, snapshotsCount: snapshotCount };
}

function rebuildWarehouseWideTable(db) {
  const updatedAt = nowIso();
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM warehouse_post_wide");
    db.prepare(`
      INSERT INTO warehouse_post_wide (
        post_key, captured_at, week_index, post_id, record_id, publish_date, platform,
        channel_type, channel_name, owner, project, project_key, project_links,
        product_line_1, product_line_2, content_topic, content_format, title, link,
        content_source, featured_quality, collab_requirement, funnel_stage, viewers,
        sku_count, exposure, likes, comments, shares, saves, interaction, source_updated_at
      )
      SELECT
        p.post_key,
        s.captured_at,
        s.week_index,
        p.post_id,
        p.record_id,
        p.publish_date,
        p.platform,
        p.channel_type,
        p.channel_name,
        p.owner,
        p.project,
        p.project_key,
        p.project_links,
        p.product_line_1,
        p.product_line_2,
        p.content_topic,
        p.content_format,
        p.title,
        p.link,
        p.content_source,
        p.featured_quality,
        p.collab_requirement,
        p.funnel_stage,
        p.viewers,
        p.sku_count,
        s.exposure,
        s.likes,
        s.comments,
        s.shares,
        s.saves,
        s.interaction,
        ?
      FROM warehouse_post_snapshots s
      JOIN warehouse_posts p ON p.post_key = s.post_key
    `).run(updatedAt);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceProductLineMaster(db, rows = []) {
  const updatedAt = nowIso();
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM product_line_master");
    const stmt = db.prepare(`
      INSERT INTO product_line_master (
        first_type, second_type, detail_type, msku_count, asin_count,
        first_order_date, product_planner, sku_operator_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(first_type, second_type, detail_type) DO UPDATE SET
        msku_count = excluded.msku_count,
        asin_count = excluded.asin_count,
        first_order_date = excluded.first_order_date,
        product_planner = excluded.product_planner,
        sku_operator_name = excluded.sku_operator_name,
        updated_at = excluded.updated_at
    `);
    rows.forEach(row => {
      const firstType = String(row.firstType || row.first_type || "").trim();
      if (!firstType) return;
      stmt.run(
        firstType,
        String(row.secondType || row.second_type || "").trim(),
        String(row.detailType || row.detail_type || "").trim(),
        Number(row.mskuCount || row.msku_count || 0),
        Number(row.asinCount || row.asin_count || 0),
        String(row.firstOrderDate || row.first_order_date || ""),
        String(row.productPlanner || row.product_planner || ""),
        String(row.skuOperatorName || row.sku_operator_name || ""),
        updatedAt
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceOffsiteWindow(db, window, dtcSection) {
  const updatedAt = nowIso();
  const reviewStart = dateKey(window.start);
  const reviewEnd = dateKey(window.end);
  const deleteRowsStmt = db.prepare("DELETE FROM offsite_rows WHERE review_start = ? AND review_end = ?");
  const deletePrStmt = db.prepare("DELETE FROM offsite_pr_metrics WHERE review_start = ? AND review_end = ?");
  const rowStmt = db.prepare(`
    INSERT INTO offsite_rows (
      review_start, review_end, label, type, channel, site, metric,
      content_count, current_value, previous_value, last_year_value, interaction,
      exposure_share, source_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const prStmt = db.prepare(`
    INSERT INTO offsite_pr_metrics (
      review_start, review_end, label, value_text, format_type, has_data, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN");
  try {
    deleteRowsStmt.run(reviewStart, reviewEnd);
    deletePrStmt.run(reviewStart, reviewEnd);
    dtcSection.rows.forEach(row => {
      rowStmt.run(
        reviewStart,
        reviewEnd,
        row.label || "",
        row.type || "",
        row.channel || "",
        row.site || "",
        row.metric || "",
        Number(row.contentCount || 0),
        Number(row.current || 0),
        Number(row.previous || 0),
        Number(row.lastYear || 0),
        Number(row.interaction || 0),
        Number(row.exposureShare || 0),
        dtcSection.source?.note || "",
        updatedAt
      );
    });
    dtcSection.prMetrics.forEach(metric => {
      prStmt.run(
        reviewStart,
        reviewEnd,
        metric.label || "",
        metric.value == null ? "" : String(metric.value),
        metric.format || "",
        metric.hasData ? 1 : 0,
        updatedAt
      );
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  return {
    rowCount: dtcSection.rows.length,
    prCount: dtcSection.prMetrics.length
  };
}

async function syncOffsiteWindows(db, windows, options = {}) {
  let offsiteRowsCount = 0;
  let offsitePrCount = 0;
  if (options.replaceAll) {
    db.exec("DELETE FROM offsite_rows; DELETE FROM offsite_pr_metrics;");
  }
  for (const window of windows) {
    const dtcSection = await buildDtcSection(window.start, window.end);
    const stats = replaceOffsiteWindow(db, window, dtcSection);
    offsiteRowsCount += stats.rowCount;
    offsitePrCount += stats.prCount;
  }
  return { offsiteRowsCount, offsitePrCount };
}

function summaryRow(db) {
  return {
    posts: Number(db.prepare("SELECT COUNT(*) AS count FROM warehouse_posts").get().count || 0),
    snapshots: Number(db.prepare("SELECT COUNT(*) AS count FROM warehouse_post_snapshots").get().count || 0),
    wideRows: Number(db.prepare("SELECT COUNT(*) AS count FROM warehouse_post_wide").get().count || 0),
    productLineMaster: Number(db.prepare("SELECT COUNT(*) AS count FROM product_line_master").get().count || 0),
    offsiteRows: Number(db.prepare("SELECT COUNT(*) AS count FROM offsite_rows").get().count || 0),
    offsitePr: Number(db.prepare("SELECT COUNT(*) AS count FROM offsite_pr_metrics").get().count || 0)
  };
}

function resolveRunKind(args) {
  if (args.warehouseOnly) return "warehouse";
  if (args.offsiteOnly) return "offsite";
  return "combined";
}

async function main() {
  loadDotEnv(path.join(__dirname, "..", ".env.local"));
  const args = parseArgs(process.argv.slice(2));
  ensureDir(path.dirname(args.dbPath));
  const db = new DatabaseSync(args.dbPath);
  ensureSchema(db);

  const runKind = resolveRunKind(args);
  const shouldSyncWarehouse = runKind !== "offsite";
  const shouldSyncOffsite = runKind !== "warehouse";
  const warehouseRange = shouldSyncWarehouse ? await resolveWarehouseRange(db, args) : null;
  const offsiteWeeks = args.offsiteWeeks || (args.full ? DEFAULT_FULL_OFFSITE_WEEKS : DEFAULT_INCREMENTAL_OFFSITE_WEEKS);
  const offsiteWindowList = shouldSyncOffsite ? offsiteWindows(offsiteWeeks, startOfDay(new Date())) : [];
  const syncType = `${args.full ? "full" : "incremental"}:${runKind}`;
  const runId = beginRun(db, syncType, warehouseRange, offsiteWindowList);

  try {
    let warehouseStats = { postsCount: 0, snapshotsCount: 0 };
    let offsiteStats = { offsiteRowsCount: 0, offsitePrCount: 0 };

    if (shouldSyncWarehouse) {
      const source = await buildWarehousePosts(warehouseRange.start, warehouseRange.end, { env: process.env });
      warehouseStats = upsertWarehouse(db, source);
      replaceProductLineMaster(db, source.productLineMaster || []);
      rebuildWarehouseWideTable(db);
    }

    if (shouldSyncOffsite) {
      offsiteStats = await syncOffsiteWindows(db, offsiteWindowList, { replaceAll: args.full });
    }

    finishRun(db, runId, "done", { ...warehouseStats, ...offsiteStats });
    const totals = summaryRow(db);
    console.log(JSON.stringify({
      ok: true,
      mode: args.full ? "full" : "incremental",
      runKind,
      dbPath: args.dbPath,
      warehouseRange: warehouseRange ? {
        start: dateKey(warehouseRange.start),
        end: dateKey(warehouseRange.end)
      } : null,
      offsiteWindows: offsiteWindowList.map(window => ({
        start: dateKey(window.start),
        end: dateKey(window.end)
      })),
      totals
    }, null, 2));
  } catch (error) {
    finishRun(db, runId, "error", {}, error.message || String(error));
    throw error;
  } finally {
    db.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exit(1);
});
