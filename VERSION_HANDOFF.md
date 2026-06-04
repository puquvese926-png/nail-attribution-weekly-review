# 周复盘分析看板 3.0 完整设计文档

> 本文档是 VERSION_HANDOFF.md 的重写版本，全面覆盖 3.0 实际实现的每个模块、数据口径、使用方式和设计意图。
> 非更新公告，而是给后续接手方或其他 AI 的完整参考手册。

---

## 1. 项目概览

**定位**：品牌内容与渠道周复盘看板，不是实时经营后台，不是投放复盘。

**业务链路**：

```
Excel 导出 → 导入预检 → 确认导入 → 看板渲染 → 导出 CSV（可选）
```

**技术栈**：纯静态前端（HTML + CSS + vanilla JS），不接后端数据库，不调用 AI API。使用 XLSX.js 在前端解析 Excel，IndexedDB + localStorage 做本机持久化。

**核心文件**：

| 文件 | 大小 | 职责 |
|------|------|------|
| `index.html` | 47 行 | 页面入口、Google Fonts 引入、DOM 骨架 |
| `styles.css` | ~800 行 | 全部样式、设计令牌、响应式断点 |
| `app.js` | ~4500 行 | 单一 IIFE，导入/计算/渲染/持久化全部逻辑 |
| `review-mock-data.js` | - | 内置样例数据（source + posts + manualModules + dtcSection） |
| `ai-analysis-result.js` | - | 可选的发布用 AI 分析结果（`window.WeeklyReviewAiResult`） |

**访问地址**：`http://127.0.0.1:8864/index.html`（live-server 端口可能变化）

---

## 2. 架构总览

### 2.1 单 IIFE 架构

`app.js` 全部逻辑包裹在 `(function(){ ... })()` 中，无全局变量污染。核心数据流：

```
source (原始数据)
  → preprocessPosts()
    → posts (归一化后的帖子数组，每条含 snapshots)
      → deriveForScope(scope)
        → { poolPosts, currentTotals, previousTotals, channelRows }
          → buildMetricCards + buildNarrative + renderXxx()
            → HTML string → dom.stage.innerHTML
```

### 2.2 4 个视图（Tabs）

| Tab Key | 标签 | 定位 | 渲染函数 |
|---------|------|------|----------|
| `overview` | 总览 | 默认首页，聚合看板 | `renderOverview()` |
| `cohort` | Cohort 曝光矩阵 | 帖子生命周期追踪 | `renderCohort()` |
| `channel` | 渠道诊断 | 横向对比渠道/平台/漏斗/项目/品线 | `renderChannelDiagnosis()` |
| `detail` | 帖子明细 | 完整可筛选表格 + Top 帖/优质内容/主题分析子视图 + 导出 CSV | `renderDetail()` |

默认视图：`state.view = "overview"`。

### 2.3 全局交互

- **顶部导航栏**：4 个 Tab，`button[data-view]` 点击切换
- **指标切换器**：`select#metric-switcher`，可选 曝光量/互动量/互动率/点赞数/评论数/转发数/收藏数
- **周选择器**：点击 `#week-picker-btn` 展开双月日历，支持点击选择自然周（周一至周日），hover 预览
- **导入 Excel**：`#import-data-btn` → `#import-file-input`（accept `.xlsx,.csv`）→ 预检弹窗 → 确认导入
- **恢复内置**：`#reset-data-btn` 清除 IndexedDB + localStorage 导入缓存，恢复 mock data

### 2.4 状态管理

```js
const state = {
  view: "overview",           // 当前视图
  reportStartDate: "",        // 复盘周期开始（ISO string）
  reportEndDate: "",          // 复盘周期结束
  batchStartDate: "",         // 内容批次开始
  batchEndDate: "",           // 内容批次结束
  lifecycleStartDate: "",     // 生命周期样本开始
  lifecycleEndDate: "",       // 生命周期样本结束
  sourceLabel: "内置数据",    // 数据来源标签
  importMeta: null,           // 导入元信息 { fileName, savedAt }
  importAudit: null,          // 导入审计结果 { totalRows, acceptedRows, ... }
  publishMode: false,         // 发布版/工作版切换
  globalMetric: "exposure",   // 全局指标
  filterCache: null           // 明细表筛选选项缓存
};
```

