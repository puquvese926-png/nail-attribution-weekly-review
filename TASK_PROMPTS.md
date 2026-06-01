# 全局数据校验修复

## 根因诊断

| 问题 | 根因 | 影响范围 | 严重度 |
|------|------|---------|--------|
| 贴均曝光 fallback 错误 | `curPosts\|\|all.poolPosts.length` — curPosts=0 时分母变成 20000+ | buildMetricCards、buildNarrative、renderOverview 三处 | **严重** |
| 曝光中位数 count 不等于帖子数 | `exposureValues` 只过滤 `exposure>0`，而 `curPosts` 计数 `exposure>0\|\|interaction>0` | renderOverview 内容速览表 | 中 |
| 贴均/中位比值判断永真 | `avgExp >= medianExp` 在右偏分布下恒成立，永远显示"需关注" | buildNarrative("overview") | 中 |
| Top5集中度判断阈值不适合大样本 | 阈值 30% 对 2万帖完全不适用，Top5=3.4% 却显示"分散" | buildNarrative("overview") | 中 |
| 三处重复计算贴均和中位数 | buildMetricCards、buildNarrative、renderOverview 各算一次，维护风险 | 总览 Tab | 低 |

---

## 线程 B（唯一线程）：app.js 数据修复

```copy
## 任务：修复总览 Tab 的数据计算 bug

### 背景
总览 Tab 的贴均曝光、曝光中位数、集中度判断存在多处计算口径错误和阈值不当的问题。全部在 `app.js` 中修复，只改数据计算逻辑，不改 CSS 和 HTML。

### 涉及文件
- 修改：`3.0/app.js`
- 只读：无

### 修改清单

**1. buildMetricCards("overview") — 贴均曝光 fallback（约 1487 行）**

搜索：
```js
const avgExp = safeRate(curExp, curPosts || all.poolPosts.length || 1);
const prevAvgExp = safeRate(prevExp, prevPosts || all.poolPosts.length || 1);
```

替换为：
```js
const avgExp = safeRate(curExp, Math.max(curPosts, 1));
const prevAvgExp = safeRate(prevExp, Math.max(prevPosts, 1));
```

原因：curPosts=0 时不应该除以全量帖子数（20000+），应该直接返回 0。

**2. buildNarrative("overview") — 贴均曝光 fallback（约 1542 行）**

搜索：
```js
const avgExp = safeRate(curExp, curPosts || all.poolPosts.length || 1);
```

替换为：
```js
const avgExp = safeRate(curExp, Math.max(curPosts, 1));
```

原因：同上。

**3. renderOverview() — 贴均曝光 fallback（约 1762 行）**

搜索：
```js
const avgExp = safeRate(curExp, curPosts || all.poolPosts.length || 1);
```

替换为：
```js
const avgExp = safeRate(curExp, Math.max(curPosts, 1));
```

原因：同上。

**4. buildNarrative("overview") — 贴均/中位比值判断（约 1558 行）**

当前逻辑：
```js
tone: avgExp >= medianExp && medianExp > 0 ? "is-warn" : "is-good",
```

替换为：
```js
tone: medianExp > 0 && avgExp / medianExp > 5 ? "is-warn" : medianExp > 0 && avgExp / medianExp > 3 ? "is-neutral" : "is-good",
```

原因：
- 贴均 ≥ 中位 在右偏分布下恒成立，原来的判断永远是 "is-warn"
- 应该看比值：>5倍=高度集中(橙)、3-5倍=较集中(灰)、<3倍=相对均匀(绿)
- 用实际数据验证：贴均 3万 / 中位 3900 ≈ 7.7倍 → "is-warn" 正确

对应的 body 文字也更新（约 1559-1560 行）：

当前：
```js
body: `贴均曝光 ${formatCompact(avgExp)}，曝光中位数 ${formatCompact(medianExp)}。两者差距越大，说明曝光越集中在少数内容。`
```

替换为：
```js
body: `贴均曝光 ${formatCompact(avgExp)}，中位数 ${formatCompact(medianExp)}，差 ${(avgExp / Math.max(medianExp, 1)).toFixed(1)} 倍。${avgExp / Math.max(medianExp, 1) > 5 ? "曝光高度集中在头部内容。" : avgExp / Math.max(medianExp, 1) > 3 ? "曝光有一定集中度。" : "曝光分布相对均匀。"}`
```

**5. buildNarrative("overview") — Top5集中度阈值（约 1563 行）**

当前逻辑：
```js
tone: top5Share >= 0.3 ? "is-warn" : "is-good",
```

替换为：
```js
tone: top5Share >= 0.1 ? "is-warn" : top5Share >= 0.05 ? "is-neutral" : "is-good",
```

原因：2万帖的样本下，Top5 占比 30% 几乎不可能（实际约 3.4%）。合理阈值：>10%=集中、5-10%=一般、<5%=分散。

对应的 body（约 1564-1565 行），更新占比描述：

当前：
```js
body: `Top5 曝光占比 ${formatPct(top5Share)}；${topPost ? `最高单帖 ${formatCompact(topPost.m.exposure)}，渠道为 ${topPost.displayChannelName || topPost.channelName || topPost.platform || "未知渠道"}。` : "当前暂无可排序内容。"}`
```

替换为：
```js
body: `Top5 曝光占比 ${formatPct(top5Share)}（Top20占比约 ${formatPct(safeRate(sum(top20.map(p=>p.m.exposure)), curExp))}）；${topPost ? `最高单帖 ${formatCompact(topPost.m.exposure)}（${topPost.displayChannelName || topPost.channelName || topPost.platform || "未知"}·${topPost.owner || "未知"}）。` : "当前暂无可排序内容。"}`
```

注意：需要先在 `top5` 下面新增：
```js
const top20 = all.poolPosts.map(post => ({ ...post, m: diffMetrics(post, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 20);
```

**6. renderOverview — 内容速览 exposureValues.length 标注（约 1825 行）**

当前：
```js
<tr><td class="label">曝光中位数</td><td>${formatInteger(exposureValues.length)} 帖有曝光</td>
```

改为：
```js
<tr><td class="label">曝光中位数</td><td>${formatInteger(exposureValues.length)} 帖（本周有曝光数据）</td>
```

原因：明确这是"本周有曝光"的帖子数，不是全部帖子数。

**7. renderOverview — 曝光集中度解读（约 1789 行）**

当前：
```js
const highBucketExposure = sum(buckets.slice(0, 3), bucket => bucket.exposure);
```

替换为：
```js
const highBucketExposure = sum(buckets.slice(0, 2), bucket => bucket.exposure);
```

对应的底部摘要（约 1790 行）：
```js
`1万以上曝光档贡献 ${formatPct(safeRate(highBucketExposure, curExp))}。`
```

替换为：
```js
`10万+与5-10万两档贡献 ${formatPct(safeRate(highBucketExposure, curExp))}；1-5万以上三档合计 ${formatPct(safeRate(sum(buckets.slice(0,3),bucket=>bucket.exposure), curExp))}。`
```

### 不改的边界
- 不修改 `safeRate()`、`safeWoW()` 等工具函数
- 不修改 `deriveForScope()`、`diffMetrics()` 的数据计算逻辑
- 不修改 CSS 和 HTML 结构
- 不修改其他 Tab 的数据逻辑
- 不修改 `buildNarrative` 对非 overview tabKey 的分支

### 自检清单
- [ ] `node --check app.js` 零报错
- [ ] 贴均曝光 = 总曝光 / 有表现帖子数（不是 /20000）
- [ ] 贴均/中位比值 >5 时关键发现显示橙点，比值数字正确
- [ ] Top5 占比 3.4% 时显示"分散"（绿点），>10% 时显示"集中"（橙点）
- [ ] Top20 占比数据出现在关键发现中
- [ ] 内容速览表"曝光中位数"行明确标注"本周有曝光数据"
- [ ] 曝光集中度底部摘要改为两档和三档两个数字
- [ ] 切换周选择器后数据刷新正确
- [ ] 无 console error
```

---

## 集成验收

```copy
### 数据校验清单

**基础数据一致性**
- [ ] 打开总览 Tab → 第一行 4 张卡片数值与 Cohort Tab 的卡片数值一致
- [ ] 贴均曝光 = 总曝光 / 有表现帖子数（在浏览器 console 中验证：卡片曝光值 / 帖子数 ≈ 卡片贴均值）
- [ ] 曝光中位数 > 0 且 < 贴均曝光（右偏分布）
- [ ] 7 个集中度区间的曝光之和 ≈ 总曝光（允许四舍五入误差）

**边界情况**
- [ ] 切换到无数据的周 → 卡片显示 0 或 "-"，不显示 NaN 或 undefined
- [ ] 贴均/中位比值在 5x 以上时显示橙点"高度集中"
- [ ] Top5 占比 <5% 时显示绿点"分散"

**关键发现**
- [ ] 4 条关键发现都显示，圆点颜色与实际数据匹配
- [ ] 贴均/中位差值倍数显示正确
- [ ] Top20 占比数字出现

**不通过处理**
任一 ❌ → 退回线程 B 重改。
```
