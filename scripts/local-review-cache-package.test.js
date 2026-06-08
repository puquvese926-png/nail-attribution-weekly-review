const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const {
  buildLocalReviewCachePackage,
  latestOffsiteWindow
} = require("./local-review-cache-package.js");

function createTestDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE warehouse_posts (
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
    CREATE TABLE warehouse_post_snapshots (
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
      PRIMARY KEY (post_key, captured_at)
    );
    CREATE TABLE warehouse_post_wide (
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
    CREATE TABLE offsite_rows (
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
    CREATE TABLE offsite_pr_metrics (
      review_start TEXT NOT NULL,
      review_end TEXT NOT NULL,
      label TEXT NOT NULL,
      value_text TEXT,
      format_type TEXT,
      has_data INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (review_start, review_end, label)
    );
  `);
  return db;
}

function seedWarehouse(db) {
  db.prepare(`
    INSERT INTO warehouse_posts (
      post_key, post_id, record_id, link, title, platform, channel_type, channel_name,
      owner, content_format, content_topic, featured_quality, product_line_1, product_line_2,
      collab_requirement, funnel_stage, content_source, viewers, sku_count, publish_date,
      project, project_key, project_links, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "instagram::p1",
    "p1",
    "r1",
    "https://example.com/p1",
    "Post 1",
    "instagram",
    "KOL",
    "instagram",
    "Owner",
    "视频",
    "Topic",
    "1",
    "Line 1",
    "Line 2",
    "",
    "认知",
    "source",
    100,
    2,
    "2026-05-18",
    "Project",
    "Project::Owner",
    1,
    "2026-06-05T00:00:00.000Z"
  );
  const snapshotStmt = db.prepare(`
    INSERT INTO warehouse_post_snapshots (
      post_key, captured_at, week_index, exposure, likes, comments, shares, saves, interaction, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  snapshotStmt.run("instagram::p1", "2026-06-04", 1, 1000, 10, 2, 3, 4, 19, "2026-06-05T00:00:00.000Z");
  snapshotStmt.run("instagram::p1", "2026-06-05", 2, 1500, 15, 4, 5, 6, 30, "2026-06-05T00:00:00.000Z");
  const wideStmt = db.prepare(`
    INSERT INTO warehouse_post_wide (
      post_key, captured_at, week_index, post_id, record_id, publish_date, platform,
      channel_type, channel_name, owner, project, project_key, project_links,
      product_line_1, product_line_2, content_topic, content_format, title, link,
      content_source, featured_quality, collab_requirement, funnel_stage, viewers,
      sku_count, exposure, likes, comments, shares, saves, interaction, source_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  wideStmt.run("instagram::p1", "2026-06-04", 1, "p1", "r1", "2026-05-18", "instagram", "KOL", "instagram", "Owner", "Project", "Project::Owner", 1, "Line 1", "Line 2", "Topic", "视频", "Post 1", "https://example.com/p1", "source", "1", "", "认知", 100, 2, 1000, 10, 2, 3, 4, 19, "2026-06-05T00:00:00.000Z");
  wideStmt.run("instagram::p1", "2026-06-05", 2, "p1", "r1", "2026-05-18", "instagram", "KOL", "instagram", "Owner", "Project", "Project::Owner", 1, "Line 1", "Line 2", "Topic", "视频", "Post 1", "https://example.com/p1", "source", "1", "", "认知", 100, 2, 1500, 15, 4, 5, 6, 30, "2026-06-05T00:00:00.000Z");
}

function seedOffsite(db) {
  db.prepare(`
    INSERT INTO offsite_rows (
      review_start, review_end, label, type, channel, site, metric,
      content_count, current_value, previous_value, last_year_value, interaction,
      exposure_share, source_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("2026-05-18", "2026-05-24", "独立站", "site", "DTC", "US", "sessions", 3, 1200, 1000, 900, 42, 1, "note", "2026-06-05T00:00:00.000Z");
  const prStmt = db.prepare(`
    INSERT INTO offsite_pr_metrics (
      review_start, review_end, label, value_text, format_type, has_data, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  prStmt.run("2026-05-18", "2026-05-24", "社交媒体提及量", "10", "", 1, "2026-06-05T00:00:00.000Z");
  prStmt.run("2026-05-18", "2026-05-24", "Media提及量", "5", "", 1, "2026-06-05T00:00:00.000Z");
  prStmt.run("2026-05-18", "2026-05-24", "SOV（Pending）", "12%", "pct", 1, "2026-06-05T00:00:00.000Z");
}

test("builds a Netlify-compatible full upload source from SQLite rows", () => {
  const db = createTestDb();
  try {
    seedWarehouse(db);
    seedOffsite(db);
    const payload = buildLocalReviewCachePackage({
      db,
      now: new Date("2026-06-05T12:00:00.000Z")
    });

    assert.equal(payload.ok, true);
    assert.equal(payload.source.posts.length, 1);
    assert.equal(payload.source.posts[0].postKey, "instagram::p1");
    assert.equal(payload.source.posts[0].snapshots.length, 2);
    assert.equal(payload.source.posts[0].snapshots[1].capturedAt, "2026-06-05");
    assert.equal(payload.source.posts[0].snapshots[1].exposure, 1500);
    assert.equal(payload.source.audit.source, "local-sqlite");
    assert.equal(payload.source.audit.packageKind, "warehouse_posts_full");
    assert.equal(payload.source.dtcSection.cacheRange.start, "2026-05-18");
    assert.equal(payload.source.dtcSection.rows.length, 1);
    assert.deepEqual(payload.source.dtcSection.prMetrics.map(metric => metric.label), [
      "社交媒体提及量",
      "Media提及量",
      "SOV（Pending）"
    ]);
    assert.equal(payload.summary.warehouseWideRows, 2);
    assert.equal(payload.summary.warehouseWideLatestRows, 1);
    assert.equal(payload.summary.uploadPosts, 1);
  } finally {
    db.close();
  }
});

test("latestOffsiteWindow uses the newest review_start/review_end across offsite tables", () => {
  const db = createTestDb();
  try {
    seedOffsite(db);
    db.prepare(`
      INSERT INTO offsite_pr_metrics (
        review_start, review_end, label, value_text, format_type, has_data, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("2026-05-25", "2026-05-31", "社交媒体提及量", "20", "", 1, "2026-06-05T00:00:00.000Z");

    assert.deepEqual(latestOffsiteWindow(db), {
      review_start: "2026-05-25",
      review_end: "2026-05-31"
    });
  } finally {
    db.close();
  }
});
