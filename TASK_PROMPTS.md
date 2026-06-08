# 帖子明细头部指标 — 修复为按复盘周发布日期过滤

## 根因诊断

| 问题 | 根因 | 影响范围 |
|------|------|---------|
| 帖子明细头部显示"本周共 1,498 帖"，数字离谱 | `buildMetricCards("detail")` 和 `buildNarrative("detail")` 使用 `deriveForScope("all")`，其内部 `poolPosts` 按整月批次（monthStart ~ reportEnd）过滤，而非按复盘周。mock 数据整月发布且在复盘周有表现的帖子达 1498 条 | detail Tab 头部 4 张指标卡片 + 综述面板 |
| 其他指标（曝光、Top5、优质内容）同样不准 | 同上，`all.currentTotals`、`all.poolPosts` 均基于整月批次 | detail Tab 全部头部指标 |

---

## 线程 A：app.js — 修复 detail 指标为按复盘周过滤

```copy
## 任务：修复帖子明细头部指标，按复盘周发布日期过滤

### 背景
`buildMetricCards("detail")` 和 `buildNarrative("detail")` 当前使用 `deriveForScope("all")` 获取数据。但 `deriveForScope` 内部用**整月批次**（`batchStartDate` ~ `batchEndDate`）过滤 `poolPosts`，导致帖子数 = 整月发布且在复盘周有表现的全部帖子（mock 数据下 1498 条）。

正确做法：detail 头部指标应按**复盘周发布日期**过滤，只统计 `publishDateObj` 在 `reviewWindow.start` ~ `reviewWindow.end` 范围内的帖子。这样切换周选择器时，指标正确反映该周发布的帖子数据。

### 涉及文件
- 修改：`3.0/app.js`
- 只读：`3.0/styles.css`、`3.0/index.html`

### 修改清单

**修改 1：`buildMetricCards("detail")`（约 1553-1561 行）**

找到以下代码：
```js
  if (tabKey === "detail") {
    const curPosts = all.currentPostCount || 0;
    const prevPosts = all.previousPostCount || 0;
    const wowPosts = safeWoW(curPosts, prevPosts);
    const top5Detail = all.poolPosts.map(p => ({ m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5ShareDetail = safeRate(sum(top5Detail, p => p.m.exposure), curExp);
    const qualityDetail = all.poolPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    return `<div class="metric-grid">${cardWow("本周帖子数", curPosts, wowPosts)}${card("Top5曝光占比", formatPct(top5ShareDetail))}${card("优质内容", qualityDetail)}${cardWow("本周总曝光", curExp, wowExp)}</div>`;
  }
```

整体替换为：
```js
  if (tabKey === "detail") {
    const weekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const prevWeekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= previousWindow.start && p.publishDateObj <= previousWindow.end);
    const prevPosts = prevWeekPosts.length;
    const wowPosts = safeWoW(curPosts, prevPosts);
    const curExp = weekPosts.reduce((acc, p) => acc + diffMetrics(p, reviewWindow.start, reviewWindow.end).exposure, 0);
    const prevExp = prevWeekPosts.reduce((acc, p) => acc + diffMetrics(p, previousWindow.start, previousWindow.end).exposure, 0);
    const wowExp = safeWoW(curExp, prevExp);
    const top5Detail = weekPosts.map(p => ({ m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5ShareDetail = safeRate(sum(top5Detail, p => p.m.exposure), curExp);
    const qualityDetail = weekPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    return `<div class="metric-grid">${cardWow("本周帖子数", curPosts, wowPosts)}${card("Top5曝光占比", formatPct(top5ShareDetail))}${card("优质内容", qualityDetail)}${cardWow("本周总曝光", curExp, wowExp)}</div>`;
  }
```

说明：
- `weekPosts`：按 `publishDateObj` 在复盘周 [reviewWindow.start, reviewWindow.end] 过滤
- `prevWeekPosts`：按上一周 [previousWindow.start, previousWindow.end] 过滤，用于环比
- 帖子数 = 该周发布的帖子总数
- 总曝光 = 该周发布帖子在本周的曝光量之和
- 环比曝光 = 该周发布帖子在上周的表现 vs 上周发布帖子在上周的表现（同口径：首周表现对比）

**修改 2：`buildNarrative("detail")`（约 1649-1665 行）**

找到以下代码：
```js
  else if (tabKey === "detail") {
    const curPosts = all.currentPostCount || 0;
    const top5Detail = all.poolPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5ShareDetail = safeRate(sum(top5Detail, p => p.m.exposure), curExp);
    const top20Detail = all.poolPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 20);
    const top20ShareDetail = safeRate(sum(top20Detail, p => p.m.exposure), curExp);
    const qualityDetail = all.poolPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    const topics = new Set(all.poolPosts.map(p => asText(p.contentTopic || p.normalizedTopic || "").trim()).filter(Boolean));
    const channels = buildChannelRows(all.poolPosts, all.currentTotals);
    const topChannel = channels[0];
    lines.push(`本周共 ${formatInteger(curPosts)} 帖，总曝光 ${formatCompact(curExp)}，环比${wowExp > 0 ? "增长" : wowExp < 0 ? "下降" : "持平"} ${formatPct(Math.abs(wowExp))}。可切换下方子视图查看：帖子明细 / Top 帖子 / 优质内容 / 主题分析。`);
    lines.push(`Top5 曝光占比 ${formatPct(top5ShareDetail)}（Top20 占比 ${formatPct(top20ShareDetail)}），${top5ShareDetail >= 0.1 ? "头部内容集中度较高。" : top5ShareDetail >= 0.05 ? "头部内容有一定集中度。" : "曝光分布相对分散。"}`);
    lines.push(`优质内容 ${formatInteger(qualityDetail)} 条${curPosts > 0 ? "，占总量 " + formatPct(safeRate(qualityDetail, curPosts)) : ""}。${topics.size > 0 ? "覆盖 " + formatInteger(topics.size) + " 个主题。" : ""}`);
    if (topChannel) lines.push(`渠道曝光最高为 ${topChannel.label}，占比 ${formatPct(safeRate(topChannel.exposure, curExp))}。`);
    if (state.importAudit) lines.push(`数据来源：${escapeHtml(state.importAudit.fileName || "导入文件")}，含 ${formatInteger(state.importAudit.acceptedRows)} 条有效记录。`);
    else lines.push("当前为内置样例数据，导入 Excel 后显示真实数据。");
  }
```

整体替换为：
```js
  else if (tabKey === "detail") {
    const weekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const curExp = weekPosts.reduce((acc, p) => acc + diffMetrics(p, reviewWindow.start, reviewWindow.end).exposure, 0);
    const curInt = weekPosts.reduce((acc, p) => acc + diffMetrics(p, reviewWindow.start, reviewWindow.end).interaction, 0);
    const prevWeekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= previousWindow.start && p.publishDateObj <= previousWindow.end);
    const prevExp = prevWeekPosts.reduce((acc, p) => acc + diffMetrics(p, previousWindow.start, previousWindow.end).exposure, 0);
    const wowExp = safeWoW(curExp, prevExp);
    const top5Detail = weekPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5ShareDetail = safeRate(sum(top5Detail, p => p.m.exposure), curExp);
    const top20Detail = weekPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 20);
    const top20ShareDetail = safeRate(sum(top20Detail, p => p.m.exposure), curExp);
    const qualityDetail = weekPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    const topics = new Set(weekPosts.map(p => asText(p.contentTopic || p.normalizedTopic || "").trim()).filter(Boolean));
    const channels = buildChannelRows(weekPosts, { exposure: curExp, interaction: curInt });
    const topChannel = channels[0];
    lines.push(`本周发布 ${formatInteger(curPosts)} 帖，总曝光 ${formatCompact(curExp)}，环比${wowExp > 0 ? "增长" : wowExp < 0 ? "下降" : "持平"} ${formatPct(Math.abs(wowExp))}。可切换下方子视图查看：帖子明细 / Top 帖子 / 优质内容 / 主题分析。`);
    lines.push(`Top5 曝光占比 ${formatPct(top5ShareDetail)}（Top20 占比 ${formatPct(top20ShareDetail)}），${top5ShareDetail >= 0.1 ? "头部内容集中度较高。" : top5ShareDetail >= 0.05 ? "头部内容有一定集中度。" : "曝光分布相对分散。"}`);
    lines.push(`优质内容 ${formatInteger(qualityDetail)} 条${curPosts > 0 ? "，占总量 " + formatPct(safeRate(qualityDetail, curPosts)) : ""}。${topics.size > 0 ? "覆盖 " + formatInteger(topics.size) + " 个主题。" : ""}`);
    if (topChannel) lines.push(`渠道曝光最高为 ${topChannel.label}，占比 ${formatPct(safeRate(topChannel.exposure, curExp))}。`);
    if (state.importAudit) lines.push(`数据来源：${escapeHtml(state.importAudit.fileName || "导入文件")}，含 ${formatInteger(state.importAudit.acceptedRows)} 条有效记录。`);
    else lines.push("当前为内置样例数据，导入 Excel 后显示真实数据。");
  }
```

说明：
- 所有数据来源从 `all.poolPosts` / `all.currentTotals` 改为 `weekPosts`（按复盘周发布日期过滤）
- 曝光、互动、渠道行均基于 `weekPosts` 计算
- `buildChannelRows` 的第二个参数需要手动构造 `{ exposure, interaction }` totals
- 综述第一句改为"本周发布 N 帖"（强调是发布量）

### 不改的边界
- 不修改 `deriveForScope()`、`deriveFromPosts()`、`filterPostsByScope()` — 这些是 overview/cohort/channel 共用的数据层
- 不修改 `buildMetricCards("overview"/"cohort"/"channel")` 等其他分支
- 不修改 `buildNarrative("overview"/"cohort"/"channel")` 等其他分支
- 不修改 `renderDetail()` 的表格渲染逻辑（表格仍用 batch 范围的全量数据）
- 不修改 `styles.css` 和 `index.html`

### 自检清单
- [ ] `node --check app.js` 零报错
- [ ] `weekPosts` 只包含 `publishDateObj` 在复盘周内的帖子
- [ ] 切换周选择器 → detail 头部指标随之变化
- [ ] 帖子数 = 该周发布的帖子数（不是整月有表现帖子数）
- [ ] 环比对比：本周发布帖的首周表现 vs 上周发布帖的首周表现
- [ ] mock 数据下帖子数远小于 1498
- [ ] 无 console error
```

---

## 集成验收

```copy
### 验收清单

**detail Tab — 指标卡片联动周期**
- [ ] 打开 http://127.0.0.1:8863/index.html → 帖子明细 Tab
- [ ] 头部 4 张卡片：本周帖子数、Top5曝光占比、优质内容、本周总曝光
- [ ] 帖子数为该复盘周发布帖子数（mock 数据下 < 100，不是 1498）
- [ ] 点击周选择器切换到不同周 → 卡片数值随之变化
- [ ] 本周帖子数卡片带有环比箭头

**detail Tab — 综述联动周期**
- [ ] 综述第一行："本周发布 N 帖，总曝光 X，环比..."
- [ ] Top5/Top20 曝光占比较上一版合理
- [ ] 优质内容数和主题覆盖数正确
- [ ] 切换周选择器 → 综述内容同步更新

**不影响其他 Tab**
- [ ] 总览 Tab 指标卡片不变（仍用整月批次口径）
- [ ] Cohort Tab 正常
- [ ] 渠道诊断 Tab 正常

**不影响 detail 表格**
- [ ] 帖子明细表格仍显示全量数据（整月批次范围）
- [ ] 子视图切换正常（Top 帖子 / 优质内容 / 主题分析）

**边界情况**
- [ ] 切换到无帖子发布的周 → 卡片显示 0 或 "-"
- [ ] 浏览器 Console 无新增 error

**不通过处理**
任一 ❌ → 退回线程 A 重改。
```

---

# 2026-06-01 — 主题分析条形图 + 排序修复

## 需求

1. 主题分析改成条形图样式，不用做成表格
2. 帖子明细排序箭头点击很卡，修复分页和排序交互

## 线程 A：主题分析 → 条形图

**位置**: `handleStageClick` → `detail-view-mode` → `mode === "topic"` 分支（约第 515-547 行）

**改动**: 不再构建 topicRows 传给 `updateDetailTable`，直接在 `tbody` 中用 `colspan="17"` 单行渲染横向条形图。使用已有 CSS 类 `.bar-list` `.bar-row` `.topic-bar-row`。互动率标记：<2% red，<=3% amber，else green。

## 线程 B：排序修复

**B1. 排序后分页重置** — `sortDetailTable` 末尾 `updateDetailTable` 后：隐藏第 25 行后的所有 `[data-detail-row]`，重置 `currentPage` 为 "0"

**B2. 全部列排序箭头** — `renderDetail` 中删除 `sortableMetricCols` 条件，所有 17 列均带 ⇅ 箭头

**B3. 优质列数值排序** — `isNumericCol` 添加 colIdx `8`

## Codex 执行结果

- `node --check app.js` 通过
- 三处修改全部到位

## 集成验收清单

- [ ] 帖子明细 → 点击「主题分析」chip → 显示条形图而非表格
- [ ] 所有 17 列表头都有 ⇅ 排序箭头
- [ ] 点击任意列表头排序 → 页面不卡顿，自动回到第 1 页
- [ ] 点击同一列表头可切换升序/降序
- [ ] 点击「优质」列排序 → 按数值排序
- [ ] 切换回其他 chip → 正常显示

---

# 2026-06-01 — 排序改为双独立按钮 + 仅数据列显示

## 需求

1. 升序/降序改为两个独立按钮，不要一个按钮 toggle
2. 只有有意义的列显示排序：#、发布时间、曝光、互动、点赞、评论、分享、收藏

## 改动

- `thWithSort`: 只给 `sortableDetailCols = [0,1,11,12,13,14,15,16]` 渲染 ↑↓ 双按钮
- `handleStageClick`: 直接从 `btn.dataset.dir` 读取方向，不再 toggle
- `sortDetailTable(tableId, colIdx, dir)`: 直接使用传入的 dir
- 激活按钮高亮品牌色 + `aria-pressed="true"`

---

# 2026-06-01 — Cohort 曝光矩阵：数据成熟度卡片修复

## 需求

修复"本周总曝光拆解"区域的数据成熟度卡片始终显示最新发布周（`matrix[0]`）的成熟度，而非当前选中复盘周的成熟度。

## 根因

`renderCohort()` 中数据成熟度卡片写死 `matrix[0]?.maturityText`。`matrix` 由 `buildCohortMatrix` 按发布时间降序排列，`matrix[0]` 永远是数据集中最新发布周，与用户选中哪个复盘周无关。

## 线程 A：app.js — 数据成熟度卡片指向当前选中周

**修改 1**：在 `renderCohort()` 中 `matrix` 计算之后插入两行，计算当前选中周的 cohort key 并从 matrix 中匹配行：

```
const reviewWeekKey = reviewWindow.start.getFullYear() + '-W' + String(weekOfYear(reviewWindow.start)).padStart(2, '0');
const currentWeekRow = matrix.find(function(row) { return row.key === reviewWeekKey; });
```

**修改 2**：数据成熟度卡片改引 `currentWeekRow`：

- 值：`matrix[0]?.maturityText` → `currentWeekRow ? escapeHtml(currentWeekRow.maturityText) : "该周无帖"`
- 备注：原"本周数据已跑满 / 未跑满" → "该周帖子 X/4 周生命周期已走完 / 仅走完 X/4 周，结论需谨慎"
- 无匹配行时兜底："选中周无发布帖，无法评估成熟度"

## Codex 执行结果

- `node --check app.js` 通过
- 仅修改 `renderCohort()` 函数，未动其他代码

## 集成验收清单

- [ ] 选中最新发布周 → 数据成熟度显示该周的成熟度 N/4 周
- [ ] 切换到较早的一周（有发布帖）→ 成熟度数值应不同（更早的周更多周已跑满）
- [ ] 切换到没有任何帖子发布的周 → 显示"该周无帖"
- [ ] 新老帖占比卡片不受影响
- [ ] Cohort 矩阵表格不受影响
- [ ] `node --check app.js` 通过