### 2.5 设计令牌（Design Tokens）

定义于 `styles.css` `:root`：

| 变量 | 值 | 用途 |
|------|-----|------|
| `--brand` | `#1a3a2e` | 主色（深绿），进度条、标题、强调 |
| `--brand-light` | `#e8efe9` | 浅主色，边框线、浅底背景 |
| `--accent` | `#b85c1a` | 强调色（暖橙），关键数字、集中度摘要 |
| `--accent-light` | `#fdf2e8` | 浅强调色，卡片背景 |
| `--up` | `#2d7d46` | 上涨/利好绿色 |
| `--down` | `#c94043` | 下跌/风险红色 |
| `--warn` | `#d4831a` | 警告/关注橙黄色 |
| `--muted` | `#8c8c84` | 次要文字 |
| `--line` | `#e8e4df` | 分割线 |
| `--line-strong` | `#d4d0c8` | 强分割线 |
| `--surface` | `#ffffff` | 卡片背景 |
| `--surface-warm` | `#f7f5f1` | 暖色背景（关键发现区） |

**字体**：Google Fonts — DM Sans（正文）、DM Serif Display（标题）、JetBrains Mono（等宽数字）、Noto Sans SC / Noto Serif SC（中文）。

**响应式断点**：1024px（平板）、768px（小平板）、640px（手机）。

---

## 3. 时间口径体系

3.0 区分三个独立的时间概念，同时作用于数据计算：

### 3.1 复盘周期（Review Window）

**定义**：`state.reportStartDate` ~ `state.reportEndDate`，用于计算本期表现指标。

**规则**：
- 必须是完整自然周（周一至周日）。
- 用户选择非完整 7 天时，自动落在最近的完整自然周（`recompute()` 中的 `latestCompleteNaturalWeek()`）。
- 当前周显示为 "W25 2026-05-25 ~ 2026-05-31" 格式。

**自动计算**：`recompute()` 被调用时，同步推算：
  - `previousWindow` = 复盘周 - 7 天（用于环比计算）
  - `batchStartDate` = 复盘周所在月 1 日
  - `batchEndDate` = 复盘周结束日
  - `lifecycleStartDate` = 复盘周前 2 周的周一
  - `lifecycleEndDate` = 复盘周前 1 周的周日

### 3.2 内容批次周期（Batch Window）

**定义**：`state.batchStartDate` ~ `state.batchEndDate`，限定"复盘看哪些发布时间范围内的内容"。

**默认值**：本月 1 日 ~ 复盘周期结束日。

**用途**：在 `filterPostsByScope()` 中筛选 `publishDate` 在批次范围内的帖子。它控制样本池，不是表现窗口。

### 3.3 生命周期样本周（Lifecycle Window）

**定义**：`state.lifecycleStartDate` ~ `state.lifecycleEndDate`，限定 Cohort 矩阵中纳入的发布周范围。

**默认值**：复盘自然周往前两周的发帖周。

**设计缘由**：避免"越早发布数据越高"的天然偏差。Cohort 只观察最近几周的发布内容在各自生命周期中的表现。

---

## 4. 数据层详解

### 4.1 原始数据结构

每条帖子（source.posts[]）的核心字段：

```
id, title, link, platform, channelType, channelName, owner,
contentFormat, contentTopic, featuredQuality,
publishDate, statDate, project, productLine1, productLine2,
collabRequirement, funnelStage, contentSource,
snapshots: [{ dateObj, exposure, interaction, likes, comments, shares, saves }]
```

### 4.2 数据预处理：preprocessPosts()

**位置**：`app.js` ~3300 行

