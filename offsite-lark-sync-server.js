const http = require("http");
const fs = require("fs");
const { spawn } = require("child_process");

const PORT = Number(process.env.OFFSITE_SYNC_PORT || 8787);
const LARK_CLI = resolveLarkCli();
const SPREADSHEET_TOKEN = "Fg4jsK4dUhJOyVtsgw7cTwrCnpd";
const SHEETS = {
  independent: { id: "Aehu8s", range: "A1:M500", title: "独立站数据（@fufu+锦怡+林凡）" },
  pr: { id: "LxbXXL", range: "A1:E260", title: "PR(@Ted+美娜）" }
};

function resolveLarkCli() {
  const candidates = [
    process.env.LARK_CLI_PATH,
    "C:\\Users\\HP\\AppData\\Roaming\\npm\\lark-cli.cmd",
    "lark-cli"
  ].filter(Boolean);
  return candidates.find(candidate => candidate === "lark-cli" || fs.existsSync(candidate)) || "lark-cli";
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload));
}

function loadMysql() {
  try {
    return require("mysql2/promise");
  } catch (error) {
    throw new Error("同步服务缺少 mysql2 依赖，请在 3.0 目录运行 npm install 后重试。");
  }
}

function dbConfig(env = process.env) {
  const required = ["DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"];
  const missing = required.filter(key => !env[key]);
  if (missing.length) throw new Error(`缺少数仓连接配置：${missing.join(", ")}`);
  return {
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    connectTimeout: 12000,
    decimalNumbers: true,
    dateStrings: true,
    typeCast(field, next) {
      if (["STRING", "VAR_STRING", "BLOB"].includes(field.type)) {
        const value = field.buffer();
        return value == null ? null : value.toString("utf8");
      }
      return next();
    }
  };
}

