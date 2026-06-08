const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const DEFAULT_PROJECT_DIR = "C:\\Users\\HP\\DataGripProjects\\数仓";
const DEFAULT_DB_PATH = path.join(DEFAULT_PROJECT_DIR, "local_cache", "weekly_review_cache.sqlite");
const REQUIRED_PR_LABELS = ["社交媒体提及量", "Media提及量", "SOV（Pending）"];

function dateKey(date) {
  if (!date) return "";
  const next = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(next.getTime())) return "";
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
}

function nowForMeta(now = new Date()) {
  return now.toLocaleString("zh-CN", { hour12: false });
}

function openDb(dbPath = DEFAULT_DB_PATH) {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`本地 SQLite 不存在：${dbPath}`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function buildWarehousePostsFromDb(db) {
  const posts = new Map();
  const postRows = db.prepare(`
    SELECT *
    FROM warehouse_posts
    ORDER BY publish_date DESC, post_key
  `).all();
  postRows.forEach(row => {
    const postKey = String(row.post_key || "").trim();
    if (!postKey) return;
    const id = row.record_id || row.post_id || `wh-${postKey.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`;
    posts.set(postKey, {
      id,
      postKey,
      postId: row.post_id || "",
      recordId: row.record_id || "",
      link: row.link || "",
      title: row.title || "",
      platform: row.platform || "",
      channelType: row.channel_type || "",
      channelName: row.channel_name || "",
      owner: row.owner || "",
      contentFormat: row.content_format || "",
      contentTopic: row.content_topic || "",
      featuredQuality: row.featured_quality || "",
      productLine1: row.product_line_1 || "",
      productLine2: row.product_line_2 || "",
      collabRequirement: row.collab_requirement || "",
      funnelStage: row.funnel_stage || "",
      contentSource: row.content_source || "",
      viewers: Number(row.viewers || 0),
      skuCount: Number(row.sku_count || 0),
      publishDate: row.publish_date || "",
      project: row.project || "",
      projectKey: row.project_key || "",
      projectLinks: Number(row.project_links || 0),
      snapshots: []
    });
  });
  const snapshotRows = db.prepare(`
    SELECT *
    FROM warehouse_post_snapshots
    ORDER BY post_key, captured_at
  `).all();
  snapshotRows.forEach(row => {
    const post = posts.get(String(row.post_key || "").trim());
    if (!post) return;
    post.snapshots.push({
      capturedAt: row.captured_at || "",
      weekIndex: Number(row.week_index || 1),
      exposure: Number(row.exposure || 0),
      likes: Number(row.likes || 0),
      comments: Number(row.comments || 0),
      shares: Number(row.shares || 0),
      saves: Number(row.saves || 0),
      interaction: Number(row.interaction || 0)
    });
  });
  return Array.from(posts.values()).filter(post => post.snapshots.length);
}

function latestOffsiteWindow(db) {
  const row = db.prepare(`
    SELECT review_start, review_end
    FROM offsite_rows
    UNION
    SELECT review_start, review_end
    FROM offsite_pr_metrics
    ORDER BY review_end DESC, review_start DESC
    LIMIT 1
  `).get();
  return row ? { review_start: row.review_start, review_end: row.review_end } : null;
}

function buildDtcSectionFromDb(db, window = latestOffsiteWindow(db), now = new Date()) {
  if (!window?.review_start || !window?.review_end) {
    return null;
  }
  const rows = db.prepare(`
    SELECT *
    FROM offsite_rows
    WHERE review_start = ? AND review_end = ?
    ORDER BY label, type, channel, site, metric
  `).all(window.review_start, window.review_end).map(row => ({
    label: row.label || "",
    type: row.type || "",
    channel: row.channel || "",
    site: row.site || "",
    metric: row.metric || "",
    contentCount: Number(row.content_count || 0),
    current: Number(row.current_value || 0),
    previous: Number(row.previous_value || 0),
    lastYear: Number(row.last_year_value || 0),
    interaction: Number(row.interaction || 0),
    exposureShare: Number(row.exposure_share || 0)
  }));
  const prRows = db.prepare(`
    SELECT *
    FROM offsite_pr_metrics
    WHERE review_start = ? AND review_end = ?
    ORDER BY CASE label
      WHEN '社交媒体提及量' THEN 1
      WHEN 'Media提及量' THEN 2
      WHEN 'SOV（Pending）' THEN 3
      ELSE 99
    END, label
  `).all(window.review_start, window.review_end);
  const byLabel = new Map(prRows.map(row => [row.label, row]));
  const prMetrics = REQUIRED_PR_LABELS.map(label => {
    const row = byLabel.get(label);
    return {
      label,
      value: row?.value_text || "",
      format: row?.format_type || "",
      hasData: Boolean(row?.has_data)
    };
  });
  const totalCurrent = rows.reduce((sum, row) => sum + Number(row.current || 0), 0);
  const totalPrevious = rows.reduce((sum, row) => sum + Number(row.previous || 0), 0);
  const totalLastYear = rows.reduce((sum, row) => sum + Number(row.lastYear || 0), 0);
  return {
    totalCurrent,
    totalPrevious,
    totalLastYear,
    rows,
    prMetrics,
    hasCurrentData: rows.length > 0,
    hasPreviousData: rows.some(row => Number(row.previous || 0) > 0),
    hasLastYearData: rows.some(row => Number(row.lastYear || 0) > 0),
    updatedAt: nowForMeta(now),
    cacheRange: {
      start: window.review_start,
      end: window.review_end
    },
    source: {
      type: "local-sqlite",
      note: "本地 SQLite 上传包；站外和 PR 指标来自 offsite_rows / offsite_pr_metrics。"
    }
  };
}

function tableExists(db, tableName) {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  return Boolean(row?.name);
}

function buildProductLineMasterFromDb(db) {
  if (!tableExists(db, "product_line_master")) return [];
  return db.prepare(`
    SELECT first_type, second_type, detail_type, msku_count, asin_count,
           first_order_date, product_planner, sku_operator_name
    FROM product_line_master
    ORDER BY first_type, second_type, detail_type
  `).all().map(row => ({
    firstType: row.first_type || "",
    secondType: row.second_type || "",
    detailType: row.detail_type || "",
    mskuCount: Number(row.msku_count || 0),
    asinCount: Number(row.asin_count || 0),
    firstOrderDate: row.first_order_date || "",
    productPlanner: row.product_planner || "",
    skuOperatorName: row.sku_operator_name || ""
  }));
}

function tableCount(db, tableName) {
  if (!tableExists(db, tableName)) return 0;
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get().count || 0);
}