**做了什么**：
1. 遍历 source.posts，解析 `publishDate` → `publishDateObj`（Date 对象）
2. 归一化渠道类型：`normalizeChannelType()` 将原始类型映射为 "社媒"/"KOL"/"社群"
3. 归一化渠道名称：社群统一为大群/lovers/us/uk；社媒/KOL 统一为小写平台名
4. 归一化主题和形式：`normalizeDimension()` 处理 "未知"/"未标记"
5. 为每个 post 生成 `projectKey = project::msku`
6. 解析 snapshots，确保每条 snapshot 的 dateObj 正确
7. 按 publishDate 排序

**输出**：`posts[]`（全局变量），每个 post 附加了归一化后的字段。

### 4.3 指标差分计算：diffMetrics(post, start, end)

**位置**：`app.js` ~3394 行

**核心算法**：

```js
diffMetrics(post, start, end) {
  endCum = cumulativeAt(post, end)       // 截至 end 的累计值
  beforeCum = cumulativeAt(post, start-1) // 截至 start-1 的累计值
  return { exposure: endCum - beforeCum, interaction: ..., likes: ..., comments: ... }
}
```

**关键**：所有指标都是区间增量（不是累计值），确保每个时间窗口的数值独立可比。

**累计函数** `cumulativeAt(post, date)`：遍历 post.snapshots，找到 ≤ date 的最新快照，返回该快照的指标值。如果无快照，返回全 0。

### 4.4 范围派生：deriveForScope(scope)

**位置**：`app.js` ~1126 行

```js
deriveForScope("all")    → deriveFromPosts("all", filterPostsByScope(posts, "all"))
deriveForScope("社群")   → deriveFromPosts("社群", filterPostsByScope(posts, "社群"))
deriveForScope("社媒")   → deriveFromPosts("社媒", filterPostsByScope(posts, "社媒"))
deriveForScope("KOL")    → deriveFromPosts("KOL", filterPostsByScope(posts, "KOL"))
```

**filterPostsByScope 逻辑**：
- `"all"` = 批期内全部帖子 + `!post.excludeFromAll`
- `"社群"/"社媒"/"KOL"` = 对应渠道类型

**deriveFromPosts 输出**：
```js
{
  scope: "社媒",
  poolPosts: [...],       // 范围内的帖子（已过生命周期筛选）
  currentTotals: { exposure, interaction, likes, comments, shares, saves },
  previousTotals: { ... },
  lastYearTotals: { ... },
  currentPostCount: N,
  previousPostCount: N,
  lastYearPostCount: N,
  channelRows: [...]     // buildChannelRows() 的输出
}
```

### 4.5 渠道行：buildChannelRows(items, totals)

**位置**：`app.js` ~3330 行

按 `displayChannelName`（归一化后的渠道名）分组聚合，输出每个渠道的：
- `label`：渠道名
- `exposure`、`interaction`：按复盘窗口差分后求和
- `exposureShare`：该渠道曝光 / 总曝光
- `interactionRate`：互动/曝光
- `posts`：帖子数

### 4.6 漏斗分布：deriveFunnelDistribution(poolPosts)

**位置**：`app.js` ~1249 行

按 `funnelStage` 字段（Awareness / Interest / Consideration / Decision / Loyalty）分组聚合：
- 每层输出：`{ label, posts, exposure, interaction, exposureShare, interactionRate }`
- 只统计有效漏斗层级的帖子

### 4.7 项目/品线聚合

- **`deriveProjectRows(poolPosts)`** (~1190 行)：按 project 字段分组，输出曝光/互动/互动率/帖子数/曝光占比
- **`deriveProductLineRows(poolPosts)`** (~1220 行)：按 `productLine1` 字段分组，同上结构

### 4.8 Cohort 矩阵：buildCohortMatrix(poolPosts, reviewWeekEnd)

**位置**：`app.js` ~1346 行

**算法**：
1. 将所有帖子按发布自然周分组（key = `YYYY-Www`）
2. 取最近 7 个发布周
3. 每个发布周，计算该批帖子在发布后第 1/2/3/4 周的表现：
   - 第 N 周窗口 = publishWeekStart + (N-1)×7 天 ~ + N×7-1 天
   - `mature` = 复盘周结束日 >= 窗口结束日（该周数据已出全）
   - 对窗口内每条帖子的 diffMetrics 求和
