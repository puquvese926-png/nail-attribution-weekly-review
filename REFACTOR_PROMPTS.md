# 3.0 全局重构 · 任务拆分

## 使用方式

三个代码块分别复制给 Codex 的三个线程，可同时启动。线程 B 如担心 class 名不一致，等线程 A 完成后再启动。

---

## 线程 A：styles.css 完全重写

```copy
## 任务：重写 3.0/styles.css

### 背景
当前 styles.css 是 2.0 迁移过来的，配色（蓝白灰）、字体（系统默认）、间距都不统一，"一股 AI 味"。需要从零重写，建立完整的视觉系统。

### Design Tokens（直接复制到 :root）

```css
:root {
  /* 底色 */
  --bg: #fafaf8;
  --surface: #ffffff;
  --surface-warm: #f7f5f1;

  /* 文字 */
  --ink: #1a1a18;
  --ink-secondary: #5c5c56;
  --muted: #8c8c84;

  /* 主色 - 深墨绿代替蓝色 */
  --brand: #1a3a2e;
  --brand-light: #e8efe9;

  /* 强调 - 琥珀 */
  --accent: #b85c1a;
  --accent-light: #fdf2e8;

  /* 语义色 */
  --up: #2d7d46;
  --down: #c94043;
  --warn: #d4831a;

  /* 边框 */
  --line: #e8e4df;
  --line-strong: #d4d0c8;

  /* 间距 4px 基准 */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;

  /* 圆角 */
  --radius-sm: 4px;
  --radius: 8px;
  --radius-lg: 12px;

  /* 阴影 */
  --shadow-card: 0 1px 3px rgba(26,58,46,0.06);
  --shadow-panel: 0 4px 16px rgba(26,58,46,0.06);
  --shadow-popover: 0 12px 40px rgba(26,58,46,0.12);

  /* 字体 */
  --font-display: 'DM Serif Display', 'Noto Serif SC', serif;
  --font-body: 'DM Sans', 'Noto Sans SC', sans-serif;
  --font-mono: 'JetBrains Mono', 'Cascadia Code', monospace;
}
```

### 字体层级

- h1/h2 用 `--font-display`，h3/h4 用 `--font-body`
- 正文 14px / line-height 1.6
- 标签文字 12px / 600
- 辅助说明 11px / 1.5
- 数值卡片主数字 24px / 700 / `--font-mono`
- 表格数字 13px / 500 / `--font-mono`，右对齐

### 需要实现的 CSS 类（按顺序）

**1. 全局 reset + body**
- `* { box-sizing:border-box; margin:0; padding:0 }`
- `body { font-family: var(--font-body); background: var(--bg); color: var(--ink); font-size: 14px; line-height: 1.6; }`

**2. 布局容器**
- `.app-shell` — flex column, min-height 100dvh
- `.workspace` — flex:1, max-width 1400px, padding: 16px 24px 40px, margin: 0 auto

**3. 顶部导航栏**
- `.top-bar` — sticky, flex, white bg, border-bottom, padding 10px 24px
- `.brand` — font-display, 18px, 700, color: var(--brand)，前面有小菱形 ◈
- `.nav-tabs` — flex, gap 0，导航项之间无间隙
- `.nav-tab` — padding 8px 20px, font-size 13px, color: var(--muted), border-bottom: 3px solid transparent
- `.nav-tab:hover` — color: var(--ink)
- `.nav-tab.is-active` — color: var(--brand), border-bottom-color: var(--brand), font-weight: 600
- `.week-display` — margin-left: auto
- `.button-sm` — padding 6px 14px, font-size 12px, border: 1px solid var(--line), border-radius var(--radius-sm), background var(--surface)
- `.button-sm:hover` — background var(--surface-warm)

**4. 指标卡片**
- `.metric-grid` — grid, repeat(4, 1fr), gap var(--space-4)
- `@media (max-width: 1024px)` → repeat(2, 1fr)
- `@media (max-width: 640px)` → 1fr
- `.metric-card` — white bg, padding 20px 24px, border-radius var(--radius), box-shadow var(--shadow-card), position relative, overflow hidden
- `.metric-card::after` — content '', position absolute, bottom 0, left 0, right 0, height 3px, border-radius 0 0 var(--radius) var(--radius)
- `.metric-card.is-up::after` — background var(--up)
- `.metric-card.is-down::after` — background var(--down)
- `.metric-card.is-flat::after` — background var(--muted)
- `.metric-card-label` — font-size 12px, color var(--muted), font-weight 600, text-transform uppercase, letter-spacing 0.5px, margin-bottom 8px
- `.metric-card-value` — font-family var(--font-mono), font-size 24px, font-weight 700, color var(--ink)
- `.metric-card-delta` — font-size 12px, font-weight 600, margin-top 4px
- `.metric-card-delta.is-up` — color var(--up)
- `.metric-card-delta.is-down` — color var(--down)
- `.metric-card-delta.is-flat` — color var(--muted)

**5. 综述区**
- `.narrative-panel` — white bg, padding var(--space-6), border-radius var(--radius), box-shadow var(--shadow-card)
- `.narrative-panel .narrative-title` — font-size 14px, font-weight 700, color var(--brand), padding-bottom var(--space-3), border-bottom 2px solid var(--brand-light), margin-bottom var(--space-4)
- `.narrative-item` — font-size 13px, line-height 1.8, padding 2px 0, color var(--ink-secondary)
- `.narrative-item strong` — color var(--ink), font-weight 600
- `.narrative-item .is-up` — color var(--up)
- `.narrative-item .is-down` — color var(--down)

**6. Panel 通用**
- `.panel` — white bg, padding var(--space-6), border-radius var(--radius), box-shadow var(--shadow-card), margin-bottom var(--space-5)
- `.panel-head` — flex, justify-content space-between, align-items flex-start, margin-bottom var(--space-4)
- `.panel-title h3` — font-size 15px, font-weight 700, color var(--ink)
- `.panel-title p` — font-size 12px, color var(--muted), margin-top 2px

**7. 曝光拆解左右两栏**
- `.breakdown-layout` — display grid, grid-template-columns 1fr 340px, gap var(--space-6)
- `@media (max-width: 768px)` → 1fr
- `.breakdown-side` — flex column, gap var(--space-3)
- `.breakdown-side-card` — padding var(--space-4), background var(--surface-warm), border-radius var(--radius-sm), border 1px solid var(--line)
- `.breakdown-side-card .card-label` — font-size 11px, color var(--muted), text-transform uppercase, letter-spacing 0.5px
- `.breakdown-side-card .card-value` — font-family var(--font-mono), font-size 18px, font-weight 700, margin-top 4px
- `.breakdown-side-card .card-note` — font-size 12px, color var(--muted), margin-top 4px

**8. Cohort 矩阵表**
- `.cohort-table` — width 100%, border-collapse collapse, font-size 12px
- `.cohort-table thead` — position sticky, top 0, z-index 5
- `.cohort-table th` — padding 10px 8px, text-align center, font-size 11px, font-weight 700, color var(--muted), background var(--surface-warm), border-bottom 2px solid var(--line-strong)
- `.cohort-table td` — padding 0, border-bottom 1px solid var(--line)
- `.cohort-row.is-current-week` — background var(--brand-light)
- `.cohort-row:hover` — background var(--surface-warm)
- `.cohort-cell` — text-align center, padding 10px 8px
- `.cohort-cell-value` — font-family var(--font-mono), font-size 13px, font-weight 700
- `.cohort-cell-maturity` — font-size 10px, color var(--muted)
- `.cohort-cell.is-immature` — background var(--surface-warm)
- `.cohort-cell.is-up .cohort-cell-value` — color var(--up)
- `.cohort-cell.is-empty` — color var(--muted)

**9. 渠道热力图**
- `.heatmap-table` — width 100%, border-collapse collapse, font-size 13px
- `.heatmap-table th` — text-align center, padding 10px 10px, font-size 11px, font-weight 700, color var(--muted), border-bottom 2px solid var(--line-strong)
- `.heatmap-row-label` — padding 12px 16px, font-weight 700, color var(--ink), font-size 12px
- `.heatmap-cell` — text-align center, padding 12px 10px, vertical-align middle
- `.heatmap-cell.is-empty` — color var(--muted)
- `.heatmap-value` — font-family var(--font-mono), font-size 15px, font-weight 700, margin-bottom 4px
- `.heatmap-wow` — font-size 10px, font-weight 700
- `.heatmap-wow.is-up` — color var(--up)
- `.heatmap-wow.is-down` — color var(--down)
- `.heatmap-wow.is-alert` — color var(--down), background var(--accent-light), padding 1px 5px, border-radius 3px

**10. 三列网格**
- `.three-col-grid` — display grid, grid-template-columns repeat(3, 1fr), gap var(--space-4)
- `@media (max-width: 900px)` → 1fr

**11. 品线排名 / 渠道条**
- `.bar-list` — flex column, gap 0
- `.bar-row` — padding 10px 0, border-bottom 1px solid var(--line), display grid, grid-template-columns 120px 1fr auto, gap var(--space-4), align-items center, font-size 13px
- `.bar-name` — font-weight 600
- `.bar-track` — height 8px, background var(--line), border-radius 999px, overflow hidden
- `.bar-fill` — height 100%, border-radius 999px, background var(--brand)
- `.bar-value` — font-family var(--font-mono), font-size 12px, color var(--muted), text-align right, white-space nowrap

**12. 排行榜**
- `.ranking-toolbar` — flex, gap 0, border-bottom 2px solid var(--line)
- `.tab-underline` — padding 8px 18px, font-size 13px, color var(--muted), background none, border none, border-bottom 3px solid transparent, cursor pointer
- `.tab-underline.is-active` — color var(--brand), border-bottom-color var(--brand), font-weight 600

**13. 筛选栏**
- `.filter-bar` — flex, flex-wrap wrap, gap var(--space-2), align-items center
- `.filter-btn` — display inline-flex, align-items center, gap 6px, padding 6px 14px, height 34px, border 1px solid var(--line), border-radius var(--radius-sm), background var(--surface), font-size 13px, cursor pointer, white-space nowrap
- `.filter-btn:hover` — border-color var(--brand)
- `.filter-btn.is-active` — border-color var(--brand), background var(--brand-light)
- `.filter-btn .arrow` — font-size 10px, color var(--muted)
- `.filter-popover` — position absolute, top calc(100% + 4px), left 0, z-index 50, min-width 200px, max-height 300px, overflow-y auto, background var(--surface), border 1px solid var(--line), border-radius var(--radius), box-shadow var(--shadow-popover), padding 8px 0
- `.filter-popover-search` — margin 0 8px 8px, padding 6px 10px, border 1px solid var(--line), border-radius var(--radius-sm), width calc(100% - 16px), font-size 13px
- `.filter-popover-item` — display flex, align-items center, gap 8px, padding 8px 12px, cursor pointer, font-size 13px
- `.filter-popover-item:hover` — background var(--surface-warm)
- `.filter-popover-item .check` — width 16px, height 16px, border 2px solid var(--line), border-radius 3px, flex-shrink 0
- `.filter-popover-item.is-checked .check` — background var(--brand), border-color var(--brand)
- `.filter-tag` — display inline-flex, align-items center, gap 4px, padding 2px 10px, background var(--brand-light), border-radius 999px, font-size 12px, color var(--brand)
- `.filter-tag .tag-close` — cursor pointer, font-size 14px, opacity 0.6
- `.filter-tag .tag-close:hover` — opacity 1

**14. 帖子明细表**
- `.data-table` — width 100%, border-collapse collapse, font-size 12px
- `.data-table th` — padding 10px 8px, font-size 11px, color var(--muted), font-weight 700, text-align left, border-bottom 2px solid var(--line-strong), background var(--surface-warm), white-space nowrap
- `.data-table td` — padding 8px, border-bottom 1px solid var(--line), vertical-align top
- `.data-table td.num` — font-family var(--font-mono), text-align right, font-variant-numeric tabular-nums
- `.data-table tr:nth-child(even)` — background var(--surface-warm)
- `.data-table tr:hover` — background var(--brand-light)
- `.link-cell` — color var(--brand), text-decoration none
- `.link-cell:hover` — text-decoration underline

**15. 分页**
- `.pagination` — flex, justify-content center, align-items center, gap var(--space-2), margin-top var(--space-4), font-size 12px

**16. 社群条**
- `.community-bars` — 同上 .bar-list 样式

**17. 按钮系统补充**
- `.btn-primary` — background var(--brand), color white, border none, padding 8px 18px, border-radius var(--radius-sm), font-size 13px, cursor pointer
- `.btn-primary:hover` — opacity 0.9
- `.btn-ghost` — background transparent, border 1px solid var(--line), color var(--ink)

**18. 响应式断点**
- 1024px: metric-grid 2列，workspace padding 减小
- 768px: breakdown-layout 单列，three-col-grid 单列，panel padding 减小，cohort-table 可横向滚动
- 480px: metric-grid 单列，top-bar 换行，nav-tabs 滚动

**19. 打印样式**
```css
@media print {
  .top-bar, .filter-bar, .pagination, button { display: none; }
  .panel { box-shadow: none; border: 1px solid #ccc; break-inside: avoid; }
  body { background: white; font-size: 11px; }
}
```

### 规则
- 不要保留任何旧 CSS，从零写
- 不使用 !important
- 不出现 #2563eb、#0f172a、#3b82f6、Inter、Roboto
- 所有颜色通过 var() 引用

### 自检清单
- [ ] :root 中无旧颜色变量残留
- [ ] 响应式三个断点都有规则
- [ ] 所有 class 命名语义化
- [ ] 打印样式在文件末尾
- [ ] 没有 !important
```

---

## 线程 B：app.js HTML 结构清理 + 类名规范化

```copy
## 任务：清理 3.0/app.js 的 HTML 结构

### 背景
app.js 中有大量 inline style（200+ 处），HTML 结构混乱，renderDetail() 有语法错误。保持所有计算逻辑不变，只改 HTML 生成部分。

### 不碰的内容（非常重要）
- 所有 `deriveXxx()` 函数
- 所有 `buildXxx()` 计算函数（buildWeekBreakdown, buildCohortMatrix, buildLifecycleRows, buildChannelHeatmap 等）
- `diffMetrics()`, `preprocessPosts()`, `normalizeXxx()` 等数据处理
- 导入/导出逻辑（handleImportFile 等）
- AI 工作台、长期验证、证据链逻辑
- 事件绑定（bindGlobalEvents 等）

### 任务清单

**1. 修复 renderDetail() 语法错误（约 2142 行）**
当前代码把 `state.filterCache = {...}` 写在了 return 的模板字符串内部。修复：
- 把 `state.filterCache = { channelType: channelTypes, ... }` 移到 `return` 语句之前（`detailStore[tableId] = {...}` 之后）
- 删除模板字符串内残留的 JS 代码块
- 删除第 2121 行未使用的 `const renderOptions = ...`

**2. 系统性地替换 inline style 为 CSS class**

搜索并替换以下模式（在 return 的 HTML 模板字符串中）：

| 搜索 | 替换 |
|------|------|
| `style="font-size:12px;color:var(--muted);margin-bottom:10px;"` | `class="section-desc"` |
| `style="display:flex;gap:8px;"` | `class="btn-group"` |
| `style="display:flex;gap:4px;"` | `class="btn-group-sm"` |
| `style="display:flex;gap:6px;"` | `class="btn-group-xs"` |
| `style="padding:8px 0;border-bottom:1px solid var(--line);"` | `class="bar-row-divider"` |
| `style="font-size:11px;color:var(--muted);"` | `class="text-caption"` |
| `style="font-size:12px;color:var(--muted);"` | `class="text-meta"` |
| `style="margin-top:10px;"` | `class="mt-3"` |
| `style="margin-top:8px;"` | `class="mt-2"` |
| `style="margin-top:6px;"` | `class="mt-1"` |
| `style="margin-bottom:12px;"` | `class="mb-3"` |
| `style="min-width:120px;"` | `class="min-w-sm"` |
| `style="min-width:100px;"` | `class="min-w-xs"` |

注：`mt-*` / `mb-*` 作为工具类补充到 styles.css：
```css
.mt-1 { margin-top: 6px; } .mt-2 { margin-top: 8px; } .mt-3 { margin-top: 10px; }
.mb-3 { margin-bottom: 12px; }
.min-w-xs { min-width: 100px; } .min-w-sm { min-width: 120px; }
.text-caption { font-size: 11px; color: var(--muted); }
.text-meta { font-size: 12px; color: var(--muted); }
.section-desc { font-size: 12px; color: var(--muted); margin-bottom: 10px; }
.btn-group { display: flex; gap: 8px; }
.btn-group-sm { display: flex; gap: 4px; }
.btn-group-xs { display: flex; gap: 6px; }
```

**3. renderCohort() — 曝光拆解改为左右两栏**

当前只有竖条图。改为：
- 左栏(60%)：竖条图（保持 .week-breakdown）
- 右栏(40%)：两个小卡片
  - 卡片1 "最大贡献周"：显示 `breakdown.rows[0]` 的 key + 曝光 + 占比 + 一句描述
  - 卡片2 "数据成熟度"：当前发布周帖子的已跑天数/14 + 成熟度百分比

布局用 `.breakdown-layout` > `.breakdown-left` + `.breakdown-right`

**4. renderChannelDiagnosis() — 修复社群 + 三列并排**

- `buildChannelHeatmap()` 的 types 数组改为 `["社媒", "KOL"]`
- 热力图下方新增社群 section：
  ```html
  <section class="panel">
    <div class="panel-head">
      <div class="panel-title"><h3>社群互动分布</h3><p>社群仅统计互动，无曝光口径。</p></div>
    </div>
    <div class="community-bars">
      <!-- deriveForScope("社群").poolPosts 按 channelName 分组，互动条 -->
    </div>
  </section>
  ```
- 漏斗分布 / 项目对比 / 品线排行 用 `.three-col-grid` 三列并排

**5. renderRanking() — Tab 改下划线样式**

把 `class="chip-button"` 改为 `class="tab-underline"`，active 状态用 `.is-active`

**6. 数字列加 class**

所有 `<td>` 中渲染数字时加 `class="num"`：
- 曝光、互动、点赞、评论、分享、收藏、互动率 列

**7. buildNarrative() — 叙事区样式调整**

返回的 HTML 从蓝左边框改为白底 panel：
```html
<section class="panel narrative-panel">
  <div class="narrative-title">本周综述</div>
  ${lines.map((l, i) => `<p class="narrative-item">${i+1}. ${l}</p>`).join("")}
</section>
```

叙事内容中，数字、渠道名用 `<strong>` 包裹，涨跌用 `<span class="is-up/down">`

**8. 底部统计条**

表格底部的统计文字加 class `detail-stats`（已有），确认 CSS 中有对应规则。

### 自检清单
- [ ] `node --check app.js` 零报错
- [ ] 搜索 `style=` 在 app.js 中 ≤ 30 处
- [ ] `buildChannelHeatmap` 的 types = `["社媒", "KOL"]`
- [ ] renderCohort 有 `.breakdown-layout` 结构
- [ ] 漏斗/项目/品线在 `.three-col-grid` 内
- [ ] 叙事区无 `border-left:4px solid`
- [ ] 所有数字列 td 带 `class="num"`
- [ ] renderDetail 无语法错误，state.filterCache 在 return 前
```

---

## 线程 C：index.html 语义化 + 字体

```copy
## 任务：优化 3.0/index.html

### 任务清单

**1. 加载字体**

在 `<head>` 中添加：
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&family=JetBrains+Mono:wght@500;700&display=swap" rel="stylesheet">
```

**2. 语义化标签**

- `<main id="view-stage">` 加 `role="main" aria-live="polite"`
- `<nav id="nav-tabs">` 加 `role="navigation" aria-label="视图切换"`
- 导入按钮加 `aria-label="导入 Excel 或 CSV 文件"`
- 重置按钮加 `aria-label="恢复内置样例数据"`
- 周选择器按钮加 `aria-label="选择复盘周期，当前为 W22"`

**3. 标题和图标**

- `<title>` 改为 "周复盘看板 · 品牌营销"
- Favicon 改为 emoji data URI：`<link rel="icon" href="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22><text y=%22.9em%22 font-size=%2290%22>📊</text></svg>">`

**4. 移除 `?v=3.7` 等缓存破坏参数（或更新为 `?v=4.0`）**

### 自检清单
- [ ] title 已更新
- [ ] Google Fonts 链接存在
- [ ] main 有 role="main"
- [ ] nav 有 role="navigation"
- [ ] 按钮有 aria-label
- [ ] Favicon 不是空白
```

---

## 集成验收清单（全部线程完成后）

```copy
### 集成验收

**控制台检查**
- [ ] 浏览器 console 无 error、无 warning
- [ ] Network 面板确认字体加载成功（DM Sans 等）

**功能检查**
- [ ] 四个 Tab 全部能点击切换，当前 Tab 高亮正确
- [ ] 指标卡片四个都有数据，无 "undefined" 或 "NaN"
- [ ] 帖子明细六个筛选下拉全部能展开、选项可见、选择后表格刷新
- [ ] 负责人搜索输入后表格刷新（有防抖，不是每次按键）
- [ ] 导入 Excel 后数据重算、卡片刷新
- [ ] 恢复内置数据正常
- [ ] 本周总曝光拆解左右两栏显示正常
- [ ] 社群 section 显示四个群组（大群/lovers群/us群/uk群）

**视觉检查**
- [ ] 1920px 宽屏：四卡片等宽撑满
- [ ] 375px 移动端：四卡片单列、左右栏堆叠、无横向滚动
- [ ] 旧蓝色（#2563eb、#0f172a、#3b82f6）不出现在页面上
- [ ] 字体实际渲染为 DM Sans（DevTools computed font-family）

**不通过处理**
上述任一项 ❌ → 退回对应线程重改，通过前不得合并。
```