function sourceSummary(db, posts, dtcSection, productLineMaster = []) {
  const capturedRange = db.prepare(`
    SELECT MIN(captured_at) AS start, MAX(captured_at) AS end
    FROM warehouse_post_wide
  `).get();
  const latestRows = db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT post_key
      FROM warehouse_post_wide
      GROUP BY post_key
    )
  `).get();
  return {
    warehousePosts: tableCount(db, "warehouse_posts"),
    warehouseSnapshots: tableCount(db, "warehouse_post_snapshots"),
    warehouseWideRows: tableCount(db, "warehouse_post_wide"),
    warehouseWideLatestRows: Number(latestRows?.count || 0),
    productLineMaster: productLineMaster.length,
    offsiteRows: tableCount(db, "offsite_rows"),
    offsitePrMetrics: tableCount(db, "offsite_pr_metrics"),
    uploadPosts: posts.length,
    uploadOffsiteRows: dtcSection?.rows?.length || 0,
    uploadPrMetrics: dtcSection?.prMetrics?.length || 0,
    capturedRange: {
      start: capturedRange?.start || "",
      end: capturedRange?.end || ""
    },
    offsiteRange: dtcSection?.cacheRange || null
  };
}

function buildLocalReviewCachePackage(options = {}) {
  const dbPath = options.dbPath || process.env.LOCAL_REVIEW_DB_PATH || DEFAULT_DB_PATH;
  const now = options.now || new Date();
  const db = options.db || openDb(dbPath);
  const shouldClose = !options.db;
  try {
    const posts = buildWarehousePostsFromDb(db);
    const productLineMaster = buildProductLineMasterFromDb(db);
    const range = db.prepare(`
      SELECT MIN(captured_at) AS start, MAX(captured_at) AS end
      FROM warehouse_post_wide
    `).get();
    const dtcSection = buildDtcSectionFromDb(db, options.offsiteWindow, now);
    const source = {
      posts,
      audit: {
        totalRows: tableCount(db, "warehouse_post_snapshots"),
        acceptedRows: posts.length,
        statDateRange: `${range?.start || ""} ~ ${range?.end || ""}`.trim(),
        source: "local-sqlite",
        packageKind: "warehouse_posts_full"
      },
      importMeta: {
        fileName: "本地 SQLite 上传包",
        savedAt: nowForMeta(now),
        source: "local-sqlite",
        range: `${range?.start || ""} ~ ${range?.end || ""}`.trim(),
        packageKind: "warehouse_posts_full"
      },
      reviewWeek: {
        dateRange: `${range?.start || ""} ~ ${range?.end || ""}`.trim()
      }
    };
    if (dtcSection) source.dtcSection = dtcSection;
    source.productLineMaster = productLineMaster;
    return {
      ok: true,
      source,
      summary: sourceSummary(db, posts, dtcSection, productLineMaster)
    };
  } finally {
    if (shouldClose) db.close();
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  REQUIRED_PR_LABELS,
  buildDtcSectionFromDb,
  buildLocalReviewCachePackage,
  buildProductLineMasterFromDb,
  buildWarehousePostsFromDb,
  dateKey,
  latestOffsiteWindow,
};