4. 输出每行的累计曝光、总互动率、成熟周数

**Cohort 单元格颜色规则**：
- 未成熟单元格 → 浅灰底色
- 数值低于上方同行列均值 30% → 浅红底
- 本周数值 > 上周同行数值 × 1.3 → 显示绿色 ▲

---

## 5. 五个视图详细说明

### 5.1 总览（Overview）

**渲染函数**：`renderOverview()` (~1755 行)

**用途**：默认首页，聚合所有维度的关键信息，回答"本周应该看哪里"。

**页面结构**（从上到下）：

#### (a) 8 个 KPI 卡片（`buildMetricCards("overview")`）

4×2 网格：

| 卡片 | 数据来源 | 计算方式 |
|------|---------|---------|
| 本周帖子数 | `deriveForScope("all").currentPostCount` | 批期内有发布时间且在该 scope 的帖子去重数量 |
| 本周总曝光 | `all.currentTotals.exposure` | 全部帖子的 diffMetrics 求和 |
| 本周总互动 | `all.currentTotals.interaction` | 同上 |
| 本周互动率 | 互动/曝光 | `safeRate(interaction, exposure)` |
| 贴均曝光 | 曝光/帖子数 | `safeRate(curExp, Math.max(curPosts, 1))`，curPosts=0 时返回 0 而非除以全量 |
| 曝光中位数 | 排序取中位 | 全部有曝光帖子的中位数 |
| Top5 曝光占比 | top5 / 总曝光 | < 10% 显示"头部较分散" |
| 优质内容 | `featuredQuality == "1.0"` 的帖子数 | 计数 |

每张卡片带环比箭头（↑ green / ↓ red / → gray），环比阈值 ±10%。

#### (b) 关键发现区（`buildNarrative("overview")`）

程序自动生成的 **4 条**事实陈述，用绿/橙/红/灰圆点标记：

| 发现 | 判断逻辑 | 色调 |
|------|---------|------|
| 总量变化 | `wowExp > 0.1` = 好，`< -0.1` = 坏，其他 = 关注 | 绿/红/橙 |
| 贴均与中位 | 比值 > 5x = 高度集中(橙)，3-5x = 较集中(灰)，< 3x = 相对均匀(绿) | 橙/灰/绿 |
| Top 内容集中度 | Top5占比 > 10% = 集中(橙)，5-10% = 一般(灰)，< 5% = 分散(绿)；同时显示 Top20 占比 | 橙/灰/绿 |
| 复盘入口 | 优质内容有效 > 0 条 = 好，Top渠道曝光占比 | 绿/橙 |

**阈值设计说明**：大样本（1500+帖）下 Top5 几乎不可能达到 30%。合理阈值：10%/5%。贴均/中位比值在右偏分布下必定 > 1，用 5x/3x 分档取代简单的 >= 判断。

#### (c) 三列速览

| 列 | 内容 |
|-----|------|
| 渠道速览 | 社群/社媒/KOL 各一行：指标值 + 帖子数 + Top 来源 |
| 曝光集中度 | 7 档水平条（10万+ / 5-10万 / 1-5万 / 5千-1万 / 1千-5千 / 100-1千 / <100），条宽 = 曝光占比。底部摘要：10万+与5-10万两档 + 1万以上三档合计 |
| 内容速览 | Top 3 帖 + 贴均/中位对比表 |

每列底部有 `→ 进入xxx` 快捷跳转链接。

### 5.2 Cohort 曝光矩阵

**渲染函数**：`renderCohort()` (~2446 行)

**用途**：追踪各发布周的帖子在生命周期第 1-4 周的曝光释放情况。

**页面结构**：

#### (a) 本周总曝光拆解

按发布周拆分本周总曝光，用 CSS 柱状图展示：
- X 轴：各发布周标签（从当前周往前）
- Y 轴：曝光量（自适应刻度）
- 右侧附加卡：最大贡献周 / 新老帖占比 / 数据成熟度

