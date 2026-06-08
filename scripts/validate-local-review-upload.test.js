const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { validateLocalReviewUpload } = require("./validate-local-review-upload.js");

function createDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE sync_runs (
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

function seedValid(db) {
  const now = "2026-06-05T11:00:00.000Z";
  db.prepare(`
    INSERT INTO sync_runs (
      sync_type, status, warehouse_range_start, warehouse_range_end,
      offsite_anchor_start, offsite_anchor_end, offsite_weeks,
      posts_count, snapshots_count, offsite_rows_count, offsite_pr_count,
      started_at, finished_at
    ) VALUES (?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("incremental:warehouse", "2026-05-02", "2026-06-04", null, null, 0, 1, 1, 0, 0, "2026-06-05T10:30:00.000Z", now);
  db.prepare(`
    INSERT INTO sync_runs (
      sync_type, status, warehouse_range_start, warehouse_range_end,
      offsite_anchor_start, offsite_anchor_end, offsite_weeks,
      posts_count, snapshots_count, offsite_rows_count, offsite_pr_count,
      started_at, finished_at
    ) VALUES (?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("incremental:offsite", null, null, "2026-05-18", "2026-05-24", 4, 0, 0, 1, 3, "2026-06-05T10:00:00.000Z", now);
  db.prepare(`
    INSERT INTO warehouse_posts (
      post_key, post_id, record_id, link, title, platform, channel_type, channel_name,
      owner, content_format, content_topic, featured_quality, product_line_1, product_line_2,
      collab_requirement, funnel_stage, content_source, viewers, sku_count, publish_date,
      project, project_key, project_links, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("post-1", "post-1", "record-1", "https://example.com/post-1", "Post 1", "instagram", "KOL", "instagram", "Owner", "视频", "Topic", "1", "Line 1", "Line 2", "", "认知", "source", 1, 1, "2026-05-18", "Project", "Project::Owner", 1, now);
  db.prepare(`
    INSERT INTO warehouse_post_snapshots (
      post_key, captured_at, week_index, exposure, likes, comments, shares, saves, interaction, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("post-1", "2026-06-04", 1, 1000, 10, 1, 1, 1, 13, now);
  db.prepare(`
    INSERT INTO warehouse_post_wide (
      post_key, captured_at, week_index, post_id, record_id, publish_date, platform,
      channel_type, channel_name, owner, project, project_key, project_links,
      product_line_1, product_line_2, content_topic, content_format, title, link,
      content_source, featured_quality, collab_requirement, funnel_stage, viewers,
      sku_count, exposure, likes, comments, shares, saves, interaction, source_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("post-1", "2026-06-04", 1, "post-1", "record-1", "2026-05-18", "instagram", "KOL", "instagram", "Owner", "Project", "Project::Owner", 1, "Line 1", "Line 2", "Topic", "视频", "Post 1", "https://example.com/post-1", "source", "1", "", "认知", 1, 1, 1000, 10, 1, 1, 1, 13, now);
  db.prepare(`
    INSERT INTO offsite_rows (
      review_start, review_end, label, type, channel, site, metric,
      content_count, current_value, previous_value, last_year_value, interaction,
      exposure_share, source_note, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run("2026-05-18", "2026-05-24", "独立站", "site", "DTC", "US", "sessions", 3, 1200, 1000, 900, 42, 1, "note", now);
  const prStmt = db.prepare(`
    INSERT INTO offsite_pr_metrics (
      review_start, review_end, label, value_text, format_type, has_data, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  prStmt.run("2026-05-18", "2026-05-24", "社交媒体提及量", "10", "", 1, now);
  prStmt.run("2026-05-18", "2026-05-24", "Media提及量", "5", "", 1, now);
  prStmt.run("2026-05-18", "2026-05-24", "SOV（Pending）", "12%", "pct", 1, now);
}

test("validation passes when local SQLite has fresh syncs, expected offsite window, PR cards, and consistent package counts", () => {
  const db = createDb();
  try {
    seedValid(db);
    const report = validateLocalReviewUpload({
      db,
      today: new Date("2026-06-05T12:00:00.000Z"),
      minWideLatestRows: 1,
      baselinePath: ""
    });
    assert.equal(report.ok, true);
    assert.equal(report.expectedOffsiteWindow.start, "2026-05-18");
    assert.equal(report.summary.uploadPosts, 1);
    assert.equal(report.checks.filter(check => !check.ok).length, 0);
  } finally {
    db.close();
  }
});

test("validation fails deterministically when an expected PR card is missing", () => {
  const db = createDb();
  try {
    seedValid(db);
    db.prepare("DELETE FROM offsite_pr_metrics WHERE label = ?").run("SOV（Pending）");
    const report = validateLocalReviewUpload({
      db,
      today: new Date("2026-06-05T12:00:00.000Z"),
      minWideLatestRows: 1,
      baselinePath: ""
    });
    const failed = report.checks.filter(check => !check.ok).map(check => check.name);
    assert.equal(report.ok, false);
    assert.ok(failed.includes("pr-cards-complete"));
  } finally {
    db.close();
  }
});