function readSheet(sheet) {
  return new Promise((resolve, reject) => {
    const args = [
      "sheets", "+read",
      "--spreadsheet-token", SPREADSHEET_TOKEN,
      "--sheet-id", sheet.id,
      "--range", sheet.range,
      "--as", "user"
    ];
    const child = spawn(LARK_CLI, args, {
      windowsHide: true,
      shell: process.platform === "win32" && /\.cmd$/i.test(LARK_CLI)
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => {
      if (code !== 0) {
        reject(new Error(stderr || stdout || `lark-cli exited with ${code}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        if (!parsed.ok) throw new Error(parsed.error?.message || parsed.error || "lark-cli read failed");
        resolve(parsed.data?.valueRange?.values || []);
      } catch (error) {
        reject(new Error(`无法解析 lark-cli 输出：${error.message}`));
      }
    });
  });
}

function parseNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value == null) return 0;
  const text = String(value).trim();
  if (!text || text === "/" || text.toUpperCase() === "#DIV/0!") return 0;
  const normalized = text.replace(/,/g, "");
  if (/^[+-]?\d+(\.\d+)?$/.test(normalized)) return Number(normalized);
  if (/^[\d+\-.\s]+$/.test(normalized)) {
    return normalized.split("+").reduce((acc, part) => acc + (Number(part.trim()) || 0), 0);
  }
  return 0;
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeWarehouseUrl(value) {
  return String(value || "").trim().replace(/[?#].*$/, "").replace(/\/$/, "");
}

function postKey(platform, postId, link) {
  const normalizedPlatform = String(platform || "").trim().toLowerCase();
  const id = String(postId || "").trim();
  if (id) return `${normalizedPlatform}:${id}`;
  return `${normalizedPlatform}:${normalizeWarehouseUrl(link)}`;
}

function metricInteraction(row) {
  return parseNumber(row.likes) + parseNumber(row.comments) + parseNumber(row.shares) + parseNumber(row.saves);
}

function warehouseTextValue(value) {
  return value == null ? "" : String(value);
}

function warehouseContentFormat(contentForm, fallback) {
  if (contentForm == null || contentForm === "") return fallback || "";
  const text = String(contentForm);
  if (text === "0") return "视频";
  if (text === "1") return "图片";
  return text;
}

function upsertPostSnapshot(posts, row) {
  const key = postKey(row.platform, row.post_id, row.post_link);
  if (!posts.has(key)) {
    posts.set(key, {
      id: `wh-${key.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")}`,
      link: row.post_link || "",
      title: row.title || row.content_text || "无标题",
      platform: row.platform,
      channelType: row.channel_type,
      channelName: row.channel_name,
      owner: row.manager || "",
      contentFormat: warehouseContentFormat(row.content_form, row.content_type),
      contentTopic: row.content_themes || "",
      featuredQuality: row.is_high_quality_content == null ? "" : String(row.is_high_quality_content),
      productLine1: row.first_type || "",
      productLine2: row.second_type || "",
      collabRequirement: row.cooperation_requirements || "",
      funnelStage: row.marketing_funnel_level || "",
      contentSource: warehouseTextValue(row.content_source),
      viewers: parseNumber(row.viewers),
      skuCount: parseNumber(row.sku_count),
      publishDate: dateKey(parseDateTime(row.publish_time) || parseDateTime(row.stat_date) || new Date()),
      project: row.project_name || "",
      projectKey: [row.project_name, row.manager].filter(Boolean).join("::"),
      projectLinks: 1,
      snapshotsByDate: new Map()
    });
  }
  const post = posts.get(key);
  const capturedAt = String(row.stat_date || "").slice(0, 10);
  if (!capturedAt) return;
  const snapshot = {
    capturedAt,
    exposure: parseNumber(row.exposure),
    likes: parseNumber(row.likes),
    comments: parseNumber(row.comments),
    shares: parseNumber(row.shares),
    saves: parseNumber(row.saves),
    interaction: row.interaction == null ? metricInteraction(row) : parseNumber(row.interaction)
  };
  const existing = post.snapshotsByDate.get(capturedAt);
  if (!existing) {
    post.snapshotsByDate.set(capturedAt, snapshot);
  } else {
    existing.exposure = Math.max(existing.exposure, snapshot.exposure);
    existing.likes = Math.max(existing.likes, snapshot.likes);
    existing.comments = Math.max(existing.comments, snapshot.comments);
    existing.shares = Math.max(existing.shares, snapshot.shares);
    existing.saves = Math.max(existing.saves, snapshot.saves);
    existing.interaction = Math.max(existing.interaction, snapshot.interaction);
  }
}

function finalizeWarehousePosts(posts) {
  return Array.from(posts.values()).map(post => {
    const snapshots = Array.from(post.snapshotsByDate.values())
      .sort((a, b) => parseDate(a.capturedAt) - parseDate(b.capturedAt))
      .map((snapshot, index) => ({ ...snapshot, weekIndex: index + 1 }));
    const { snapshotsByDate, ...rest } = post;
    return { ...rest, snapshots };
  }).filter(post => post.snapshots.length);
}

async function resolveWarehouseFullRange(options = {}) {
  const mysql = loadMysql();
  const conn = await mysql.createConnection(dbConfig(options.env));
  try {
    const [rows] = await conn.query(`
      select min(dt) min_dt, max(dt) max_dt
      from (
        select business_date dt from ods.ods_tiktok_day_video_di
        union all select date(crawl_time) from ods.ods_apify_day_tiktok_video_di
        union all select business_date from ods.ods_instagram_day_video_details_di
        union all select date(crawl_time) from ods.ods_apify_day_instagram_video_di
        union all select business_date from ods.ods_facebook_day_video_di
        union all select date(crawl_time) from ods.ods_apify_day_facebook_video_di
        union all select business_date from ods.ods_meta_day_published_post_reel_list_di
        union all select business_date from ods.ods_pinterest_day_profile_posts_di
        union all select business_date from ods.ods_facebook_day_group_insights_posts_di
      ) dates
      where dt is not null
    `);
    const range = rows[0] || {};
    const start = parseDate(range.min_dt);
    const end = parseDate(range.max_dt);
    if (!start || !end) throw new Error("数仓未返回可用帖子日期范围");
    return { start, end };
  } finally {
    await conn.end();
  }
}

async function buildWarehousePosts(start, end, options = {}) {
  const mysql = loadMysql();
  const conn = await mysql.createConnection(dbConfig(options.env));
  const params = [dateKey(start), dateKey(end)];
  const sql = `
    with metrics as (
      select business_date stat_date,
             case data_type when 1 then '社媒' when 2 then 'KOL' else cast(data_type as char) end channel_type,
             'tiktok' channel_name,
             'tk' platform,
             cast(id as char) post_id,
             url post_link,
             text title,
             create_time publish_time,
             null viewers,
             cast(replace(coalesce(play_count,0), ',', '') as decimal(20,4)) exposure,
             cast(replace(coalesce(like_count,0), ',', '') as decimal(20,4)) likes,
             cast(replace(coalesce(comment_count,0), ',', '') as decimal(20,4)) comments,
             cast(replace(coalesce(share_count,0), ',', '') as decimal(20,4)) shares,
             cast(replace(coalesce(collect_count,0), ',', '') as decimal(20,4)) saves,
             cast(replace(coalesce(like_count,0), ',', '') as decimal(20,4))
               + cast(replace(coalesce(comment_count,0), ',', '') as decimal(20,4))
               + cast(replace(coalesce(share_count,0), ',', '') as decimal(20,4))
               + cast(replace(coalesce(collect_count,0), ',', '') as decimal(20,4)) interaction
      from ods.ods_tiktok_day_video_di
      where business_date between ? and ?
      union all
      select date(crawl_time) stat_date,
             case data_type when 1 then '社媒' when 2 then 'KOL' else cast(data_type as char) end channel_type,
             'tiktok' channel_name,
             'tk' platform,
             cast(id as char) post_id,
             url post_link,
             text title,
             create_time publish_time,
             null viewers,
             play_count exposure,
             like_count likes,
             comment_count comments,
             share_count shares,
             collect_count saves,
             coalesce(like_count,0)+coalesce(comment_count,0)+coalesce(share_count,0)+coalesce(collect_count,0) interaction
      from ods.ods_apify_day_tiktok_video_di old_tk
      where date(crawl_time) between ? and ?
        and not exists (
          select 1
          from ods.ods_tiktok_day_video_di new_tk
          where new_tk.business_date = date(old_tk.crawl_time)
            and new_tk.data_type = old_tk.data_type
        )
      union all
      select business_date,
             channel_type,
             'instagram',
             'ins',
             post_id,
             url,
             text,
             create_time,
             null,
             cast(replace(coalesce(play_count,0), ',', '') as decimal(20,4)),
             cast(replace(coalesce(like_count,0), ',', '') as decimal(20,4)),
             cast(replace(coalesce(comment_count,0), ',', '') as decimal(20,4)),
             null,
             null,
             cast(replace(coalesce(like_count,0), ',', '') as decimal(20,4))
               + cast(replace(coalesce(comment_count,0), ',', '') as decimal(20,4))
      from ods.ods_instagram_day_video_details_di
      where business_date between ? and ?
      union all
      select date(o.crawl_time),
             coalesce(d.data_domain_type, 'KOL'),
             'instagram',
             'ins',
             o.post_id,
             o.url,
             o.text,
             o.create_time,
             null,
             o.view_count,
             o.like_count,
             o.comment_count,
             o.share_count,
             null,
             coalesce(o.like_count,0)+coalesce(o.comment_count,0)+coalesce(o.share_count,0)
      from ods.ods_apify_day_instagram_video_di o
      left join dwd.dwd_social_post_dim_df d
        on d.dt = date(o.crawl_time)
       and d.platform = 'ins'
       and d.source_table = 'ods.ods_apify_day_instagram_video_di'
       and d.post_id = o.post_id
      where date(o.crawl_time) between ? and ?
        and not exists (
          select 1
          from ods.ods_instagram_day_video_details_di new_ins
          where new_ins.business_date = date(o.crawl_time)
        )
      union all
      select business_date,
             'KOL',
             'facebook',
             'fb',
             cast(post_id as char),
             url,
             text,
             create_time,
             null,
             cast(replace(coalesce(play_count,0), ',', '') as decimal(20,4)),
             cast(replace(coalesce(like_count,0), ',', '') as decimal(20,4)),
             cast(replace(coalesce(comment_count,0), ',', '') as decimal(20,4)),
             cast(replace(coalesce(share_count,0), ',', '') as decimal(20,4)),
             null,
             cast(replace(coalesce(unified_reactors_count,0), ',', '') as decimal(20,4))
      from ods.ods_facebook_day_video_di
      where business_date between ? and ?
      union all
      select date(crawl_time),
             'KOL',
             'facebook',
             'fb',
             cast(post_id as char),
             url,
             text,
             create_time,
             null,
             play_count,
             like_count,
             comment_count,
             share_count,
             null,
             unified_reactors_count
      from ods.ods_apify_day_facebook_video_di
      where date(crawl_time) between ? and ?
        and not exists (
          select 1
          from ods.ods_facebook_day_video_di new_fb
          where new_fb.business_date = date(ods.ods_apify_day_facebook_video_di.crawl_time)
        )
      union all
      select business_date,
             '社媒',
             'facebook',
             'fb',
             cast(post_id as char),
             '',
             title,
             publish_date,
             viewers,
             views,
             reactions,
             comments,
             shares,
             saves,
             interactions
      from ods.ods_meta_day_published_post_reel_list_di
      where business_date between ? and ?
      union all
      select business_date,
             '社媒',
             'pinterest',
             'pin',
             cast(post_id as char),
             '',
             coalesce(title, description),
             created_at,
             null,
             impression,
             like_count,
             comment_count,
             null,
             save,
             coalesce(like_count,0)+coalesce(comment_count,0)+coalesce(save,0)
      from ods.ods_pinterest_day_profile_posts_di
      where business_date between ? and ?
      union all
      select p.business_date,
             '社群',
             'facebook',
             'fb',
             cast(p.post_id as char),
             p.post_link,
             p.title,
             p.publish_date,
             null,
             0,
             coalesce(d.like_reactions,0)+coalesce(d.love_reactions,0)+coalesce(d.haha_reactions,0)+coalesce(d.wow_reactions,0)+coalesce(d.sad_reactions,0)+coalesce(d.angry_reactions,0),
             d.comments,
             null,
             null,
             coalesce(d.interactions, p.interactions)
      from ods.ods_facebook_day_group_insights_posts_di p
      left join ods.ods_facebook_day_group_insights_posts_detail_di d
        on d.business_date = p.business_date
       and d.group_code = p.group_code
       and d.post_id = p.post_id
      where p.business_date between ? and ?
    ),
    link_msku as (
      select channel_link_id,
             max(first_type) first_type,
             max(second_type) second_type,
             max(msku) msku,
             count(distinct msku) sku_count
      from ods.ods_sqt_bi_bi_channel_link_msku_df
      where coalesce(deleted, 0) = 0
      group by channel_link_id
    ),
    biz as (
      select l.post_link,
             max(p.project_name) project_name,
             max(l.manager) manager,
             max(l.content_source) content_source,
             max(l.cooperation_requirements) cooperation_requirements,
             max(l.content_form) content_form,
             max(l.marketing_funnel_level) marketing_funnel_level,
             max(l.content_themes) content_themes,
             max(l.is_high_quality_content) is_high_quality_content,
             max(m.first_type) first_type,
             max(m.second_type) second_type,
             max(m.sku_count) sku_count
      from ods.ods_sqt_bi_bi_channel_link_df l
      left join ods.ods_sqt_bi_bi_channel_link_project_df p on p.id = l.project_id
      left join link_msku m on m.channel_link_id = l.id
      where l.post_link is not null and l.post_link <> ''
        and coalesce(l.deleted, 0) = 0
      group by l.post_link
    )
    select m.*,
           d.content_type,
           coalesce(d.title, m.title) dim_title,
           coalesce(d.post_link, m.post_link) dim_link,
           b.project_name,
           b.manager,
           b.content_source,
           b.cooperation_requirements,
           b.content_form,
           b.marketing_funnel_level,
           b.content_themes,
           b.is_high_quality_content,
           b.first_type,
           b.second_type,
           b.sku_count
    from metrics m
    left join dwd.dwd_social_post_dim_df d
      on d.dt = m.stat_date
     and d.platform = m.platform
     and d.post_id = m.post_id
    left join biz b
      on replace(regexp_replace(coalesce(d.post_link, m.post_link), '[?#].*$', ''), '/$', '') = replace(regexp_replace(b.post_link, '[?#].*$', ''), '/$', '')
    order by m.stat_date, m.channel_type, m.channel_name, m.post_id
  `;
  const [rows] = await conn.query(sql, [
    ...params,
    ...params,
    ...params,
    ...params,
    ...params,
    ...params,
    ...params,
    ...params,
    ...params
  ]);
  await conn.end();
  const posts = new Map();
  rows.forEach(row => {
    upsertPostSnapshot(posts, {
      ...row,
      title: row.dim_title || row.title,
      post_link: row.dim_link || row.post_link
    });
  });
  const finalized = finalizeWarehousePosts(posts);
  return {
    posts: finalized,
    audit: {
      totalRows: rows.length,
      acceptedRows: finalized.length,
      statDateRange: `${dateKey(start)} ~ ${dateKey(end)}`,
      source: "warehouse"
    },
    importMeta: {
      fileName: "数仓只读同步",
      savedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
      source: "warehouse",
      range: `${dateKey(start)} ~ ${dateKey(end)}`
    },
    reviewWeek: {
      dateRange: `${dateKey(start)} ~ ${dateKey(end)}`
    }
  };
}

function parseWeek(year, label) {
  const text = String(label || "").trim();
  const match = text.match(/(\d{1,2})[./](\d{1,2})\s*-\s*(?:(\d{1,2})[./])?(\d{1,2})/);
  if (!match) return null;
  const startMonth = Number(match[1]);
  const startDay = Number(match[2]);
  const endMonth = Number(match[3] || match[1]);
  const endDay = Number(match[4]);
  if (!year || !startMonth || !startDay || !endMonth || !endDay) return null;
  return {
    start: new Date(Number(year), startMonth - 1, startDay),
    end: new Date(Number(year), endMonth - 1, endDay)
  };
}

function splitRows(values) {
  const [header = [], ...rows] = values || [];
  return { header, rows: rows.filter(row => row && row.some(cell => cell != null && String(cell).trim() !== "")) };
}

function rowsForWeek(rows, start, end) {
  return rows.filter(row => {
    const week = parseWeek(row[0], row[1]);
    return week && overlapDays(week.start, week.end, start, end) >= 4;
  });
}

function overlapDays(leftStart, leftEnd, rightStart, rightEnd) {
  const start = new Date(Math.max(leftStart.getTime(), rightStart.getTime()));
  const end = new Date(Math.min(leftEnd.getTime(), rightEnd.getTime()));
  if (end < start) return 0;
  return Math.floor((end - start) / 86400000) + 1;
}

function groupByLabel(rows) {
  const map = new Map();
  rows.forEach(row => {
    const label = String(row.label || "未知来源");
    if (!map.has(label)) {
      map.set(label, { ...row, current: 0, previous: 0, lastYear: 0, interaction: 0 });
    }
    const target = map.get(label);
    target.current += parseNumber(row.current);
    target.previous += parseNumber(row.previous);
    target.lastYear += parseNumber(row.lastYear);
    target.interaction += parseNumber(row.interaction);
  });
  return Array.from(map.values());
}

function independentRows(values, start, end, previousStart, previousEnd, lastYearStart, lastYearEnd) {
  const { rows } = splitRows(values);
  const collect = (targetStart, targetEnd, field) => rowsForWeek(rows, targetStart, targetEnd).map(row => {
    const item = {
      label: `${row[2] || "独立站"} ${row[3] || ""}`.trim(),
      type: "独立站",
      channel: String(row[2] || "-"),
      site: String(row[3] || "-"),
      metric: "exposure",
      [field]: parseNumber(row[4])
    };
    if (field === "current") item.interaction = parseNumber(row[5]);
    return item;
  });
  return groupByLabel([
    ...collect(start, end, "current"),
    ...collect(previousStart, previousEnd, "previous"),
    ...collect(lastYearStart, lastYearEnd, "lastYear")
  ]);
}

function prMetrics(values, start, end) {
  const { rows } = splitRows(values);
  const matched = rowsForWeek(rows, start, end);
  const socialMentions = matched.reduce((acc, row) => acc + parseNumber(row[2]), 0);
  const mediaMentions = matched.reduce((acc, row) => acc + parseNumber(row[3]), 0);
  const sov = matched.map(row => String(row[4] ?? "").trim()).find(Boolean) || "";
  return [
    { label: "社交媒体提及量", value: socialMentions, hasData: matched.length > 0 },
    { label: "Media提及量", value: mediaMentions, hasData: matched.length > 0 },
    { label: "SOV（Pending）", value: sov, format: "pct", hasData: matched.length > 0 && !!sov }
  ];
}

async function buildDtcSection(start, end) {
  const previousStart = addDays(start, -7);
  const previousEnd = addDays(end, -7);
  const lastYearStart = addDays(start, -364);
  const lastYearEnd = addDays(end, -364);
  const [independent, pr] = await Promise.all([
    readSheet(SHEETS.independent),
    readSheet(SHEETS.pr)
  ]);
  const rows = independentRows(independent, start, end, previousStart, previousEnd, lastYearStart, lastYearEnd);
  const prMetricCards = prMetrics(pr, start, end);
  const sources = [independent].map(values => splitRows(values).rows);
  const hasRowsForWindow = (targetStart, targetEnd) => sources.some(rowsForSource => rowsForWeek(rowsForSource, targetStart, targetEnd).length > 0);
  const hasCurrentData = hasRowsForWindow(start, end);
  const hasPreviousData = hasRowsForWindow(previousStart, previousEnd);
  const hasLastYearData = hasRowsForWindow(lastYearStart, lastYearEnd);
  const totalCurrent = rows.reduce((acc, row) => acc + parseNumber(row.current), 0);
  rows.forEach(row => {
    row.exposureShare = totalCurrent ? parseNumber(row.current) / totalCurrent : 0;
  });
  return {
    totalCurrent,
    totalPrevious: rows.reduce((acc, row) => acc + parseNumber(row.previous), 0),
    totalLastYear: rows.reduce((acc, row) => acc + parseNumber(row.lastYear), 0),
    rows,
    prMetrics: prMetricCards,
    hasCurrentData,
    hasPreviousData,
    hasLastYearData,
    updatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
    source: {
      type: "feishu",
      spreadsheetToken: SPREADSHEET_TOKEN,
      sheets: Object.values(SHEETS).map(sheet => ({ id: sheet.id, title: sheet.title })),
      note: hasCurrentData ? "只读同步；指标卡片来自 PR sheet，表格来自独立站数据 sheet。" : "只读同步；飞书未找到当前复盘周期独立站数据，指标卡片来自 PR sheet。"
    }
  };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  if (url.pathname === "/api/posts/warehouse-refresh") {
    try {
      const full = url.searchParams.get("full") === "1";
      const range = full ? await resolveWarehouseFullRange() : {};
      const start = full ? range.start : parseDate(url.searchParams.get("start"));
      const end = full ? range.end : parseDate(url.searchParams.get("end"));
      if (!start || !end) throw new Error("缺少有效 start/end 日期");
      const source = await buildWarehousePosts(start, end);
      sendJson(res, 200, { ok: true, source });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return;
  }
  if (url.pathname !== "/api/offsite/refresh") {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  try {
    const start = parseDate(url.searchParams.get("start"));
    const end = parseDate(url.searchParams.get("end"));
    if (!start || !end) throw new Error("缺少有效 start/end 日期");
    const dtcSection = await buildDtcSection(start, end);
    sendJson(res, 200, { ok: true, dtcSection });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message || String(error) });
  }
});

if (require.main === module) {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Offsite Lark sync server listening at http://127.0.0.1:${PORT}`);
    console.log("Read-only sheets:", Object.values(SHEETS).map(sheet => `${sheet.title}(${sheet.id})`).join(", "));
  });
}

module.exports = {
  buildWarehousePosts,
  dateKey,
  parseDate,
  resolveWarehouseFullRange
};