#### (b) Cohort 矩阵表

| 列 | 含义 |
|-----|------|
| 发布周 | 帖子的发布时间所在自然周 |
| 第1周 | 发布后 1-7 天的曝光 |
| 第2周 | 发布后 8-14 天 |
| 第3周 | 发布后 15-21 天 |
| 第4周 | 发布后 22-28 天 |
| 累计曝光 | 4 周曝光合计 |
| 互动率 | 总互动 / 总曝光 |

**单元格内容**：曝光量（大字）+ 成熟度状态（已跑天数/14天 或 "✓ 跑满"）+ 异常标记（绿色 ▲ 表示横向大于上方同行列 1.3 倍）

**颜色规则**：
- 本周发布周行 → 加底色高亮
- 未成熟单元格 → 浅灰底色
- 同一列中数值低于上方同行列均值 30% → 浅红底文

**交互**：
- 点击发布周标签 → 右侧展开详情面板（品线分布 + 渠道分布 + Top 5 帖子）
- 详情面板可关闭

### 5.3 渠道诊断

**渲染函数**：`renderChannelDiagnosis()` (~1847 行)

**用途**：横向对比渠道、平台、漏斗、项目、品线的表现差异。

**页面结构**：

#### (a) 渠道热力图

- 默认显示"社媒+KOL"视图，可通过 chip 按钮切换到"社群"
- 社媒+KOL：按渠道类型（行）× 平台（列）的交叉表，单元格 = 曝光量 + 环比箭头（↑ green / ↓ red / → gray），颜色深浅 = 相对占比
- 社群：按群名的互动量条形图（社群无曝光口径）

**热力图数据源**：`buildChannelHeatmap(poolPosts.filter(p => p.normalizedChannelType !== "社群"))`

#### (b) 贴均曝光对比表

只显示社媒和 KOL 两行（社群不参与曝光比较）：

| 范围 | 有表现帖 | 总曝光 | 贴均曝光 | 相对整体 | Top来源 |
|------|---------|--------|---------|---------|---------|
| 社媒 | N | X | X/N | ↑/↓/→ | platform |
| KOL | N | X | X/N | ↑/↓/→ | platform |

颜色规则：高于整体贴均 130% = 绿色，低于 70% = 红色，中间 = 灰色。

#### (c) 三列对比

| 列 | 内容 | 渲染函数 |
|-----|------|----------|
| 漏斗分布 | Awareness→Interest→Consideration→Decision→Loyalty 逐层曝光+互动率 | inline（CSS 条形图） |
| 项目对比 | Top 6 项目按曝光排序，显示曝光/互动/互动率 | inline（CSS 条形图） |
| 品线排行 | Top 5 品线，带互动率红/黄/绿定性 | `renderProductLineRanking()` |

**漏斗图说明**：只统计非社群帖子（社群无曝光、无漏斗）。每层显示曝光条形图 + 互动率 + 曝光占比。

**品线互动率颜色规则**：< 2% = 红色，2-3% = 黄色，> 3% = 绿色。

### 5.4 内容排行榜

**渲染函数**：`renderRanking()` (~2059 行)

**用途**：发现 Top 内容、优质内容和主题规律。

**三个子 Tab**（chip button 切换）：

#### (a) Top 帖子（默认）

- 前 20 条按曝光降序
- 列：#, 标题（可点击链接）, 发布人, 渠道, 发布周, 曝光, 互动, 互动率, 品线
- 可通过 select 筛选：全部渠道 / 社媒 / KOL / 社群

#### (b) 优质内容

- 筛选 `featuredQuality == "1.0"` 的帖子
- 展示前 50 条，按互动量降序
- 汇总：优质帖数 + 总曝光 + 总互动

#### (c) 主题分析

- 解析 `contentTopic`（分号分隔，一个帖子可取多个主题）
- 按主题分组聚合：帖子数 + 曝光 + 互动 + 互动率
- 条形图展示（曝光占比为条宽）
- 按曝光降序

### 5.5 帖子明细

**渲染函数**：`renderDetail()` (~2286 行)

**用途**：完整可筛选、可排序、可导出的数据表格。

**功能**：

1. **筛选器**：6 个下拉（渠道类型 / 平台 / 品线 / 项目 / 主题 / 形式）+ 负责人搜索输入框
   - 下拉使用 `<button>` + 浮层 checkbox 方式（非原生 `<select>`）
   - 支持多选，选中项显示为 tag 标签
2. **排序**：点击表头可升/降序排列（数值列和文本列均支持）
3. **列**：17 列（序号/发布时间/渠道类型/平台/品线/项目/主题/形式/优质/标题/负责人/曝光/互动/点赞/评论/分享/收藏）
4. **标题列**：有 link 则渲染为可点击链接（新标签页打开）
5. **分页**：每页 25 条，首页/上一页/下一页/末页
6. **操作按钮**：重置筛选 / 仅优质 / 导出 CSV
7. **底部统计条**：总数 + 总曝光 + 总互动 + 当前页信息

**数据存储**：`window.__weeklyDetailTables[tableId]` 保存 `{ allRows, filteredRows, postsById }`。

**性能**：首次渲染全部行的 HTML，通过 CSS `display:none` 隐藏第 26 行开始的 tr（`onerror` img hack 实现）。

**站外数据**：`renderOffsiteDetailSection()` 追加在明细表底部，展示站外来源的曝光、来源数量和占比结构。不进入内容原因判断。

---

## 6. 数据导入流程

### 6.1 导入触发

1. 用户点击"导入 Excel"按钮
2. 选择 `.xlsx` 或 `.csv` 文件
3. XLSX.js 解析 → `handleImportFile()`

### 6.2 导入预检（Import Precheck Modal）

**在 Modal 中展示**：

| 信息 | 含义 |
|------|------|
| 文件名 | 导入的原始文件名 |
| 工作表 | Sheet 名称 |
| 总行数 | Excel 数据行数 |
| 有效行数 | 通过必填字段校验的行数 |
| 跳过行数 | 缺少必填字段的行数 |
| 日期范围 | 统计日期范围 |
| 渠道分布 | 社媒/KOL/社群各多少条 |
| 缺失字段 | 必填字段缺失计数、建议字段缺失计数 |
| 重复链接 | 同一链接出现多次的计数 |

### 6.3 必填字段

| 字段 | Excel 列名（模糊匹配） |
|------|----------------------|
| statDate | 统计日期 |
| publishDate | 发布时间 |
| channelType | 渠道类型 / 渠道大类 / 类型 |
| channelName | 渠道名称 / 平台 / 渠道 |

缺少任一必填字段 → 该行跳过，不计入数据集。

### 6.4 建议字段

| 字段 | 缺失影响 |
|------|---------|
| owner（负责人） | 无法归因到人，详情表显示"未知" |
| link（帖子链接） | 标题不可点击，无法跳转原帖 |

缺失不阻断导入，但会记录在 audit 中。

### 6.5 确认导入

点击"确认导入"后：
1. `normalizeImportedRow()` 对每行做字段映射和归一化
2. `buildPostsFromImportedRows()` 构建 posts 数组（含 snapshots）
3. 新 source 合并到全局 `source`
4. 持久化到 IndexedDB（主） + localStorage（兜底分片）
5. `recompute()` 重新计算所有日期范围
6. `render()` 刷新页面

### 6.6 恢复数据

- 刷新页面 → `loadPersistedImport()` 从 IndexedDB/localStorage 恢复上次导入
- 点击"恢复内置" → 清除缓存 + 恢复 mock data
- AI 草稿和人工确认不会被清除

---

## 7. 持久化体系

| 数据 | 存储方式 | Key |
|------|---------|-----|
| 导入的 source 数据 | IndexedDB（主） + localStorage 分片（兜底） | `weekly-review-dashboard` / `latest-import.{token}` |
| AI 草稿 | localStorage | `weekly-review-dashboard.3.ai-result.{token}` |
| 长期假设池 | localStorage | `weekly-review-dashboard.3.long-term-hypotheses.{token}` |
| 复用经验/避雷区 | localStorage | `weekly-review-dashboard.3.playbook.{scope}` |
| 负责人确认 | localStorage | `weekly-review-dashboard.3.confirmation.{postId}` |
| 帖子复盘 | localStorage | `weekly-review-dashboard.3.post-review.{postId}` |

**重要限制**：
- 所有数据只在当前浏览器/设备有效
- 不是多人共享事实源
- 周共享依赖导出静态文件后上传 Netlify
- 如需多人协作需迁移到飞书多维表或后端 API

---

## 8. 指标口径速查

### 8.1 核心指标计算

| 指标 | 公式 | 函数 |
|------|------|------|
| 曝光量 | `sum(diffMetrics(post, start, end).exposure)` | `diffMetrics()` |
| 互动量 | `sum(diffMetrics(post, start, end).interaction)` | 同上 |
| 互动率 | `互动量 / 曝光量` | `safeRate(interaction, exposure)` |
| 贴均曝光 | `曝光量 / 有曝光帖子数` | `safeRate(curExp, curPosts)` |
| 曝光中位数 | 排序后取中位 | 数组排序 `[mid]` |
| 环比变化 | `(本期值 - 上期值) / max(|上期值|, 1)` | `safeWoW(cur, prev)` |
| Top5 曝光占比 | `top5Sum / totalExp` | `safeRate(sum(top5), curExp)` |

### 8.2 环比颜色规则

| 条件 | 颜色 | CSS 变量 |
|------|------|----------|
| > +10% | 绿色 | `var(--up)` |
| < -10% | 红色 | `var(--down)` |
| ±10% 内 | 灰色 | `var(--muted)` |

### 8.3 社群特殊口径

社群渠道**没有曝光口径**，**没有互动率口径**：
- 不显示曝光相关卡片
- 不显示互动率
- 不参与漏斗分布（漏斗只统计非社群）
- 不参与贴均曝光对比
- Cohort 矩阵中社群帖子不参与曝光计算
- 只看：互动量 + 帖子数 + 群分布 + Top 互动帖 + 互动拆分（点赞/评论/分享/收藏）

### 8.4 指标格式化

| 函数 | 效果 |
|------|------|
| `formatCompact(n)` | 1,234,567 → "123.5万" |
| `formatInteger(n)` | 1,234,567 → "1,234,567" |
| `formatPct(r)` | 0.0234 → "2.3%" |
| `formatDelta(d)` | 0.15 → "+15%" |

---

## 9. 程序边界（什么能算，什么不能算）

### 程序可以直接生成（事实层）

- 指标汇总（求和/平均/中位数/占比）
- Top 来源/帖子/品线/项目
- 环比变化（数值 → 百分比）
- 曝光集中度分档
- 生命周期窗口数据
- 数据质量审计（缺失字段/重复链接/日期范围）
- 主题分布统计

### 程序不能替代人工判断的

- 内容为什么好（不是"曝光高"就算好）
- 是否可复用（需要看原帖脚本、达人语境、产品展示方式）
- 是否只是账号/达人/发布时间/平台机制驱动
- 是否有活动、置顶、社群氛围、实际执行等数据包外背景
- 最终汇报口径

---

## 10. 设计原则

1. **先事实，后判断**：程序只算事实，原因判断留给人工
2. **社群不越界**：社群不和社媒/KOL 按曝光横向比较，只做互动维度的轻量复盘
3. **颜色有含义**：绿色=向好，红色=风险，橙色=关注，灰色=平稳/中性
4. **数据不静默**：导入审计始终可见，缺失字段不悄悄跳过
5. **环比可追溯**：所有环比都基于上周同口径，阈值 ±10% 统一
6. **不编造口径**：社群不写曝光和互动率；站外数据不和内容表现做因果推断

---

## 11. 已知限制与已知 Bug

### 已知 Bug

| 问题 | 位置 | 严重度 |
|------|------|--------|
| `globalMetric` 指标切换器无效 | `state.globalMetric` 被写入但无渲染函数读取，切换指标后页面数据不变 | **低** — UI 存在但不生效 |

### 已知限制

- 纯静态前端，不支持多人同时填写
- localStorage/IndexedDB 只在当前浏览器有效
- 不直接调用 AI API，AI 分析需手动导出提示词 → GPT → 导入 JSON
- 部分帖子缺少 link，无法打开原帖做内容判断
- 长期假设池只有内置默认假设，无新增/编辑/暂停 UI
- 发布到 Netlify 后，帖子数仓同步走 Netlify Functions + Blobs；本地人工填写内容仍不会自动同步
- 大片数据（20000+ 行）明细表首次渲染可能卡顿（当前靠 display:none 做虚拟分页）

---

## 12. 后续开发建议（优先级排序）

1. **修复/删除 `globalMetric` 指标切换器**：要么实现全局指标联动（所有 render 函数读取 `state.globalMetric`），要么移除该 select
2. **工作版/发布版切换完善**：发布版隐藏 AI 草稿、待确认项，只保留确认后的口径（`state.publishMode` 已有但未全局生效）
3. **长期假设池管理 UI**：新增/编辑/暂停假设的能力
4. **负责人填写导出**：将人工确认内容导出为结构化文件，便于迁移到飞书多维表
5. **迁移多人协作数据源**：localStorage → 飞书多维表或后端 API
6. **明细表性能优化**：大数据量下的虚拟滚动或后端分页
7. **AI 导入结构校验**：更细粒度的 JSON schema 校验，防止字段不匹配

---

## 13. 接手方快速入口

**项目路径**：`d:\projects\nail-attribution-console-demo\output\weekly-review-dashboard\3.0`

**本地运行**：
```bash
cd 3.0
npx live-server --port=8864
```

**每次改动后**：
```bash
node --check app.js    # 语法检查
# 浏览器访问 http://127.0.0.1:8864/index.html
# F12 Console → 检查无 error
# 验证：导航切换、导入 Excel、指标切换器、周选择器、明细表筛选/排序/分页/导出
```

**核心文件改动指南**：
- 改样式 → `styles.css`（追加在末尾，不删现有类）
- 改渲染 → `app.js` 中对应 `renderXxx()` 函数
- 改计算 → `app.js` 中 `derive*()` / `build*()` 函数
- 改导入 → `app.js` 中 `normalizeImportedRow()` / `handleImportFile()`
- 改持久化 → `app.js` 中 `load*()` / `save*()` 函数

**一句话总结**：

> 3.0 是品牌内容周复盘看板，不是 AI 自动写结论的报表。程序算事实，人工做判断。5 个 Tab 覆盖从总览到明细的完整分析链路，社群/社媒/KOL 各自按独立口径分析，数据口径贯穿导入→差分→聚合→展示全链路。

---

## 14. 最近关键修复记录

| 日期 | 修复 | 影响 |
|------|------|------|
| 2026-06-01 | `curPosts \|\| all.poolPosts.length` → `Math.max(curPosts, 1)`（3处） | 贴均曝光不再误除以全量 |
| 2026-06-01 | 贴均/中位比值判断从 `>=` 改为 5x/3x 分档 | 不再恒显示"需关注" |
| 2026-06-01 | Top5 集中度阈值从 30% 改为 10%/5%，新增 Top20 占比 | 大样本下阈值合理 |
| 2026-06-01 | 集中度底部摘要改为两档+三档两个数字 | 解读更精确 |
| 2026-06-01 | 中位数标注改为"X 帖（本周有曝光数据）" | 口径更清晰 |
| 2026-05-29 | 集中度条高度 18px → 28px | 视觉可读性 |
| 2026-05-29 | 贴均曝光对比表过滤掉"非社群整体"行 | 只显示社媒/KOL |
| 2026-05-29 | `projectKey` 字段生成补全 | 漏斗/项目面板不再为空 |
