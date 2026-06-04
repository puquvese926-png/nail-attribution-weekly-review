(function(){
  const initialSource = window.WeeklyReviewMockData;
  if (!initialSource) throw new Error("Weekly review data is missing.");

  const DAY_MS = 24 * 60 * 60 * 1000;
  const APP_VERSION = "3.0";
  const IMPORT_DB_NAME = "weekly-review-dashboard";
  const IMPORT_DB_VERSION = 1;
  const IMPORT_STORE_NAME = "imports";
  const BUILTIN_DATASET_TOKEN = `${initialSource.currentSample || "sample"}-${(initialSource.posts || []).length}`;
  const IMPORT_CACHE_KEY = `latest-import.${BUILTIN_DATASET_TOKEN}`;
  const IMPORT_FALLBACK_META_KEY = `weekly-review-dashboard.import-cache.${BUILTIN_DATASET_TOKEN}.meta`;
  const IMPORT_FALLBACK_CHUNK_PREFIX = `weekly-review-dashboard.import-cache.${BUILTIN_DATASET_TOKEN}.chunk.`;
  const IMPORT_FALLBACK_CHUNK_SIZE = 500000;
  const AI_RESULT_KEY = `weekly-review-dashboard.3.ai-result.${BUILTIN_DATASET_TOKEN}`;
  const LONG_TERM_POOL_KEY = `weekly-review-dashboard.3.long-term-hypotheses.${BUILTIN_DATASET_TOKEN}`;
  const OFFSITE_CACHE_KEY = `weekly-review-dashboard.3.offsite-cache.${BUILTIN_DATASET_TOKEN}`;
  const PLAYBOOK_PREFIX = "weekly-review-dashboard.3.playbook";
  const CONFIRM_PREFIX = "weekly-review-dashboard.3.confirmation";
  const POST_REVIEW_PREFIX = "weekly-review-dashboard.3.post-review";
  const LONG_TERM_SUPPORT_TARGET = 6;
  const LONG_TERM_RECENT_WINDOW = 4;
  const LONG_TERM_RECENT_THRESHOLD = 3;
  const REQUIRED_IMPORT_FIELDS = ["statDate", "publishDate", "channelType", "channelName"];
  const RECOMMENDED_IMPORT_FIELDS = ["owner", "link"];

  const VIEWS = [
    { key: "overview", label: "总览", short: "览", scope: "all", subtitle: "本周核心指标、关键发现和各维度速览。" },
    { key: "cohort", label: "Cohort 曝光矩阵", short: "矩", scope: "all", subtitle: "一屏看完所有发布周的帖子在各自生命周期内的曝光表现。" },
    { key: "channel", label: "渠道诊断", short: "诊", scope: "all", subtitle: "横向对比各渠道、平台、项目，发现异常。" },
    { key: "detail", label: "帖子明细", short: "细", scope: "all", subtitle: "完整可筛选表格，支持下钻、排行和导出。" }
  ];

  const state = {
    view: "overview",
    reportStartDate: "",
    reportEndDate: "",
    offsiteStartDate: "",
    offsiteEndDate: "",
    batchStartDate: "",
    batchEndDate: "",
    lifecycleStartDate: "",
    lifecycleEndDate: "",
    sourceLabel: "内置数据",
    importMeta: null,
    importAudit: null,
    publishMode: false,
    filterCache: null
  };

  const dom = {
    nav: document.getElementById("nav-tabs"),
    stage: document.getElementById("view-stage"),
    weekLabel: document.getElementById("week-label"),
    weekRange: document.getElementById("week-range"),
    importBtn: document.getElementById("import-data-btn"),
    resetBtn: document.getElementById("reset-data-btn"),
    importInput: document.getElementById("import-file-input"),
    toast: document.getElementById("toast"),
    weekPickerBtn: document.getElementById("week-picker-btn"),
    detailPanel: document.getElementById("publish-week-detail")
  };

  let source = cloneData(initialSource);
  let posts = [];
  let reviewWindow = parseReviewWindow(initialSource.reviewWeek && initialSource.reviewWeek.dateRange);
  let previousWindow = { start: addDays(reviewWindow.start, -7), end: addDays(reviewWindow.end, -7) };
  let aiResult = null;
  let activeRangeCleanup = null;
  let toastTimer = null;

  init();

  async function init(){
    bindGlobalEvents();
    loadAiResult();
    const restored = await loadPersistedImport();
    if (restored && restored.source) {
      source = mergeImportedSource(restored.source);
      state.sourceLabel = "文件数据";
      state.importMeta = restored.source.importMeta || { fileName: "上次导入文件", savedAt: restored.savedAt || "" };
      state.importAudit = restored.source.importAudit || null;
    }
    setDefaultRangesFromSource();
    restoreOffsiteStateFromCache();
    recompute();
    applyCachedOffsiteForCurrentRange();
    render();
  }

  function bindGlobalEvents(){
    dom.nav.addEventListener("click", event => {
      const button = event.target.closest("[data-view]");
      if (!button) return;
      const nextView = button.dataset.view;
      if (!nextView || nextView === state.view) return;
      state.view = nextView;
      render();
    });

    dom.importBtn.addEventListener("click", () => dom.importInput.click());
    dom.importInput.addEventListener("change", handleImportFile);

    dom.resetBtn.addEventListener("click", async () => {
      if (!window.confirm("确认恢复内置数据？这会清除本机导入缓存，但不会清除 AI 草稿和人工确认。")) return;
      source = cloneData(initialSource);
      state.sourceLabel = "内置数据";
      state.importMeta = null;
      state.importAudit = null;
      await clearPersistedImport();
      setDefaultRangesFromSource(true);
      recompute();
      render();
      showToast("已恢复内置数据，本机导入缓存已清除。");
    });

    if (dom.weekPickerBtn) dom.weekPickerBtn.addEventListener("click", openWeekPicker);

    dom.stage.addEventListener("click", event => {
      const quickLink = event.target.closest(".quick-link[data-view]");
      if (!quickLink) return;
      event.preventDefault();
      const nextView = quickLink.dataset.view;
      if (!VIEWS.some(view => view.key === nextView)) return;
      state.view = nextView;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    dom.stage.addEventListener("click", handleStageClick);
    dom.stage.addEventListener("input", handleStageInput);
    if (dom.detailPanel) dom.detailPanel.addEventListener("click", handleStageClick);
  }

  function setDefaultRangesFromSource(force = false){
    const nextReview = resolveDefaultReviewWindow(source);
    reviewWindow = nextReview;
    if (force || !state.reportStartDate) state.reportStartDate = formatDate(nextReview.start);
    if (force || !state.reportEndDate) state.reportEndDate = formatDate(nextReview.end);
    const offsiteDefault = { start: addDays(nextReview.start, -7), end: addDays(nextReview.end, -7) };
    if (force || !state.offsiteStartDate) state.offsiteStartDate = formatDate(offsiteDefault.start);
    if (force || !state.offsiteEndDate) state.offsiteEndDate = formatDate(offsiteDefault.end);
    const reportEnd = parseDate(state.reportEndDate) || nextReview.end;
    const monthStart = new Date(reportEnd.getFullYear(), reportEnd.getMonth(), 1);
    const lifecycleDefault = resolveLifecycleDefaultRange(reportEnd);
    if (force || !state.batchStartDate) state.batchStartDate = formatDate(monthStart);
    if (force || !state.batchEndDate) state.batchEndDate = state.reportEndDate;
    if (force || !state.lifecycleStartDate) state.lifecycleStartDate = formatDate(lifecycleDefault.start);
    if (force || !state.lifecycleEndDate) state.lifecycleEndDate = formatDate(lifecycleDefault.end);
  }

  function recompute(){
    const requestedReportRange = resolveDateRange(state.reportStartDate, state.reportEndDate, resolveDefaultReviewWindow(source));
    const reportRange = latestCompleteNaturalWeek(requestedReportRange.end);
    state.reportStartDate = formatDate(reportRange.start);
    state.reportEndDate = formatDate(reportRange.end);
    reviewWindow = reportRange;
    previousWindow = { start: addDays(reportRange.start, -7), end: addDays(reportRange.end, -7) };
    const offsiteRange = resolveLifecycleWeekRange(state.offsiteStartDate, state.offsiteEndDate, previousWindow);
    state.offsiteStartDate = formatDate(offsiteRange.start);
    state.offsiteEndDate = formatDate(offsiteRange.end);
    const fallbackBatch = { start: new Date(reportRange.end.getFullYear(), reportRange.end.getMonth(), 1), end: reportRange.end };
    const batchRange = resolveDateRange(state.batchStartDate, state.batchEndDate, fallbackBatch);
    state.batchStartDate = formatDate(batchRange.start);
    state.batchEndDate = formatDate(batchRange.end);
    const lifecycleRange = resolveLifecycleWeekRange(
      state.lifecycleStartDate,
      state.lifecycleEndDate,
      resolveLifecycleDefaultRange(reportRange.end)
    );
    state.lifecycleStartDate = formatDate(lifecycleRange.start);
    state.lifecycleEndDate = formatDate(lifecycleRange.end);
    posts = preprocessPosts(source.posts || []);
    syncLongTermHypothesisPool();
  }

  function render(){
    closeActiveRangePicker();
    const view = getActiveView();
    updateWeekDisplay();
    renderNav();
    dom.stage.classList.toggle("is-publish-mode", state.publishMode);
    dom.stage.innerHTML = renderActiveView(view);
  }

  function updateWeekDisplay(){
    const week = naturalWeekRange(reviewWindow.end);
    if (dom.weekLabel) dom.weekLabel.textContent = "W" + weekOfYear(week.start);
    if (dom.weekRange) dom.weekRange.textContent = `${formatDate(week.start)} ~ ${formatDate(week.end)}`;
  }

  function renderNav(){
    dom.nav.innerHTML = VIEWS.map(view => `
      <button class="nav-tab ${view.key === state.view ? "is-active" : ""}" type="button" data-view="${view.key}" aria-current="${view.key === state.view ? "page" : "false"}">
        ${escapeHtml(view.label)}
      </button>
    `).join("");
  }

  function renderStatus(){
    const all = deriveForScope("all");
    const dataStatus = state.importMeta
      ? `已导入 · ${state.importMeta.fileName || "文件"} · ${formatInteger(all.poolPosts.length)}帖 · 本机缓存`
      : `内置数据 · ${formatInteger(all.poolPosts.length)}帖`;
    const aiStatus = aiResult
      ? `${aiResult.status || "AI草稿"} · ${aiResult.importedAt || aiResult.generatedAt || "待确认"}`
      : "AI草稿未导入";
    dom.statusStrip.innerHTML = [
      pill(`复盘周期 ${state.reportStartDate} ~ ${state.reportEndDate}`, "local"),
      pill(`批次周期 ${state.batchStartDate} ~ ${state.batchEndDate}`, "local"),
      pill(dataStatus, state.importMeta ? "local" : ""),
      pill(aiStatus, aiResult ? "ai" : "warning")
    ].join("") + `<div class="version-toggle" data-action="toggle-publish" role="radiogroup" aria-label="版本切换">
  <button class="version-option ${state.publishMode ? "" : "is-active"}" type="button" data-version="work" role="radio" aria-checked="${!state.publishMode}">工作版</button>
  <button class="version-option ${state.publishMode ? "is-active" : ""}" type="button" data-version="publish" role="radio" aria-checked="${state.publishMode}">发布版</button>
</div>`;
    dom.railStatus.innerHTML = `<strong>当前状态</strong><div>${escapeHtml(dataStatus)}</div><div>${escapeHtml(aiStatus)}</div>`;
  }

  function renderActiveView(view){
    if (view.key === "overview") return renderOverview();
    if (view.key === "cohort" || view.key === "cohrt") return normalizeMetricCopy(renderCohort());
    if (view.key === "channel") return renderChannelDiagnosis();
    if (view.key === "detail") return renderDetail();
    return "";
  }

  function normalizeMetricCopy(html){
    return String(html || "")
      .replace(/本周总曝光拆解/g, "本周新增曝光拆解")
      .replace(/按发布周拆解本周的总曝光贡献。/g, "按发布周拆解复盘周期新增曝光贡献。")
      .replace(/本周发布帖子贡献最大/g, "复盘周期发布帖贡献最大")
      .replace(/本周帖/g, "复盘周期帖")
      .replace(/本周占比/g, "复盘周期帖占比")
      .replace(/ \(本周\)/g, " (最新发布周)");
  }

  function renderAnalysisPanel(all){
    const projectRows = deriveProjectRows(all.poolPosts).slice(0, 8);
    const funnelRows = deriveFunnelDistribution(all.poolPosts);
    const renderBars = (rows, metric) => {
      if (!rows.length) return renderEmpty("暂无数据。");
      const vals = rows.map(row => asNumber(row[metric]));
      const maxV = Math.max(1, ...vals);
      return `<div class="bar-list">${rows.map(row => {
        const v = asNumber(row[metric]);
        const w = Math.max(2, (v / maxV * 100).toFixed(1));
        return `<div class="bar-row">
          <div class="bar-name">${escapeHtml(row.label)}</div>
          <div class="bar-track"><span class="bar-fill" style="width:${w}%"></span></div>
          <div class="bar-value">${formatCompact(v)} · ${formatPct(row.exposureShare)}${row.interactionRate != null ? " · 互动率 " + formatPct(row.interactionRate) : ""}</div>
        </div>`;
      }).join("")}</div>`;
    };
    return `<section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>分析对比</h3><p>可切换查看项目/品线表现或营销漏斗分布。</p></div>
        <div style="display:flex;gap:4px;">
          <button class="chip-button is-active" type="button" data-panel-toggle="project">项目</button>
          <button class="chip-button" type="button" data-panel-toggle="funnel">漏斗</button>
        </div>
      </div>
      <div data-panel-content="project">${renderBars(projectRows, "exposure")}</div>
      <div data-panel-content="funnel" hidden>${renderBars(funnelRows, "exposure")}</div>
    </section>`;
  }

  function renderChannelSummaryPanel(community, social, kol){
    return `<section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>分渠道摘要</h3><p>用于管理层快速定位每个渠道当前最应该复盘的地方。</p></div>
      </div>
      <div class="three-col">
        ${renderChannelMiniCard("社群", community, "interaction")}
        ${renderChannelMiniCard("社媒", social, "exposure")}
        ${renderChannelMiniCard("KOL", kol, "exposure")}
      </div>
    </section>`;
  }

  function renderCommunityTable(poolPosts){
    if (!poolPosts.length) return renderEmpty("暂无社群帖子数据。");
    const headers = ["群名","标题","发布时间","点赞","评论","转发","收藏","总互动","负责人"];
    const rows = poolPosts.map(post => {
      const latest = post.snapshots && post.snapshots.length ? post.snapshots[post.snapshots.length - 1] : {};
      return [
        escapeHtml(post.displayChannelName || post.channelName || "未知群"),
        escapeHtml(post.title || "无标题"),
        escapeHtml(post.publishDate || ""),
        formatInteger(latest.likes || 0),
        formatInteger(latest.comments || 0),
        formatInteger(latest.shares || 0),
        formatInteger(latest.saves || 0),
        formatInteger(latest.interaction || 0),
        escapeHtml(post.owner || "未知")
      ];
    });
    return renderSimpleTable(headers, rows);
  }

  function renderProgramConclusionCard(item){
    return `<article class="program-card">
      <div class="program-card-kicker">程序结论</div>
      <h4>${escapeHtml(item.title)}</h4>
      <p>${escapeHtml(item.body)}</p>
    </article>`;
  }

  function renderChannelDetailTable(poolPosts){
    if (!poolPosts.length) return renderEmpty("暂无数据。");
    const headers = ["标题","平台","发布时间","曝光","互动","点赞","评论","分享","收藏","负责人"];
    const rows = poolPosts.slice(0, 100).map(post => {
      const latest = post.snapshots && post.snapshots.length ? post.snapshots[post.snapshots.length - 1] : {};
      return [
        escapeHtml((post.title || "无标题").substring(0, 40)),
        escapeHtml(post.displayChannelName || post.platform || ""),
        escapeHtml(post.publishDate || ""),
        formatInteger(latest.exposure || 0),
        formatInteger(latest.interaction || 0),
        formatInteger(latest.likes || 0),
        formatInteger(latest.comments || 0),
        formatInteger(latest.shares || 0),
        formatInteger(latest.saves || 0),
        escapeHtml(post.owner || "未知")
      ];
    });
    const tooMany = poolPosts.length > 100 ? `<p style="margin-top:8px;color:var(--muted);font-size:12px;">仅显示前 100 条，共 ${formatInteger(poolPosts.length)} 条。</p>` : "";
    return renderSimpleTable(headers, rows) + tooMany;
  }

  function renderChannelView(scope){
    const derived = deriveForScope(scope);
    const isCommunity = scope === "社群";
    const metric = isCommunity ? "interaction" : "exposure";
    const topPosts = topPostsForScope(scope, metric, 10);
    
    if (isCommunity) return renderCommunityView(derived, topPosts);
    
    // === 社媒 / KOL ===
    const cards = channelMetricCards(derived, false);
    const programCards = buildChannelProgramConclusions(scope, derived, topPosts);
    const channelRows = derived.channelRows;
    const lifecycleRows = buildLifecycleRows(derived.lifecyclePoolPosts, false);
    const funnelRows = deriveFunnelDistribution(derived.poolPosts);
    const allPosts = derived.poolPosts;
    
    return `
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>${escapeHtml(scope)}表现复盘</h3><p>围绕曝光、互动、漏斗效率和 Top 帖做深度复盘。</p></div>
        ${pill("程序事实", "local")}
      </div>
      <div class="metric-grid">${cards.map(renderMetricCard).join("")}</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>程序结论</h3><p>程序自动聚合和排序得出的事实，不包含原因判断。</p></div>
      </div>
      <div class="program-grid">${programCards.map(item => renderProgramConclusionCard(item)).join("")}</div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>渠道分布</h3><p>各平台/来源的曝光和互动贡献对比。</p></div>
      </div>
      ${renderBarPanel("曝光贡献", channelRows.map(row => ({ label: row.label, exposure: row.exposure, interaction: row.interaction })), "exposure")}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>营销漏斗</h3><p>该渠道在各漏斗层级的曝光分布和互动效率。</p></div>
        ${pill("程序事实", "local")}
      </div>
      ${renderFunnelChart(funnelRows, "")}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>Top 帖子</h3><p>按${escapeHtml(metric === "exposure" ? "曝光" : "互动")}排序的 Top 10 帖。</p></div>
      </div>
      ${renderTopPostsTable(topPosts, metric)}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>生命周期趋势</h3><p>当前发帖周样本发布后第1-4周的曝光和互动释放节奏。</p></div>
        ${pill("程序事实", "local")}
      </div>
      ${renderLineChart(lifecycleRows, false)}
    </section>

    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>明细数据</h3><p>该渠道全部帖子的关键指标明细。</p></div>
      </div>
      ${renderChannelDetailTable(allPosts)}
    </section>
    <section class="panel">
      <div class="panel-head">
        <div class="panel-title"><h3>复用经验与避雷区</h3><p>负责人填写，长期保留。</p></div>
        ${pill("人工维护", "local")}
      </div>
      ${renderPlaybookCard(scope)}
    </section>
    `;
  }

  function buildLifecycleMethodology(sampleCount, isCommunity){
    return {
      sample: `当前渠道下，只纳入发帖周 ${state.lifecycleStartDate} ~ ${state.lifecycleEndDate} 的帖子，共 ${sampleCount} 帖。`,
      selectionRule: "默认取复盘自然周往前两周；可切换到其他发帖自然周。",
      metric: isCommunity ? "只汇总互动。" : "汇总曝光和互动。",
      calculation: "每个生命周期窗口用统计日期快照做累计差分：窗口结束累计值减去窗口前一日累计值；未走完的后续周按已有快照计算，不做外推。",
      windows: [
        "第1周=发布后1-7天",
        "第2周=发布后8-14天",
        "第3周=发布后15-21天",
        "第4周=发布后22-28天"
      ],
      note: "生命周期窗口看的是发帖后的第1-4周，不是自然周走势。"
    };
  }

  function renderAiDraftSummaryItem(item){
    return '<div class="summary-item">' +
      '<strong>' + escapeHtml(item.title || "未命名") + "</strong>" +
      '<div style="font-size:12px;color:var(--muted);line-height:1.5;">' +
      (item.conclusion ? '<p style="margin:4px 0;">' + escapeHtml(item.conclusion) + "</p>" : "") +
      (item.ownerQuestion ? '<p style="margin:4px 0;color:var(--violet);">&#x2753; ' + escapeHtml(item.ownerQuestion) + "</p>" : "") +
      "</div></div>";
  }

  function renderAiChannelDraftCard(item){
    return '<article class="program-card is-ai" style="margin-bottom:10px;">' +
      '<div class="program-card-kicker">AI 草稿 · ' + escapeHtml(item.channel || "") + "</div>" +
      "<h4>" + escapeHtml(item.title || "未命名") + "</h4>" +
      (item.conclusion ? "<p>" + escapeHtml(item.conclusion) + "</p>" : "") +
      (item.ownerQuestion ? '<p class="program-card-question">' + escapeHtml(item.ownerQuestion) + "</p>" : "") +
      "</article>";
  }

  function renderAiPlaybookDraftCard(item){
    return '<article class="program-card is-ai" style="margin-bottom:10px;">' +
      '<div class="program-card-kicker">复用建议 · ' + escapeHtml(item.channel || "") + "</div>" +
      "<h4>" + escapeHtml(item.title || "未命名") + "</h4>" +
      (item.reusableExperienceDraft ? "<p><strong>可复用方向：</strong>" + escapeHtml(item.reusableExperienceDraft) + "</p>" : "") +
      (item.pitfallDraft ? "<p><strong>避雷点：</strong>" + escapeHtml(item.pitfallDraft) + "</p>" : "") +
      (item.ownerQuestion ? '<p class="program-card-question">' + escapeHtml(item.ownerQuestion) + "</p>" : "") +
      "</article>";
  }

  function handleStageClick(event){
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (!action) return;

    if (action === "expand-publish-week") {
      const weekKey = event.target.closest("[data-week-key]")?.dataset.weekKey;
      if (!weekKey) return;
      const all = deriveForScope("all");
      const allPosts = preprocessPosts(source.posts || []);
      const matrix = buildCohortMatrix(allPosts, reviewWindow.end);
      const row = matrix.find(item => item.cohortWeek === weekKey || item.key === weekKey) || null;
      renderPublishWeekDetail(weekKey, row, allPosts);
      return;
    }

    if (action === "remove-filter") {
      const key = event.target.closest("[data-remove-filter]")?.dataset.removeFilter;
      if (key) {
        state._activeFilters = state._activeFilters || {};
        state._activeFilters[key] = "";
        const tableEl = event.target.closest("[data-detail-table-id]");
        updateFilterTags(tableEl);
        if (tableEl) applyDetailFilters(tableEl.dataset.detailTableId);
      }
      return;
    }
    if (action === "clear-all-filters") {
      state._activeFilters = {};
      const tableEl = event.target.closest("[data-detail-table-id]");
      tableEl?.querySelectorAll(".detail-filter[data-filter], .date-range-input[data-filter-date]").forEach(input => {
        input.value = "";
      });
      if (tableEl) updateDetailDateRangeLabel(tableEl);
      updateFilterTags(tableEl);
      if (tableEl) applyDetailFilters(tableEl.dataset.detailTableId);
      return;
    }
    if (action === "close-detail") {
      if (dom.detailPanel) {
        dom.detailPanel.hidden = true;
        dom.detailPanel.innerHTML = "";
      }
      return;
    }

    if (action === "refresh-offsite-data") {
      const btn = event.target.closest("[data-action='refresh-offsite-data']");
      refreshOffsiteData(btn);
      return;
    }

    if (action === "refresh-warehouse-posts") {
      const btn = event.target.closest("[data-action='refresh-warehouse-posts']");
      refreshWarehousePosts(btn);
      return;
    }

    if (action === "offsite-week-picker") {
      const btn = event.target.closest("[data-action='offsite-week-picker']");
      openOffsiteWeekPicker(btn);
      return;
    }

    if (action === "panel-toggle") {
      const btn = event.target.closest("[data-panel-toggle]");
      if (!btn) return;
      const panel = btn.closest(".panel");
      if (!panel) return;
      const type = btn.dataset.panelToggle;
      panel.querySelectorAll("[data-panel-toggle]").forEach(b => b.classList.toggle("is-active", b === btn));
      panel.querySelectorAll("[data-panel-content]").forEach(el => { el.hidden = el.dataset.panelContent !== type; });
      return;
    }

    if (action === "heatmap-toggle") {
      const btn = event.target.closest("[data-heatmap-toggle]");
      if (!btn) return;
      const panel = btn.closest(".panel");
      if (!panel) return;
      const type = btn.dataset.heatmapToggle;
      panel.querySelectorAll("[data-heatmap-toggle]").forEach(b => b.classList.toggle("is-active", b === btn));
      panel.querySelectorAll("[data-heatmap-content]").forEach(el => { el.hidden = el.dataset.heatmapContent !== type; });
      return;
    }

    if (action === "detail-view-mode") {
      const btn = event.target.closest("[data-view-mode]");
      if (!btn) return;
      const root = btn.closest("[data-detail-table-id]");
      if (!root) return;
      const mode = btn.dataset.viewMode;
      const tableId = root.dataset.detailTableId;
      root.querySelectorAll("[data-view-mode]").forEach(b => b.classList.toggle("is-active", b === btn));
      const store = (window.__weeklyDetailTables || {})[tableId];
      if (!store) return;
      let nextRows = null;
      if (mode === "detail") {
        nextRows = store.allRows.slice();
      } else if (mode === "top") {
        const sorted = store.allRows.slice().sort((a, b) => (b.exposure || 0) - (a.exposure || 0));
        nextRows = sorted.slice(0, 20);
      } else if (mode === "quality") {
        nextRows = store.allRows.filter(row => {
          const q = String(row.featuredQuality || "").trim();
          return q === "1.0" || q === "1";
        });
      } else if (mode === "topic") {
        const groups = new Map();
        store.allRows.forEach(row => {
          const topic = asText(row.topic) || "未知";
          if (!groups.has(topic)) groups.set(topic, { topic, count: 0, exposure: 0, interaction: 0 });
          const g = groups.get(topic);
          g.count++;
          g.exposure += asNumber(row.exposure);
          g.interaction += asNumber(row.interaction);
        });
        const topicRows = Array.from(groups.values()).sort((a, b) => b.exposure - a.exposure);
        const maxExposure = Math.max(1, ...topicRows.map(row => row.exposure));
        const bars = topicRows.map(row => {
          const interactionRate = safeRate(row.interaction, row.exposure);
          const width = Math.max(3, Number((row.exposure / maxExposure * 100).toFixed(1)));
          let tone = "is-green";
          if (interactionRate < 0.02) tone = "is-red";
          else if (interactionRate <= 0.03) tone = "is-amber";
          return `<div class="bar-row topic-bar-row">
            <div class="bar-name">${escapeHtml(row.topic)}</div>
            <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
            <div class="bar-value">帖数 ${formatInteger(row.count)} · 曝光 ${formatCompact(row.exposure)} · 互动 ${formatCompact(row.interaction)} · <span class="topic-rate-badge ${tone}">互动率 ${formatPct(interactionRate)}</span></div>
          </div>`;
        }).join("");
        const tbody = root.querySelector("tbody");
        if (tbody) {
          tbody.innerHTML = `<tr><td colspan="16">${bars ? `<div class="bar-list">${bars}</div>` : renderEmpty("当前周期暂无主题分析数据。")}</td></tr>`;
          tbody.querySelectorAll("[data-detail-row]").forEach(row => { row.style.display = "none"; });
        }
        root.dataset.currentPage = "0";
        const pageLabel = root.querySelector("[data-detail-page-label]");
        if (pageLabel) pageLabel.textContent = "1";
        return;
      }
      if (nextRows) {
        root.dataset.currentPage = "0";
        const pageLabel = root.querySelector("[data-detail-page-label]");
        if (pageLabel) pageLabel.textContent = "1";
        store.filteredRows = nextRows;
        updateDetailTable(tableId, store.filteredRows, 0);
      }
      return;
    }

    if (action === "open-lifecycle-range") {
      openLifecycleWeekPicker(event.target.closest("[data-lifecycle-range-control]"));
      return;
    }

    if (action === "toggle-filter-dropdown") {
      const key = event.target.dataset.filterKey;
      openFilterPopover(key, event.target);
      return;
    }
    if (action === "detail-date-range") {
      const btn = event.target.closest("[data-action='detail-date-range']");
      if (btn) openDetailDateRangePicker(btn);
      return;
    }
    if (action === "detail-filter") {
      const tableId = event.target.closest("[data-detail-table-id]")?.dataset.detailTableId;
      if (!tableId) return;
      const el = event.target;
      if (el.matches("input[data-filter='owner']")) {
        clearTimeout(el._debounce);
        el._debounce = setTimeout(() => applyDetailFilters(tableId), 250);
      } else {
        applyDetailFilters(tableId);
      }
      return;
    }

    if (action === "detail-page") {
      const pageEl = event.target.closest("[data-page]");
      if (!pageEl) return;
      const tableEl = pageEl.closest("[data-detail-table-id]");
      if (!tableEl) return;
      const tableId = tableEl.dataset.detailTableId;
      const store = (window.__weeklyDetailTables || {})[tableId];
      if (!store || !Array.isArray(store.filteredRows)) return;
      const totalRows = store.filteredRows.length;
      const pageSize = 25;
      const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
      let page = parseInt(pageEl.dataset.page);
      if (pageEl.dataset.page === "prev") page = Math.max(0, (parseInt(tableEl.dataset.currentPage || 0)) - 1);
      if (pageEl.dataset.page === "next") page = Math.min(totalPages - 1, (parseInt(tableEl.dataset.currentPage || 0)) + 1);
      if (isNaN(page) || page < 0) page = 0;
      if (page >= totalPages) page = totalPages - 1;
      updateDetailTable(tableId, store.filteredRows, page);
      return;
    }

    if (action === "data-detail-sort") {
      const btn = event.target.closest("button[data-action='data-detail-sort']");
      const tableEl = btn?.closest("[data-detail-table-id]");
      const tableId = tableEl?.dataset.detailTableId;
      const colIdx = Number(btn?.dataset.colIdx);
      if (!tableId || !Number.isFinite(colIdx)) return;
      const currentCol = Number(tableEl.dataset.sortColIdx);
      const currentDir = tableEl.dataset.sortDir === "asc" ? "asc" : "desc";
      const dir = currentCol === colIdx && currentDir === "desc" ? "asc" : "desc";
      sortDetailTable(tableId, colIdx, dir);
      return;
    }

    if (action === "data-detail-action") {
      const btn = event.target.closest("[data-detail-kind]");
      const tableId = btn?.closest("[data-detail-table-id]")?.dataset.detailTableId;
      if (!btn || !tableId) return;
      const kind = btn.dataset.detailKind;
      if (kind === "reset-filters") resetDetailFilters(tableId);
      if (kind === "filter-quality") filterQualityContent(tableId);
      if (kind === "export-csv") exportDetailCSV(tableId);
      return;
    }

    if (action === "download-package") downloadAnalysisPackage();
    if (action === "export-ai-result") exportAiResult();
    if (action === "confirm-hypothesis") confirmHypothesis(event.target.closest("[data-hypothesis-id]"));
    if (action === "accept-long-term-hypothesis") acceptLongTermHypothesis(event.target.closest("[data-long-term-id]")?.dataset.longTermId);
    if (action === "watch-long-term-hypothesis") watchLongTermHypothesis(event.target.closest("[data-long-term-id]")?.dataset.longTermId);
  }

  function handleStageInput(event){
    const target = event.target;
    if (target.matches("#top-posts-filter")) {
      const root = target.closest("[data-ranking-content='top']");
      const tbody = root ? root.querySelector("[data-top-posts-tbody]") : null;
      const poolPosts = (window.__rankingTopPostsStore || {}).poolPosts || [];
      if (tbody) tbody.innerHTML = renderTopPostsRankingBody(poolPosts, asText(target.value) || "全部渠道");
    }
    if (target.matches(".detail-filter[data-filter]")) {
      const tableId = target.closest("[data-detail-table-id]")?.dataset.detailTableId;
      if (!tableId) return;
      clearTimeout(target._debounce2);
      target._debounce2 = setTimeout(() => applyDetailFilters(tableId), 200);
    }
    if (target.matches(".date-range-input[data-filter-date]")) {
      const tableId = target.closest("[data-detail-table-id]")?.dataset.detailTableId;
      if (!tableId) return;
      applyDetailFilters(tableId);
    }
    if (target.matches("[data-playbook-key]")) {
      saveText(target.dataset.playbookKey, target.value);
    }
    if (target.matches("[data-post-review-key]")) {
      saveText(target.dataset.postReviewKey, target.value);
    }
  }

  function downloadAnalysisPackage(){
    const pkg = buildAnalysisPackage();
    if (!pkg.businessReady) {
      showToast("请先导入本周 Excel，再下载正式分析包。");
      return;
    }
    const combined = {
      prompt: buildAiPrompt(pkg),
      analysisPackage: pkg
    };
    downloadText("weekly-review-analysis-package.json", JSON.stringify(combined, null, 2), "application/json");
  }

function openFilterPopover(key, btn){
  if (!state.filterCache) return;
  const store = state.filterCache[key] || [];
  const withSearch = ["productLine","project","topic"].includes(key);
  const filterBar = btn.closest(".filter-bar");
  const container = filterBar?.querySelector("[data-filter-popover]");
  if (!container) return;

  const currentVal = state._activeFilters ? (state._activeFilters[key] || "") : "";
  container.innerHTML = "";

  if (withSearch) {
    const searchInput = document.createElement("input");
    searchInput.className = "filter-popover-search";
    searchInput.placeholder = "搜索...";
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.toLowerCase();
      container.querySelectorAll(".filter-popover-item").forEach(item => {
        item.style.display = q ? (item.textContent.toLowerCase().includes(q) ? "" : "none") : "";
      });
    });
    container.appendChild(searchInput);
  }

  const allItem = document.createElement("div");
  allItem.className = "filter-popover-item" + (!currentVal ? " is-checked" : "");
  allItem.innerHTML = `<span class="check-icon"></span>全部`;
  allItem.addEventListener("click", () => {
    state._activeFilters = state._activeFilters || {};
    state._activeFilters[key] = "";
    updateFilterTags(btn.closest("[data-detail-table-id]"));
    applyDetailFilters(btn.closest("[data-detail-table-id]").dataset.detailTableId);
    container.style.display = "none";
  });
  container.appendChild(allItem);

  store.forEach(val => {
    const item = document.createElement("div");
    const isChecked = currentVal === val;
    item.className = "filter-popover-item" + (isChecked ? " is-checked" : "");
    item.innerHTML = `<span class="check-icon"></span>${escapeHtml(val)}`;
    item.addEventListener("click", () => {
      state._activeFilters = state._activeFilters || {};
      state._activeFilters[key] = isChecked ? "" : val;
      updateFilterTags(btn.closest("[data-detail-table-id]"));
      applyDetailFilters(btn.closest("[data-detail-table-id]").dataset.detailTableId);
      container.style.display = "none";
    });
    container.appendChild(item);
  });

  const btnRect = btn.getBoundingClientRect();
  const barRect = filterBar.getBoundingClientRect();
  const left = btnRect.left - barRect.left + filterBar.scrollLeft;
  const top = btnRect.bottom - barRect.top + filterBar.scrollTop + 4;
  container.style.left = `${left}px`;
  container.style.top = `${top}px`;

  container.style.display = "block";
  container._currentKey = key;
  container._currentBtn = btn;
}

function updateFilterTags(tableEl){
  const tags = tableEl?.querySelector("[data-filter-tags]");
  if (!tags) return;
  const active = state._activeFilters || {};
  const entries = Object.entries(active).filter(([,v]) => v);
  if (!entries.length) { tags.innerHTML = ""; return; }
  tags.innerHTML = '<span style="font-size:11px;color:var(--muted);margin-right:4px;">已选:</span>' +
    entries.map(([k, v]) => `<span class="filter-tag" data-remove-filter="${k}">${escapeHtml(v)} <button type="button" style="border:none;background:none;cursor:pointer;color:var(--muted);font-size:13px;padding:0 2px;">×</button></span>`).join("") +
    '<button class="filter-tag" type="button" data-clear-all-filters style="background:var(--surface-2);">清除全部</button>';
}

function closeFilterPopover(){
  const popover = document.querySelector("[data-filter-popover]");
  if (popover) { popover.style.display = "none"; popover._currentKey = null; }
}

window.addEventListener("click", e => {
  if (!e.target.closest("[data-action='toggle-filter-dropdown']") && !e.target.closest("[data-filter-popover]")) {
    closeFilterPopover();
  }
});

async function handleImportFile(){
    const file = dom.importInput.files && dom.importInput.files[0];
    if (!file) return;
    try {
      showToast(`正在读取：${file.name}`);
      const parsed = await readRowsFromFile(file);
      const result = buildSourceFromParsedRows(parsed, file);
      showImportPreview(result);
    } catch (error) {
      showModal({
        title: "导入失败",
        subtitle: "当前数据没有被替换。",
        body: `<div class="empty-state">${escapeHtml(error && error.message ? error.message : "文件格式不匹配")}</div>`,
        actions: `<button class="primary-button" type="button" data-modal-close>知道了</button>`
      });
    } finally {
      dom.importInput.value = "";
    }
  }

  function showImportPreview(result){
    const audit = result.audit;
    const canConfirm = result.source.posts.length > 0;
    const recommendedMissing = getRecommendedMissing(audit);
    const missingRows = REQUIRED_IMPORT_FIELDS.map(key => [escapeHtml(requiredLabel(key)), formatInteger((audit.missingRequired || {})[key] || 0)]);
    const recommendedRows = RECOMMENDED_IMPORT_FIELDS.map(key => [escapeHtml(requiredLabel(key)), formatInteger(recommendedMissing[key] || 0)]);
    const channelRows = Object.keys(audit.channelDistribution || {}).map(key => [escapeHtml(key), formatInteger(audit.channelDistribution[key])]);
    showModal({
      title: canConfirm ? "导入预检" : "导入预检未通过",
      subtitle: canConfirm ? "确认后才会替换当前数据；取消不会影响现有看板。" : "没有识别到有效帖子，当前数据不会被替换。",
      body: `
        <div class="quality-grid">
          ${renderQualityCard("文件", escapeHtml(result.fileName), `工作表：${escapeHtml(result.sheetName || "CSV")}`)}
          ${renderQualityCard("总行数", formatInteger(audit.totalRows), `列数：${formatInteger(result.columnCount || 0)}`)}
          ${renderQualityCard("有效行数", formatInteger(audit.acceptedRows), "通过必填字段校验")}
          ${renderQualityCard("跳过行数", formatInteger(audit.totalRows - audit.acceptedRows), "不会进入看板")}
          ${renderQualityCard("统计日期", escapeHtml(audit.statDateRange || "暂无"), "用于复盘周期")}
          ${renderQualityCard("发布时间", escapeHtml(audit.publishDateRange || "暂无"), "用于内容批次")}
        </div>
        <div class="two-col" style="margin-top:14px">
          ${renderSimpleTable(["必填字段","缺失行数"], missingRows)}
          ${renderSimpleTable(["建议字段","缺失行数"], recommendedRows)}
        </div>
        <div class="two-col" style="margin-top:14px">
          ${renderSimpleTable(["识别渠道","有效行数"], channelRows)}
          <div class="empty-state">负责人缺失会显示为“未知”；帖子链接缺失仍会导入，但只能做数据结构复盘，不能打开原帖。</div>
        </div>
      `,
      actions: `
        <button class="secondary-button" type="button" data-modal-close>取消</button>
        <button class="primary-button" type="button" ${canConfirm ? "" : "disabled"} data-confirm-import>确认导入</button>
      `,
      onMount(modal) {
        const confirm = modal.querySelector("[data-confirm-import]");
        if (!confirm || !canConfirm) return;
        confirm.addEventListener("click", async () => {
          source = mergeImportedSource(result.source);
          state.sourceLabel = "文件数据";
          state.importMeta = result.source.importMeta;
          state.importAudit = result.audit;
          await savePersistedImport(result.source);
          setDefaultRangesFromSource(true);
          recompute();
          closeModal();
          renderPreservingScroll();
          showToast(`已导入 · ${formatInteger(source.posts.length)}帖 · 来自本机缓存`);
        });
      }
    });
  }

  function openWeekPicker(){
    closeActiveRangePicker();
    if (!dom.weekPickerBtn) return;
    openNaturalWeekPicker(dom.weekPickerBtn, reviewWindow.start, reviewWindow.end, week => {
      reviewWindow = week;
      state.reportStartDate = formatDate(week.start);
      state.reportEndDate = formatDate(week.end);
      previousWindow = { start: addDays(week.start, -7), end: addDays(week.end, -7) };
      updateWeekDisplay();
      recompute();
      render();
    });
  }

  function openOffsiteWeekPicker(button){
    closeActiveRangePicker();
    if (!button) return;
    const selected = resolveLifecycleWeekRange(state.offsiteStartDate, state.offsiteEndDate, previousWindow);
    openNaturalWeekPicker(button, selected.start, selected.end, week => {
      state.offsiteStartDate = formatDate(week.start);
      state.offsiteEndDate = formatDate(week.end);
      recompute();
      applyCachedOffsiteForCurrentRange();
      render();
    });
  }

  function openNaturalWeekPicker(anchorButton, selectedStart, selectedEnd, onSelect){
    const popover = document.createElement("div");
    popover.className = "range-popover week-picker-popup";
    popover.style.position = "fixed";
    const rect = anchorButton.getBoundingClientRect();
    popover.style.top = (rect.bottom + 4) + "px";
    popover.style.right = (window.innerWidth - rect.right) + "px";
    const currentDate = selectedStart || reviewWindow.start;
    let anchor = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
    let hoverWeek = null;
    const rerender = () => {
      const leftMonth = anchor;
      const rightMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
      popover.innerHTML = `
        <div class="range-panel-header">
          <button type="button" class="range-nav-btn" data-week-nav="prev">‹</button>
          <span>${escapeHtml(formatYearMonth(leftMonth))}</span>
          <span>${escapeHtml(formatYearMonth(rightMonth))}</span>
          <button type="button" class="range-nav-btn" data-week-nav="next">›</button>
        </div>
        <div class="range-cal-wrap">
          ${renderRangeCalendarMonth(leftMonth, selectedStart, selectedEnd, hoverWeek)}
          ${renderRangeCalendarMonth(rightMonth, selectedStart, selectedEnd, hoverWeek)}
        </div>
        <div class="range-tip">点击任意一天选中所在自然周。</div>
      `;
      popover.querySelectorAll("[data-week-nav]").forEach(b => {
        b.addEventListener("click", () => {
          anchor = new Date(anchor.getFullYear(), anchor.getMonth() + (b.dataset.weekNav === "next" ? 1 : -1), 1);
          rerender();
        });
      });
      popover.querySelectorAll("[data-range-day]").forEach(btn => {
        btn.addEventListener("mouseenter", () => {
          const d = parseDate(btn.dataset.rangeDay);
          if (!d) return;
          const week = naturalWeekRange(d);
          popover.querySelectorAll("[data-range-day]").forEach(b => {
            const bd = parseDate(b.dataset.rangeDay);
            b.classList.toggle("is-hover-week", bd && bd >= week.start && bd <= week.end);
          });
        });
        btn.addEventListener("click", evt => {
          evt.stopPropagation();
          const d = parseDate(btn.dataset.rangeDay);
          if (!d) return;
          const week = naturalWeekRange(d);
          onSelect(week);
          closeActiveRangePicker();
        });
      });
      popover.querySelector(".range-cal-wrap")?.addEventListener("mouseleave", () => {
        popover.querySelectorAll("[data-range-day]").forEach(b => b.classList.remove("is-hover-week"));
      });
    };
    document.body.appendChild(popover);
    rerender();
    const outside = event => {
      if (!popover.contains(event.target) && !anchorButton.contains(event.target)) closeActiveRangePicker();
    };
    const escape = event => {
      if (event.key === "Escape") closeActiveRangePicker();
    };
    setTimeout(() => {
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", escape);
    }, 0);
    activeRangeCleanup = () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      popover.remove();
      activeRangeCleanup = null;
    };
  }

  function openRangePicker(type){
    closeActiveRangePicker();
    const isReport = type === "report";
    const container = isReport ? dom.reviewRange : dom.batchRange;
    if (!container) return;
    const current = isReport
      ? { start: state.reportStartDate, end: state.reportEndDate }
      : { start: state.batchStartDate, end: state.batchEndDate };
    const defaultRange = isReport
      ? parseReviewWindow(source.reviewWeek && source.reviewWeek.dateRange)
      : { start: new Date(reviewWindow.end.getFullYear(), reviewWindow.end.getMonth(), 1), end: reviewWindow.end };
    const draft = { ...current };
    const popover = document.createElement("div");
    popover.className = "range-popover";

    let anchor = new Date((parseDate(draft.start) || defaultRange.start).getFullYear(), (parseDate(draft.start) || defaultRange.start).getMonth(), 1);
    let hoverWeek = null;

    const rerender = () => {
      popover.innerHTML = renderRangePopover(isReport ? "复盘周期" : "内容批次周期", draft, anchor, hoverWeek, isReport);

      // 月份导航
      const prevBtn = popover.querySelector("[data-range-nav='prev']");
      const nextBtn = popover.querySelector("[data-range-nav='next']");
      if (prevBtn) prevBtn.addEventListener("click", () => { anchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1); rerender(); });
      if (nextBtn) nextBtn.addEventListener("click", () => { anchor = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1); rerender(); });

      // 日历日期按钮：悬停预选自然周
      popover.querySelectorAll("[data-range-day]").forEach(btn => {
        btn.addEventListener("mouseenter", () => {
          const hoveredDate = parseDate(btn.dataset.rangeDay);
          if (!hoveredDate) return;
          const week = naturalWeekRange(hoveredDate);
          hoverWeek = { start: week.start, end: week.end };
          rerender();
        });
        btn.addEventListener("click", () => {
          const clickedDate = parseDate(btn.dataset.rangeDay);
          if (!clickedDate) return;
          if (isReport) {
            const week = naturalWeekRange(clickedDate);
            draft.start = formatDate(week.start);
            draft.end = formatDate(week.end);
            // 同步日期输入框
            if (startInput) startInput.value = draft.start;
            if (endInput) endInput.value = draft.end;
            // 复盘周期：点击日历直接应用，关闭弹窗
            const selectedRange = resolveDateRange(draft.start, draft.end, defaultRange);
            const range = latestCompleteNaturalWeek(selectedRange.end);
            renderPreservingScroll(() => {
              state.reportStartDate = formatDate(range.start);
              state.reportEndDate = formatDate(range.end);
            });
          } else {
            // 批次周期：第一次点击设开始日期，第二次设结束日期
            if (!draft.start || (draft.start && draft.end)) {
              draft.start = formatDate(clickedDate);
              draft.end = "";
            } else {
              const second = parseDate(formatDate(clickedDate));
              const first = parseDate(draft.start);
              if (second < first) {
                draft.end = draft.start;
                draft.start = formatDate(clickedDate);
              } else {
                draft.end = formatDate(clickedDate);
              }
            }
            // 同步日期输入框
            if (startInput) startInput.value = draft.start;
            if (endInput) endInput.value = draft.end;
          }
          hoverWeek = null;
          rerender();
        });
      });

      // 鼠标离开日历区域时清除悬停高亮
      const calWrap = popover.querySelector(".range-cal-wrap");
      if (calWrap) calWrap.addEventListener("mouseleave", () => { hoverWeek = null; rerender(); });

      // 原有的 date input 同步
      const startInput = popover.querySelector("[data-range-start]");
      const endInput = popover.querySelector("[data-range-end]");
      if (startInput) startInput.addEventListener("change", () => {
        draft.start = startInput.value;
        draft.end = endInput ? endInput.value : draft.end;
        if (isReport && draft.start) {
          const week = naturalWeekRange(parseDate(draft.start));
          draft.start = formatDate(week.start);
          draft.end = formatDate(week.end);
          startInput.value = draft.start;
          if (endInput) endInput.value = draft.end;
        }
        hoverWeek = null;
        rerender();
      });
      if (endInput) endInput.addEventListener("change", () => {
        draft.end = endInput.value;
        draft.start = startInput ? startInput.value : draft.start;
        if (isReport && draft.end) {
          const week = naturalWeekRange(parseDate(draft.end));
          draft.start = formatDate(week.start);
          draft.end = formatDate(week.end);
          startInput.value = draft.start;
          endInput.value = draft.end;
        }
        hoverWeek = null;
        rerender();
      });

      // 快捷按钮
      popover.querySelectorAll("[data-shortcut]").forEach(button => {
        button.addEventListener("click", () => {
          const range = resolveShortcut(button.dataset.shortcut, defaultRange);
          draft.start = formatDate(range.start);
          draft.end = formatDate(range.end);
          if (startInput) startInput.value = draft.start;
          if (endInput) endInput.value = draft.end;
          hoverWeek = null;
          anchor = new Date((parseDate(draft.start) || defaultRange.start).getFullYear(), (parseDate(draft.start) || defaultRange.start).getMonth(), 1);
          rerender();
        });
      });

      // 清空/取消/应用
      const clearBtn = popover.querySelector("[data-range-clear]");
      if (clearBtn) clearBtn.addEventListener("click", () => {
        draft.start = formatDate(defaultRange.start);
        draft.end = formatDate(defaultRange.end);
        if (startInput) startInput.value = draft.start;
        if (endInput) endInput.value = draft.end;
        hoverWeek = null;
        rerender();
      });
      const cancelBtn = popover.querySelector("[data-range-cancel]");
      if (cancelBtn) cancelBtn.addEventListener("click", closeActiveRangePicker);
      const applyBtn = popover.querySelector("[data-range-apply]");
      if (applyBtn) applyBtn.addEventListener("click", () => {
        const selectedRange = resolveDateRange(draft.start, draft.end, defaultRange);
        const range = isReport ? latestCompleteNaturalWeek(selectedRange.end) : selectedRange;
        renderPreservingScroll(() => {
          if (isReport) {
            state.reportStartDate = formatDate(range.start);
            state.reportEndDate = formatDate(range.end);
          } else {
            state.batchStartDate = formatDate(range.start);
            state.batchEndDate = formatDate(range.end);
          }
        });
      });
    };

    container.appendChild(popover);
    rerender();

    const outside = event => {
      if (!container.contains(event.target) && !popover.contains(event.target)) closeActiveRangePicker();
    };
    const escape = event => {
      if (event.key === "Escape") closeActiveRangePicker();
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", escape);
    }, 0);
    activeRangeCleanup = () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      popover.remove();
      activeRangeCleanup = null;
    };
  }

  function closeActiveRangePicker(){
    if (activeRangeCleanup) activeRangeCleanup();
  }

  function openDetailDateRangePicker(button){
    closeActiveRangePicker();
    const root = button.closest("[data-detail-table-id]");
    if (!root) return;
    const tableId = root.dataset.detailTableId;
    const container = button.closest(".date-range-picker");
    const startTarget = root.querySelector(".date-range-input[data-filter-date='from']");
    const endTarget = root.querySelector(".date-range-input[data-filter-date='to']");
    if (!container || !startTarget || !endTarget || !tableId) return;

    const store = (window.__weeklyDetailTables || {})[tableId];
    const rowDates = (store?.allRows || []).map(row => parseDate(row.publishDate)).filter(Boolean).sort((a, b) => a - b);
    const defaultStart = rowDates[0] || reviewWindow.start;
    const defaultEnd = rowDates[rowDates.length - 1] || reviewWindow.end;
    const draft = {
      start: startTarget.value || "",
      end: endTarget.value || ""
    };
    let anchorBase = parseDate(draft.start) || parseDate(draft.end) || defaultStart;
    let anchor = new Date(anchorBase.getFullYear(), anchorBase.getMonth(), 1);

    const popover = document.createElement("div");
    popover.className = "range-popover detail-date-popover";
    popover.style.position = "absolute";
    popover.style.top = "calc(100% + 4px)";
    popover.style.right = "0";

    const rerender = () => {
      popover.innerHTML = renderDetailDateRangePopover(draft, anchor);
      popover.querySelector("[data-range-nav='prev']")?.addEventListener("click", () => {
        anchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
        rerender();
      });
      popover.querySelector("[data-range-nav='next']")?.addEventListener("click", () => {
        anchor = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
        rerender();
      });
      popover.querySelectorAll("[data-range-day]").forEach(dayBtn => {
        dayBtn.addEventListener("click", () => {
          const clicked = parseDate(dayBtn.dataset.rangeDay);
          if (!clicked) return;
          if (!draft.start || (draft.start && draft.end)) {
            draft.start = formatDate(clicked);
            draft.end = "";
          } else {
            const startDate = parseDate(draft.start);
            if (startDate && clicked < startDate) {
              draft.end = draft.start;
              draft.start = formatDate(clicked);
            } else {
              draft.end = formatDate(clicked);
            }
          }
          rerender();
        });
      });
      const startInput = popover.querySelector("[data-range-start]");
      const endInput = popover.querySelector("[data-range-end]");
      startInput?.addEventListener("change", () => {
        draft.start = startInput.value;
        draft.end = endInput ? endInput.value : draft.end;
        anchorBase = parseDate(draft.start) || parseDate(draft.end) || defaultStart;
        anchor = new Date(anchorBase.getFullYear(), anchorBase.getMonth(), 1);
        rerender();
      });
      endInput?.addEventListener("change", () => {
        draft.end = endInput.value;
        draft.start = startInput ? startInput.value : draft.start;
        anchorBase = parseDate(draft.start) || parseDate(draft.end) || defaultStart;
        anchor = new Date(anchorBase.getFullYear(), anchorBase.getMonth(), 1);
        rerender();
      });
      popover.querySelector("[data-detail-range-clear]")?.addEventListener("click", () => {
        draft.start = "";
        draft.end = "";
        rerender();
      });
      popover.querySelector("[data-detail-range-cancel]")?.addEventListener("click", closeActiveRangePicker);
      popover.querySelector("[data-detail-range-apply]")?.addEventListener("click", () => {
        const hasAnyDate = !!(draft.start || draft.end);
        const startText = draft.start || draft.end;
        const endText = draft.end || draft.start;
        const normalized = resolveDateRange(startText, endText, { start: defaultStart, end: defaultEnd });
        startTarget.value = hasAnyDate ? formatDate(normalized.start) : "";
        endTarget.value = hasAnyDate ? formatDate(normalized.end) : "";
        updateDetailDateRangeLabel(root);
        applyDetailFilters(tableId);
        closeActiveRangePicker();
      });
    };

    container.appendChild(popover);
    rerender();
    const outside = event => {
      if (!container.contains(event.target)) closeActiveRangePicker();
    };
    const escape = event => {
      if (event.key === "Escape") closeActiveRangePicker();
    };
    setTimeout(() => {
      document.addEventListener("pointerdown", outside);
      document.addEventListener("keydown", escape);
    }, 0);
    activeRangeCleanup = () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      popover.remove();
      activeRangeCleanup = null;
    };
  }

  function renderDetailDateRangePopover(draft, anchor){
    const startDate = parseDate(draft.start);
    const endDate = parseDate(draft.end);
    const leftMonth = anchor || new Date((startDate || new Date()).getFullYear(), (startDate || new Date()).getMonth(), 1);
    const rightMonth = new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1);
    return `
      <h3>发布时间筛选</h3>
      <div class="range-panel-header">
        <button type="button" class="range-nav-btn" data-range-nav="prev">‹</button>
        <span>${escapeHtml(formatYearMonth(leftMonth))}</span>
        <span>${escapeHtml(formatYearMonth(rightMonth))}</span>
        <button type="button" class="range-nav-btn" data-range-nav="next">›</button>
      </div>
      <div class="range-cal-wrap">
        ${renderRangeCalendarMonth(leftMonth, startDate, endDate, null)}
        ${renderRangeCalendarMonth(rightMonth, startDate, endDate, null)}
      </div>
      <div class="range-form">
        <label class="field-label">开始日期<input type="date" data-range-start value="${escapeHtml(draft.start)}"></label>
        <label class="field-label">结束日期<input type="date" data-range-end value="${escapeHtml(draft.end)}"></label>
      </div>
      <div class="range-tip">手动选择开始和结束日期；点击日历不会自动切换到自然周。</div>
      <div class="range-actions">
        <button class="secondary-button" type="button" data-detail-range-clear>清空</button>
        <button class="secondary-button" type="button" data-detail-range-cancel>取消</button>
        <button class="primary-button" type="button" data-detail-range-apply>应用</button>
      </div>
    `;
  }

  function updateDetailDateRangeLabel(root){
    const button = root?.querySelector("[data-detail-date-label]");
    if (!button) return;
    const start = root.querySelector(".date-range-input[data-filter-date='from']")?.value || "";
    const end = root.querySelector(".date-range-input[data-filter-date='to']")?.value || "";
    if (start && end) button.textContent = `${start} ~ ${end}`;
    else if (start) button.textContent = `${start} ~ ${start}`;
    else if (end) button.textContent = `${end} ~ ${end}`;
    else button.textContent = "发布时间";
  }

  function renderRangePopover(title, draft, anchor, hoverWeek, isReport){
    const startDate = parseDate(draft.start);
    const endDate = parseDate(draft.end);
    const leftMonth = anchor || new Date((startDate || new Date()).getFullYear(), (startDate || new Date()).getMonth(), 1);
    const rightMonth = new Date(leftMonth.getFullYear(), leftMonth.getMonth() + 1, 1);
    return `
      <h3>${escapeHtml(title)}</h3>
      <div class="range-panel-header">
        <button type="button" class="range-nav-btn" data-range-nav="prev">‹</button>
        <span>${escapeHtml(formatYearMonth(leftMonth))}</span>
        <span>${escapeHtml(formatYearMonth(rightMonth))}</span>
        <button type="button" class="range-nav-btn" data-range-nav="next">›</button>
      </div>
      <div class="range-cal-wrap">
        ${renderRangeCalendarMonth(leftMonth, startDate, endDate, hoverWeek)}
        ${renderRangeCalendarMonth(rightMonth, startDate, endDate, hoverWeek)}
      </div>
      <div class="range-form">
        <label class="field-label">开始日期<input type="date" data-range-start value="${escapeHtml(draft.start)}"></label>
        <label class="field-label">结束日期<input type="date" data-range-end value="${escapeHtml(draft.end)}"></label>
      </div>
      <div class="range-shortcuts">
        <button class="chip-button" type="button" data-shortcut="week">本周</button>
        <button class="chip-button" type="button" data-shortcut="last7">上一完整周</button>
        <button class="chip-button" type="button" data-shortcut="month">本月</button>
        <button class="chip-button" type="button" data-shortcut="quarter">本季度</button>
      </div>
      <div class="range-tip">${isReport ? "点击日历任意一天自动选中完整自然周（周一至周日）。悬停预选整周范围。" : "内容批次周期允许自由选择起止日期。"}</div>
      <div class="range-actions">
        <button class="secondary-button" type="button" data-range-clear>清空为默认</button>
        <button class="secondary-button" type="button" data-range-cancel>取消</button>
        <button class="primary-button" type="button" data-range-apply>应用</button>
      </div>
    `;
  }

  function renderRangeCalendarMonth(monthStart, startDate, endDate, hoverWeek){
    const firstWeekday = (monthStart.getDay() + 6) % 7;
    const monthDays = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const prevMonthDays = new Date(monthStart.getFullYear(), monthStart.getMonth(), 0).getDate();
    const weekHeader = ["一","二","三","四","五","六","日"].map(day => `<span class="range-day-header">${day}</span>`).join("");
    const cells = [];
    for (let i = 0; i < 42; i += 1) {
      let dayNum, dateObj, outMonth = false;
      if (i < firstWeekday) {
        dayNum = prevMonthDays - firstWeekday + i + 1;
        dateObj = new Date(monthStart.getFullYear(), monthStart.getMonth() - 1, dayNum);
        outMonth = true;
      } else if (i < firstWeekday + monthDays) {
        dayNum = i - firstWeekday + 1;
        dateObj = new Date(monthStart.getFullYear(), monthStart.getMonth(), dayNum);
      } else {
        dayNum = i - firstWeekday - monthDays + 1;
        dateObj = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, dayNum);
        outMonth = true;
      }
      const dayText = formatDate(dateObj);
      const inRange = startDate && endDate && dateObj >= startDate && dateObj <= endDate;
      const isStart = startDate && dayText === formatDate(startDate);
      const isEnd = endDate && dayText === formatDate(endDate);
      const inHoverWeek = hoverWeek && hoverWeek.start && hoverWeek.end && dateObj >= hoverWeek.start && dateObj <= hoverWeek.end;
      const classes = ["range-day"];
      if (outMonth) classes.push("is-out-month");
      if (inRange) classes.push("is-in-range");
      if (isStart) classes.push("is-range-start");
      if (isEnd) classes.push("is-range-end");
      if (inHoverWeek) classes.push("is-hover-week");
      cells.push(`<button type="button" class="${classes.join(" ")}" data-range-day="${escapeHtml(dayText)}">${dayNum}</button>`);
    }
    return `<div class="range-month">
      <div class="range-week-header">${weekHeader}</div>
      <div class="range-month-grid">${cells.join("")}</div>
    </div>`;
  }

  function deriveForScope(scope){
    return deriveFromPosts(scope, filterPostsByScope(posts, scope));
  }

  function deriveFromPosts(scope, scoped){
    const batchRange = { start: parseDate(state.batchStartDate), end: parseDate(state.batchEndDate) };
    const lifecycleRange = { start: parseDate(state.lifecycleStartDate), end: parseDate(state.lifecycleEndDate) };
    const poolPosts = scoped.filter(post => inDateRange(post.publishDateObj, batchRange.start, batchRange.end));
    const lifecyclePoolPosts = scoped.filter(post => inDateRange(post.publishDateObj, lifecycleRange.start, lifecycleRange.end));
    const currentTotals = sumPostsForRange(poolPosts, reviewWindow.start, reviewWindow.end);
    const previousTotals = sumPostsForRange(poolPosts, previousWindow.start, previousWindow.end);
    const currentPostCount = countPostsForRange(poolPosts, reviewWindow.start, reviewWindow.end);
    const previousPostCount = countPostsForRange(poolPosts, previousWindow.start, previousWindow.end);
    const channelRows = buildChannelRows(poolPosts, currentTotals);
    const topPosts = topPostsFromPool(poolPosts, scope === "社群" ? "interaction" : "exposure", 10);
    return {
      scope,
      scoped,
      poolPosts,
      lifecyclePoolPosts,
      currentTotals,
      previousTotals,
      currentPostCount,
      previousPostCount,
      channelRows,
      topPosts,
      interactionRate: safeRate(currentTotals.interaction, currentTotals.exposure),
      previousInteractionRate: safeRate(previousTotals.interaction, previousTotals.exposure)
    };
  }

  function deriveOffsite(){
    const imported = deriveForScope("站外");
    if (imported.poolPosts.length) {
      const rows = imported.channelRows.map(row => ({ label: row.label, value: row.exposure, interaction: row.interaction, note: "来自导入数据" }))
        .sort((a, b) => b.value - a.value);
      return { mode: "导入数据", total: imported.currentTotals.exposure, rows };
    }
    const dtc = source.dtcSection || {};
    const rows = (dtc.rows || []).map(row => ({
      label: row.label || row.site || row.channel || "未知来源",
      value: asNumber(row.current || row.exposure || row.value),
      interaction: asNumber(row.interaction || 0),
      note: row.note || row.site || ""
    })).sort((a, b) => b.value - a.value);
    const total = asNumber(dtc.totalCurrent) || sum(rows, row => row.value);
    return { mode: "内置站外数据", total, rows };
  }

  function deriveQuantityPerformance(){
    const module = (source.manualModules || []).find(item => (item.metrics || []).length) || {};
    const metrics = (module.metrics || []).map(metric => ({
      label: metric.label || "未命名指标",
      current: asNumber(metric.current),
      previous: asNumber(metric.previous),
      unit: metric.unit || ""
    }));
    return {
      source: module.source || "手填数据",
      remark: module.remark || "",
      metrics
    };
  }

  function deriveProjectRows(poolPosts){
    const groups = new Map();
    poolPosts.forEach(post => {
      const projectName = (post.project || (post.projectKey || "").split("::")[0] || "").trim();
      if (!projectName) return;
      const label = projectName;
      if (!groups.has(label)) groups.set(label, { label, posts: 0, exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
      const row = groups.get(label);
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      row.posts += 1;
      row.exposure += metrics.exposure;
      row.interaction += metrics.interaction;
      row.likes += metrics.likes;
      row.comments += metrics.comments;
      row.shares += metrics.shares;
      row.saves += metrics.saves;
    });
    if (!groups.size) return [];
    const totals = {
      exposure: sum(Array.from(groups.values()), row => row.exposure),
      interaction: sum(Array.from(groups.values()), row => row.interaction)
    };
    return Array.from(groups.values()).map(row => ({
      ...row,
      exposureShare: safeRate(row.exposure, totals.exposure),
      interactionShare: safeRate(row.interaction, totals.interaction),
      interactionRate: safeRate(row.interaction, row.exposure)
    })).sort((a, b) => (b.exposure || b.interaction) - (a.exposure || a.interaction));
  }

  function deriveProductLineRows(poolPosts){
    const groups = new Map();
    poolPosts.forEach(post => {
      const label = asText(post.productLine1).trim();
      if (!label) return;
      if (!groups.has(label)) groups.set(label, { label, posts: 0, exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
      const row = groups.get(label);
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      row.posts += 1;
      row.exposure += metrics.exposure;
      row.interaction += metrics.interaction;
      row.likes += metrics.likes;
      row.comments += metrics.comments;
      row.shares += metrics.shares;
      row.saves += metrics.saves;
    });
    if (!groups.size) return [];
    const totals = {
      exposure: sum(Array.from(groups.values()), row => row.exposure),
      interaction: sum(Array.from(groups.values()), row => row.interaction)
    };
    return Array.from(groups.values()).map(row => ({
      ...row,
      exposureShare: safeRate(row.exposure, totals.exposure),
      interactionShare: safeRate(row.interaction, totals.interaction),
      interactionRate: safeRate(row.interaction, row.exposure)
    })).sort((a, b) => (b.exposure || b.interaction) - (a.exposure || a.interaction));
  }

  function deriveFunnelDistribution(poolPosts){
    const filtered = poolPosts.filter(post => post.normalizedChannelType !== "社群");
    const groups = new Map();
    filtered.forEach(post => {
      const stage = asText(post.funnelStage).trim();
      if (!stage) return;
      const label = stage;
      if (!groups.has(label)) groups.set(label, { label, posts: 0, exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
      const row = groups.get(label);
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      row.posts += 1;
      row.exposure += metrics.exposure;
      row.interaction += metrics.interaction;
      row.likes += metrics.likes;
      row.comments += metrics.comments;
      row.shares += metrics.shares;
      row.saves += metrics.saves;
    });
    if (!groups.size) return [];
    const totals = {
      posts: sum(Array.from(groups.values()), row => row.posts),
      exposure: sum(Array.from(groups.values()), row => row.exposure),
      interaction: sum(Array.from(groups.values()), row => row.interaction)
    };
    return Array.from(groups.values()).map(row => ({
      ...row,
      postShare: safeRate(row.posts, totals.posts),
      exposureShare: safeRate(row.exposure, totals.exposure),
      interactionShare: safeRate(row.interaction, totals.interaction),
      interactionRate: safeRate(row.interaction, row.exposure)
    })).sort((a, b) => (b.exposure || b.interaction) - (a.exposure || a.interaction));
  }

  function deriveCollabRequirementBreakdown(poolPosts){
    const groups = new Map();
    poolPosts.forEach(post => {
      const label = asText(post.collabRequirement) || "未标记合作要求";
      if (!groups.has(label)) groups.set(label, { label, posts: 0, exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
      const row = groups.get(label);
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      row.posts += 1;
      row.exposure += metrics.exposure;
      row.interaction += metrics.interaction;
      row.likes += metrics.likes;
      row.comments += metrics.comments;
      row.shares += metrics.shares;
      row.saves += metrics.saves;
    });
    const totals = {
      posts: sum(Array.from(groups.values()), row => row.posts),
      exposure: sum(Array.from(groups.values()), row => row.exposure),
      interaction: sum(Array.from(groups.values()), row => row.interaction)
    };
    return Array.from(groups.values()).map(row => ({
      ...row,
      postShare: safeRate(row.posts, totals.posts),
      exposureShare: safeRate(row.exposure, totals.exposure),
      interactionShare: safeRate(row.interaction, totals.interaction),
      interactionRate: safeRate(row.interaction, row.exposure)
    })).sort((a, b) => (b.exposure || b.interaction) - (a.exposure || a.interaction));
  }

  function buildLifecycleRows(poolPosts, isCommunity){
    const ranges = [
      { label: "第1周", window: "发布后1-7天", dayStart: 1, dayEnd: 7 },
      { label: "第2周", window: "发布后8-14天", dayStart: 8, dayEnd: 14 },
      { label: "第3周", window: "发布后15-21天", dayStart: 15, dayEnd: 21 },
      { label: "第4周", window: "发布后22-28天", dayStart: 22, dayEnd: 28 }
    ];
    const rows = ranges.map(range => poolPosts.reduce((acc, post) => {
      const start = addDays(post.publishDateObj, range.dayStart - 1);
      const end = addDays(post.publishDateObj, range.dayEnd - 1);
      const diff = diffMetrics(post, start, end);
      acc.exposure += isCommunity ? 0 : diff.exposure;
      acc.interaction += diff.interaction;
      if ((isCommunity ? diff.interaction : diff.exposure + diff.interaction) > 0) acc.posts += 1;
      return acc;
    }, { ...range, exposure: 0, interaction: 0, posts: 0 }));
    const totalExposure = sum(rows, row => row.exposure);
    const totalInteraction = sum(rows, row => row.interaction);
    return rows.map(row => {
      const exposureShare = safeRate(row.exposure, totalExposure);
      const interactionShare = safeRate(row.interaction, totalInteraction);
      const gap = interactionShare - exposureShare;
      const enrichedRow = { ...row, exposureShare, interactionShare };
      return {
        ...row,
        exposureShare,
        interactionShare,
        avgInteraction: safeRate(row.interaction, row.posts),
        interactionRate: safeRate(row.interaction, row.exposure),
        gap,
        diagnosis: lifecycleDiagnosis(enrichedRow, gap, isCommunity)
      };
    });
  }

  function buildCohortMatrix(poolPosts, reviewWeekEnd){
    const groups = new Map();
    poolPosts.forEach(post => {
      if (!post || !post.publishDateObj) return;
      const week = naturalWeekRange(post.publishDateObj);
      const weekStart = week.start;
      const weekEnd = week.end;
      const key = `${weekStart.getFullYear()}-W${`${weekOfYear(weekStart)}`.padStart(2, "0")}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          publishWeekStart: weekStart,
          publishWeekEnd: weekEnd,
          posts: []
        });
      }
      groups.get(key).posts.push(post);
    });
    const today = new Date();
    return Array.from(groups.values())
      .sort((a, b) => b.publishWeekStart - a.publishWeekStart)
      .slice(0, 7)
      .map(group => {
        const windows = [1, 2, 3, 4].map(weekIndex => {
          const windowStart = addDays(group.publishWeekStart, (weekIndex - 1) * 7);
          const windowEnd = addDays(windowStart, 6);
          const mature = today >= windowEnd;
          const totals = group.posts.reduce((acc, post) => {
            const diff = diffMetrics(post, windowStart, windowEnd);
            acc.exposure += diff.exposure;
            acc.interaction += diff.interaction;
            return acc;
          }, { exposure: 0, interaction: 0 });
          return {
            weekIndex,
            label: `第${weekIndex}周`,
            start: windowStart,
            end: windowEnd,
            exposure: totals.exposure,
            interaction: totals.interaction,
            interactionRate: safeRate(totals.interaction, totals.exposure),
            mature
          };
        });
        const totalExposure = sum(windows, item => item.exposure);
        const totalInteraction = sum(windows, item => item.interaction);
        const matureWeeks = windows.filter(item => item.mature).length;
        return {
          cohortWeek: group.key,
          publishWeekStart: group.publishWeekStart,
          publishWeekEnd: group.publishWeekEnd,
          postCount: group.posts.length,
          matureWeeks,
          mature: matureWeeks >= 4,
          windows,
          totalExposure,
          totalInteraction,
          interactionRate: safeRate(totalInteraction, totalExposure)
        };
      });
  }

  function buildWeekBreakdown(poolPosts, reviewWindowStart, reviewWindowEnd){
    const groups = new Map();
    poolPosts.forEach(post => {
      if (!post || !post.publishDateObj) return;
      const week = naturalWeekRange(post.publishDateObj);
      const weekStart = week.start;
      const weekEnd = week.end;
      const key = `${weekStart.getFullYear()}-W${`${weekOfYear(weekStart)}`.padStart(2, "0")}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          publishWeekStart: weekStart,
          publishWeekEnd: weekEnd,
          postCount: 0,
          exposure: 0,
          interaction: 0
        });
      }
      const row = groups.get(key);
      const diff = diffMetrics(post, reviewWindowStart, reviewWindowEnd);
      row.postCount += 1;
      row.exposure += diff.exposure;
      row.interaction += diff.interaction;
    });
    const rows = Array.from(groups.values())
      .filter(row => row.exposure > 0 || row.interaction > 0)
      .sort((a, b) => b.publishWeekStart - a.publishWeekStart);
    const totalExposure = sum(rows, row => row.exposure);
    const totalInteraction = sum(rows, row => row.interaction);
    const normalized = rows.map(row => ({
      ...row,
      exposureShare: safeRate(row.exposure, totalExposure),
      interactionShare: safeRate(row.interaction, totalInteraction)
    }));
    const kept = [];
    const earlier = {
      cohortWeek: "更早",
      publishWeekStart: null,
      publishWeekEnd: null,
      postCount: 0,
      exposure: 0,
      interaction: 0
    };
    normalized.forEach((row, index) => {
      if (index >= 4 && row.exposureShare < 0.03) {
        earlier.postCount += row.postCount;
        earlier.exposure += row.exposure;
        earlier.interaction += row.interaction;
        return;
      }
      kept.push({ ...row, cohortWeek: row.key });
    });
    if (earlier.exposure > 0 || earlier.interaction > 0) {
      kept.push({
        ...earlier,
        exposureShare: safeRate(earlier.exposure, totalExposure),
        interactionShare: safeRate(earlier.interaction, totalInteraction)
      });
    }
    return { rows: kept, totalExposure, totalInteraction };
  }

  
function buildMetricCards(tabKey){
  try {
  const all = deriveForScope("all");
  if (!all || !all.currentTotals) return "";
  const curExp = all.currentTotals.exposure || 0, curInt = all.currentTotals.interaction || 0;
  const prevExp = (all.previousTotals || all.currentTotals).exposure || 0, prevInt = (all.previousTotals || all.currentTotals).interaction || 0;
  const wowExp = safeWoW(curExp, prevExp), wowInt = safeWoW(curInt, prevInt);
  const card = (label, value, foot) => `<div class="metric-card"><strong>${typeof value === "number" ? formatCompact(value) : escapeHtml(String(value))}</strong><p>${escapeHtml(label)}${foot ? " · " + foot : ""}</p></div>`;
  const arrow = (wow) => wow > 0.1 ? " ↑" : wow < -0.1 ? " ↓" : " →";
  const wowFoot = (wow) => `<span style="color:${wowColor(wow)}">${arrow(wow)} ${formatPct(Math.abs(wow))}</span>`;
  const cardClass = (wow) => wow > 0.1 ? "is-up" : wow < -0.1 ? "is-down" : "is-flat";
  const cardWow = (label, value, wow, foot) => `<div class="metric-card ${cardClass(wow)}"><strong>${typeof value === "number" ? formatCompact(value) : escapeHtml(String(value))}<span style="font-size:13px;">${wowFoot(wow)}</span></strong><p>${escapeHtml(label)}${foot ? " · " + foot : ""}</p></div>`;
  const metricRangeLabel = `${formatDate(reviewWindow.start).replace(/-/g,".").slice(5)}—${formatDate(reviewWindow.end).replace(/-/g,".").slice(5)}`;
  const metricBatchStart = parseDate(state.batchStartDate) || reviewWindow.start;
  const metricBatchEnd = parseDate(state.batchEndDate) || reviewWindow.end;
  const metricBatchLabel = `${formatDate(metricBatchStart).replace(/-/g,".").slice(5)}—${formatDate(metricBatchEnd).replace(/-/g,".").slice(5)}`;
  const publishFoot = `发布时间 ${metricRangeLabel}`;
  const totalFoot = `批次 ${metricBatchLabel} · ${metricRangeLabel}新增`;
  const addedFoot = `${metricRangeLabel}新增`;

  if (tabKey === "overview") {
    const weekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const prevWeekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= previousWindow.start && p.publishDateObj <= previousWindow.end);
    const prevPosts = prevWeekPosts.length;
    const wowPosts = safeWoW(curPosts, prevPosts);
    const curRate = safeRate(curInt, curExp), prevRate = safeRate(prevInt, prevExp), wowRate = safeWoW(curRate, prevRate);
    const currentMetricRows = all.poolPosts.map(post => ({ post, metrics: diffMetrics(post, reviewWindow.start, reviewWindow.end) }))
      .filter(row => row.metrics.exposure > 0 || row.metrics.interaction > 0);
    const prevMetricRows = all.poolPosts.map(post => ({ post, metrics: diffMetrics(post, previousWindow.start, previousWindow.end) }))
      .filter(row => row.metrics.exposure > 0 || row.metrics.interaction > 0);
    const avgExp = safeRate(curExp, Math.max(currentMetricRows.length, 1));
    const prevAvgExp = safeRate(prevExp, Math.max(prevMetricRows.length, 1));
    const exposureValues = currentMetricRows.map(row => row.metrics.exposure).filter(value => value > 0).sort((a, b) => a - b);
    const mid = Math.floor(exposureValues.length / 2);
    const medianExp = exposureValues.length ? (exposureValues.length % 2 ? exposureValues[mid] : (exposureValues[mid - 1] + exposureValues[mid]) / 2) : 0;
    const top5 = [...currentMetricRows].sort((a, b) => b.metrics.exposure - a.metrics.exposure).slice(0, 5);
    const top5Share = safeRate(sum(top5, row => row.metrics.exposure), curExp);
    const quality = all.poolPosts.filter(post => (asText(post.featuredQuality) === "1.0" || asText(post.featuredQuality) === "1")).length;
    return `<div class="metric-grid-2row">${cardWow("复盘周期发布帖", curPosts, wowPosts, publishFoot)}${cardWow("本周总曝光", curExp, wowExp, totalFoot)}${cardWow("本周总互动", curInt, wowInt, totalFoot)}${cardWow("本周互动率", formatPct(curRate), wowRate, totalFoot)}${card("贴均曝光", formatCompact(avgExp), `${addedFoot} · 较前期 ${formatDelta(safeWoW(avgExp, prevAvgExp))}`)}${card("曝光中位数", formatCompact(medianExp), `${addedFoot} · ${formatInteger(exposureValues.length)}帖`)}${card("Top5占比", formatPct(top5Share), `${addedFoot} · 按曝光排序`)}${card("批次优质内容", quality, `批次 ${metricBatchLabel} · 导入字段标记`)}</div>`;
  }

  if (tabKey === "cohort") {
    const weekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const prevWeekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= previousWindow.start && p.publishDateObj <= previousWindow.end);
    const prevPosts = prevWeekPosts.length;
    const wowPosts = safeWoW(curPosts, prevPosts);
    const curRate = safeRate(curInt, curExp), prevRate = safeRate(prevInt, prevExp), wowRate = safeWoW(curRate, prevRate);
    return `<div class="metric-grid">${cardWow("复盘周期发布帖", curPosts, wowPosts, publishFoot)}${cardWow("本周总曝光", curExp, wowExp, totalFoot)}${cardWow("本周总互动", curInt, wowInt, totalFoot)}${cardWow("本周互动率", formatPct(curRate), wowRate, totalFoot)}</div>`;
  }

  if (tabKey === "channel") {
    const channels = buildChannelRows(all.poolPosts, all.currentTotals);
    const prevCh = buildChannelRows(all.poolPosts, all.previousTotals, previousWindow.start, previousWindow.end);
    const withWow = channels.map(ch => ({ ...ch, wow: safeWoW(ch.exposure, prevCh.find(p => p.label === ch.label)?.exposure || 0) }));
    const bestExp = [...withWow].sort((a, b) => b.exposure - a.exposure)[0];
    const bestRate = [...withWow].filter(c => c.exposure > 0).sort((a, b) => safeRate(b.interaction, b.exposure) - safeRate(a.interaction, a.exposure))[0];
    const bestWow = [...withWow].sort((a, b) => b.wow - a.wow)[0];
    const activeCount = channels.filter(c => c.exposure > 0 || c.interaction > 0).length;
    return `<div class="metric-grid">${card("有数据渠道", activeCount, totalFoot)}${card("曝光最大", bestExp?.label || "-", bestExp ? `${formatCompact(bestExp.exposure)} · ${totalFoot}` : totalFoot)}${card("互动率最高", bestRate?.label || "-", bestRate ? `${formatPct(safeRate(bestRate.interaction, bestRate.exposure))} · ${totalFoot}` : totalFoot)}${card("涨最多", bestWow?.label || "-", bestWow ? `${formatDelta(bestWow.wow)} · 按渠道曝光环比 · ${totalFoot}` : `按渠道曝光环比 · ${totalFoot}`)}</div>`;
  }

  if (tabKey === "detail") {
    const detailPosts = all.scoped || [];
    const detailTotals = sumPostsForRange(detailPosts, reviewWindow.start, reviewWindow.end);
    const detailPreviousTotals = sumPostsForRange(detailPosts, previousWindow.start, previousWindow.end);
    const detailExp = detailTotals.exposure || 0;
    const detailPrevExp = detailPreviousTotals.exposure || 0;
    const detailWowExp = safeWoW(detailExp, detailPrevExp);
    const weekPosts = detailPosts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const prevWeekPosts = detailPosts.filter(p => p.publishDateObj && p.publishDateObj >= previousWindow.start && p.publishDateObj <= previousWindow.end);
    const wowPosts = safeWoW(curPosts, prevWeekPosts.length);
    const top5 = detailPosts.map(p => ({ m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5Share = safeRate(sum(top5, p => p.m.exposure), detailExp);
    const quality = detailPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    return `<div class="metric-grid">${cardWow("复盘周期发布帖", curPosts, wowPosts, publishFoot)}${card("Top5曝光占比", formatPct(top5Share), `${addedFoot} · 按曝光排序`)}${card("全量优质内容", quality, `全量帖子 · 导入字段标记`)}${cardWow("本周总曝光", detailExp, detailWowExp, `全量帖子 · ${metricRangeLabel}新增`)}</div>`;
  }
  return "";
  } catch(e) { console.error("buildMetricCards error", e); return ""; }
}

function buildNarrative(tabKey){
  const all = deriveForScope("all"), curExp = all.currentTotals.exposure, curInt = all.currentTotals.interaction, prevExp = all.previousTotals.exposure, prevInt = all.previousTotals.interaction;
  const wowExp = safeWoW(curExp, prevExp), wowInt = safeWoW(curInt, prevInt);
  const lines = [], green = "var(--up)", red = "var(--down)", amber = "var(--warn)";

  if (tabKey === "overview") {
    const weekPosts = posts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const currentMetricRows = all.poolPosts.map(post => ({ ...post, m: diffMetrics(post, reviewWindow.start, reviewWindow.end) }))
      .filter(row => row.m.exposure > 0 || row.m.interaction > 0);
    const avgExp = safeRate(curExp, Math.max(currentMetricRows.length, 1));
    const exposureValues = currentMetricRows.map(row => row.m.exposure).filter(value => value > 0).sort((a, b) => a - b);
    const mid = Math.floor(exposureValues.length / 2);
    const medianExp = exposureValues.length ? (exposureValues.length % 2 ? exposureValues[mid] : (exposureValues[mid - 1] + exposureValues[mid]) / 2) : 0;
    const top5 = [...currentMetricRows].sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5Share = safeRate(sum(top5, post => post.m.exposure), curExp);
    const top20 = [...currentMetricRows].sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 20);
    const top20Share = safeRate(sum(top20, post => post.m.exposure), curExp);
    const quality = all.poolPosts.filter(post => (asText(post.featuredQuality) === "1.0" || asText(post.featuredQuality) === "1")).length;
    const chRows = buildChannelRows(all.poolPosts, all.currentTotals);
    const topChannel = chRows[0];
    const topPost = top5[0];
    const ratio = medianExp > 0 ? avgExp / medianExp : 0;
    const concTone = ratio > 5 ? "is-warn" : ratio > 3 ? "is-neutral" : "is-good";
    const concText = ratio > 5 ? "曝光高度集中在头部内容。" : ratio > 3 ? "曝光有一定集中度。" : "曝光分布相对均匀。";
    const findings = [
      {
        tone: wowExp > 0.1 ? "is-good" : wowExp < -0.1 ? "is-bad" : "is-warn",
        title: "总量变化",
        body: `批次内帖子在复盘周期新增曝光 ${formatCompact(curExp)}，环比${wowExp > 0 ? "增长" : wowExp < 0 ? "下降" : "持平"} ${formatPct(Math.abs(wowExp))}；新增互动 ${formatCompact(curInt)}，环比 ${formatDelta(wowInt)}。复盘周期新发布 ${formatInteger(curPosts)} 帖。`
      },
      {
        tone: medianExp > 0 ? concTone : "is-neutral",
        title: "贴均与中位",
        body: `按复盘周期新增曝光计算，贴均 ${formatCompact(avgExp)}，中位数 ${formatCompact(medianExp)}，差 ${ratio.toFixed(1)} 倍。${concText}`
      },
      {
        tone: top5Share >= 0.1 ? "is-warn" : top5Share >= 0.05 ? "is-neutral" : "is-good",
        title: "Top 内容集中度",
        body: `按复盘周期新增曝光排序，Top5 占比 ${formatPct(top5Share)}（Top20占比 ${formatPct(top20Share)}）；${topPost ? `最高单帖新增曝光 ${formatCompact(topPost.m.exposure)}（${topPost.displayChannelName || topPost.channelName || topPost.platform || "未知"}·${topPost.owner || "未知"}）。` : "当前暂无可排序内容。"}`
      },
      {
        tone: quality > 0 ? "is-good" : "is-warn",
        title: "复盘入口",
        body: `批次优质内容 ${formatInteger(quality)} 条；${topChannel ? `按复盘周期新增曝光看，渠道最高为 ${topChannel.label}，占比 ${formatPct(safeRate(topChannel.exposure, curExp))}。` : "渠道曝光暂缺。"}`
      }
    ];
    return `<section class="findings-panel">
      <div class="findings-title">本周关键发现</div>
      ${findings.map(item => `<div class="findings-item ${item.tone}"><span class="findings-bullet"></span><span><strong>${escapeHtml(item.title)}：</strong>${escapeHtml(item.body)}</span></div>`).join("")}
    </section>`;
  }

  if (tabKey === "cohort") {
    const breakdown = buildWeekBreakdown(all.poolPosts, reviewWindow.start, reviewWindow.end);
    const topWeek = breakdown.rows[0] || {};
    lines.push(`批次内帖子在复盘周期新增曝光 ${formatCompact(curExp)}，环比${wowExp > 0 ? "增长" : wowExp < 0 ? "下降" : "持平"} ${formatPct(Math.abs(wowExp))}。${Math.abs(wowExp) > 0.1 ? (wowExp > 0 ? "涨幅超10%，表现强势。" : "跌幅超10%，需要关注。") : "变化在正常范围内。"}`);
    if (topWeek.exposureShare > 0.3) lines.push(`${topWeek.key || "最新发布周"} 贡献了本周新增曝光的 ${formatPct(topWeek.exposureShare)}，是复盘周期最大的曝光来源。`);
    const allPosts = preprocessPosts(source.posts || []);
    const matrix = buildCohortMatrix(allPosts, reviewWindow.end);
    if (matrix.length >= 2 && matrix[0].weeks && matrix[1].weeks) {
      const curW1 = matrix[0].weeks[0]?.exposure || 0, prevW1 = matrix[1].weeks[0]?.exposure || 0;
      if (curW1 > 0 && prevW1 > 0) {
        const cmp = safeWoW(curW1, prevW1);
        lines.push(`复盘周期发布帖首周曝光 ${formatCompact(curW1)}，比上周同期 ${cmp > 0 ? "高" : "低"} ${formatPct(Math.abs(cmp))}。`);
      }
    }
    const rows = [...matrix].reverse();
    for (let ri = 1; ri < rows.length; ri++) {
      if ((rows[ri]?.cumulativeExposure || 0) > (rows[ri - 1]?.cumulativeExposure || 0)) {
        lines.push(`${rows[ri].key} 累计曝光反超 ${rows[ri - 1].key}，该周帖子存在衰减异常。`);
        break;
      }
    }
  }

  else if (tabKey === "channel") {
    const allCh = buildChannelRows(all.poolPosts, all.currentTotals);
    const prevCh = buildChannelRows(all.poolPosts, all.previousTotals, previousWindow.start, previousWindow.end);
    const withWow = allCh.map(ch => ({ ...ch, wow: safeWoW(ch.exposure, prevCh.find(p => p.label === ch.label)?.exposure || 0) })).sort((a, b) => b.wow - a.wow);
    const bestCh = withWow[0], worstCh = withWow[withWow.length - 1];
    if (bestCh && bestCh.wow > 0.1) lines.push(`${bestCh.label} 复盘周期新增曝光环比增长 ${formatPct(bestCh.wow)}，涨幅最大。`);
    if (worstCh && worstCh.wow < -0.1) lines.push(`${worstCh.label} 复盘周期新增曝光环比下降 ${formatPct(Math.abs(worstCh.wow))}，跌幅最大。`);
    const mismatch = allCh.find(ch => Math.abs(safeRate(ch.exposure, curExp) - safeRate(ch.interaction, curInt)) > 0.15);
    if (mismatch) lines.push(`${mismatch.label} 复盘周期新增曝光占比 ${formatPct(safeRate(mismatch.exposure, curExp))} 与新增互动占比 ${formatPct(safeRate(mismatch.interaction, curInt))} 存在明显错位，曝光和互动不在同一渠道。`);
  }

  else if (tabKey === "detail") {
    const detailPosts = all.scoped || [];
    const detailTotals = sumPostsForRange(detailPosts, reviewWindow.start, reviewWindow.end);
    const detailPreviousTotals = sumPostsForRange(detailPosts, previousWindow.start, previousWindow.end);
    const detailExp = detailTotals.exposure || 0;
    const detailPrevExp = detailPreviousTotals.exposure || 0;
    const detailWowExp = safeWoW(detailExp, detailPrevExp);
    const weekPosts = detailPosts.filter(p => p.publishDateObj && p.publishDateObj >= reviewWindow.start && p.publishDateObj <= reviewWindow.end);
    const curPosts = weekPosts.length;
    const top5 = detailPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 5);
    const top5Share = safeRate(sum(top5, p => p.m.exposure), detailExp);
    const top20 = detailPosts.map(p => ({ ...p, m: diffMetrics(p, reviewWindow.start, reviewWindow.end) })).sort((a, b) => b.m.exposure - a.m.exposure).slice(0, 20);
    const top20Share = safeRate(sum(top20, p => p.m.exposure), detailExp);
    const quality = detailPosts.filter(p => (asText(p.featuredQuality) === "1.0" || asText(p.featuredQuality) === "1")).length;
    const topics = new Set(detailPosts.map(p => asText(p.contentTopic || p.normalizedTopic || "").trim()).filter(Boolean));
    const detailChannelRows = buildChannelRows(detailPosts, detailTotals);
    const topChannel = detailChannelRows[0];
    lines.push(`当前帖子明细展示全量 ${formatInteger(detailPosts.length)} 帖；复盘周期新发布 ${formatInteger(curPosts)} 帖，全量帖子在复盘周期新增曝光 ${formatCompact(detailExp)}，环比${detailWowExp > 0 ? "增长" : detailWowExp < 0 ? "下降" : "持平"} ${formatPct(Math.abs(detailWowExp))}。可切换下方子视图查看：帖子明细 / Top 帖子 / 优质内容 / 主题分析。`);
    lines.push(`按复盘周期新增曝光排序，Top5 占比 ${formatPct(top5Share)}（Top20 占比 ${formatPct(top20Share)}），${top5Share >= 0.1 ? "头部内容集中度较高。" : top5Share >= 0.05 ? "头部内容有一定集中度。" : "曝光分布相对分散。"}`);
    lines.push(`全量优质内容 ${formatInteger(quality)} 条，占全量帖子 ${formatPct(safeRate(quality, detailPosts.length))}。${topics.size > 0 ? "覆盖 " + formatInteger(topics.size) + " 个主题。" : ""}`);
    if (topChannel) lines.push(`按复盘周期新增曝光看，渠道最高为 ${topChannel.label}，占比 ${formatPct(safeRate(topChannel.exposure, detailExp))}。`);
    if (state.importAudit) lines.push(`数据来源：${escapeHtml(state.importAudit.fileName || "导入文件")}，含 ${formatInteger(state.importAudit.acceptedRows)} 条有效记录。`);
    else lines.push("当前为内置样例数据，导入 Excel 后显示真实数据。");
  }

  if (!lines.length) return "";
  return `<section class="panel" style="border-left:3px solid var(--blue);">
    <div class="panel-head"><div class="panel-title"><h3>本周综述</h3><p>程序自动生成的事实汇总，不解释原因。</p></div></div>
    <div style="font-size:13px;line-height:1.8;color:var(--ink);">${lines.map((l, i) => `<p style="margin:2px 0;">${i + 1}. ${l}</p>`).join("")}</div>
  </section>`;
}

function renderWeekMeta(label,metaText,isImmature,isUp){const cls=["cohort-cell"];if(isImmature)cls.push("is-immature");if(isUp)cls.push("is-up");return `<div class="${cls.join(" ")}"><div class="cohort-cell-value">${escapeHtml(label)}</div><div class="cohort-cell-maturity">${escapeHtml(metaText)}</div></div>`;}

  function buildChannelHeatmap(poolPosts){
    const types = ["社媒", "KOL"];
    const platforms = ["tiktok", "facebook", "instagram", "pinterest", "youtube"];
    return types.map(type => {
      const typePosts = (poolPosts || []).filter(post => post.normalizedChannelType === type);
      const cells = platforms.map(platform => {
        const scopedPosts = type === "社群"
          ? typePosts
          : typePosts.filter(post => {
            const platformLower = asText(post.platform).toLowerCase();
            const channelLower = asText(post.channelName).toLowerCase();
            const displayLower = asText(post.displayChannelName).toLowerCase();
            return platformLower === platform || channelLower === platform || displayLower === platform;
          });
        const current = scopedPosts.reduce((acc, post) => {
          const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
          acc.exposure += metrics.exposure;
          acc.interaction += metrics.interaction;
          return acc;
        }, { exposure: 0, interaction: 0 });
        const previous = scopedPosts.reduce((acc, post) => {
          const metrics = diffMetrics(post, previousWindow.start, previousWindow.end);
          acc.exposure += metrics.exposure;
          acc.interaction += metrics.interaction;
          return acc;
        }, { exposure: 0, interaction: 0 });
        const value = type === "社群" ? current.interaction : current.exposure;
        const previousValue = type === "社群" ? previous.interaction : previous.exposure;
        const wow = safeWoW(value, previousValue);
        return {
          platform,
          type,
          value,
          interaction: current.interaction,
          wow,
          isUp: wow > 0,
          isDown: wow < 0,
          postCount: scopedPosts.length
        };
      });
      return { type, cells };
    });
  }

  function renderHeatmap(data, maxVal){
    if (!Array.isArray(data) || !data.length) return renderEmpty("暂无渠道热力图数据。");
    const platforms = ["tiktok", "facebook", "instagram", "pinterest", "youtube"];
    const types = data.map(group => group.type);
    const fallbackMax = Math.max(1, asNumber(maxVal));
    const typeMap = new Map(data.map(group => [group.type, group]));
    const header = `<tr><th style="text-align:left;">平台</th>${types.map(type => `<th>${escapeHtml(type)}</th>`).join("")}<th>合计</th></tr>`;
    const body = platforms.map(platform => {
      let rowTotal = 0;
      const cells = types.map(type => {
        const group = typeMap.get(type);
        const cell = (group && group.cells || []).find(item => item.platform === platform);
        if (!cell || (!cell.value && !cell.interaction && !cell.postCount)) {
          return `<td><div class="heatmap-cell is-empty">-</div></td>`;
        }
        rowTotal += asNumber(cell.value);
        const alpha = Math.max(0.08, Math.min(1, asNumber(cell.value) / fallbackMax));
        const wowCls = `heatmap-wow${cell.isUp ? " is-up" : cell.isDown ? " is-down" : ""}`;
        return `<td><div class="heatmap-cell" style="background:rgba(37,99,235,${alpha.toFixed(3)});"><div class="heatmap-value">${formatCompact(cell.value)}</div><div class="heatmap-posts">${formatInteger(cell.postCount)}帖</div><div class="${wowCls}">${formatDelta(cell.wow)}</div></div></td>`;
      }).join("");
      return `<tr><td class="heatmap-row-label">${escapeHtml(canonicalChannelName(platform))}</td>${cells}<td><div class="heatmap-cell"><div class="heatmap-value">${formatCompact(rowTotal)}</div></div></td></tr>`;
    }).join("");
    return `<div class="table-wrap"><table class="heatmap-table"><thead>${header}</thead><tbody>${body}</tbody></table></div>`;
  }

  function renderProductLineRanking(rows, avgInteractionRate){
    const sorted = Array.isArray(rows) ? rows.slice(0, 10) : [];
    if (!sorted.length) return renderEmpty("暂无品线数据。");
    const maxExposure = Math.max(1, ...sorted.map(row => asNumber(row.exposure)));
    return `<div>${sorted.map((row, index) => {
      const width = Math.max(4, asNumber(row.exposure) / maxExposure * 100);
      const relative = avgInteractionRate > 0 ? safeRate(asNumber(row.interactionRate), avgInteractionRate) : 1;
      const badgeTone = relative > 1.2
        ? { bg: "rgba(45,125,70,.12)", color: "var(--up)", text: "高于均值" }
        : relative < 0.8
          ? { bg: "rgba(201,64,67,.12)", color: "var(--down)", text: "低于均值" }
          : { bg: "rgba(212,131,26,.12)", color: "var(--warn)", text: "接近均值" };
      const vsAverage = safeWoW(asNumber(row.interactionRate), avgInteractionRate || 0);
      const vsColor = vsAverage > 0 ? "var(--up)" : vsAverage < 0 ? "var(--down)" : "var(--muted)";
      return `<div style="padding:8px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;font-size:12px;">
          <strong style="font-size:12px;color:var(--ink);">${index + 1}. ${escapeHtml(row.label)}</strong>
          <span style="padding:2px 8px;border-radius:999px;background:${badgeTone.bg};color:${badgeTone.color};font-size:11px;font-weight:700;">${badgeTone.text}</span>
        </div>
        <div style="margin-top:6px;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;">
          <div style="height:8px;border-radius:999px;background:var(--line);overflow:hidden;"><span style="display:block;height:100%;width:${width.toFixed(1)}%;background:var(--brand);"></span></div>
          <div style="font-size:11px;color:var(--muted);">${formatCompact(row.exposure)}</div>
        </div>
        <div style="margin-top:4px;display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--muted);">
          <span>互动率 ${formatPct(row.interactionRate)} · ${formatInteger(row.posts)}帖</span>
          <span style="color:${vsColor};font-weight:700;">vs均值 ${formatDelta(vsAverage)}</span>
        </div>
      </div>`;
    }).join("")}</div>`;
  }

  function renderOverview(){
    const all = deriveForScope("all");
    const community = deriveForScope("社群");
    const social = deriveForScope("社媒");
    const kol = deriveForScope("KOL");
    const curExp = all.currentTotals.exposure || 0;
    const curPosts = all.currentPostCount || 0;
    const avgExp = safeRate(curExp, Math.max(curPosts, 1));
    const exposureRows = all.poolPosts.map(post => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      return { post, exposure: metrics.exposure, interaction: metrics.interaction };
    }).filter(row => row.exposure > 0);
    const exposureValues = exposureRows.map(row => row.exposure).sort((a, b) => a - b);
    const mid = Math.floor(exposureValues.length / 2);
    const medianExp = exposureValues.length ? (exposureValues.length % 2 ? exposureValues[mid] : (exposureValues[mid - 1] + exposureValues[mid]) / 2) : 0;
    const bucketDefs = [
      { label: "10万+", min: 100000, max: Infinity, cls: "c1" },
      { label: "5-10万", min: 50000, max: 100000, cls: "c2" },
      { label: "1-5万", min: 10000, max: 50000, cls: "c3" },
      { label: "5千-1万", min: 5000, max: 10000, cls: "c4" },
      { label: "1千-5千", min: 1000, max: 5000, cls: "c5" },
      { label: "100-1千", min: 100, max: 1000, cls: "c6" },
      { label: "<100", min: 0, max: 100, cls: "c7" }
    ];
    const buckets = bucketDefs.map(bucket => {
      const rows = exposureRows.filter(row => row.exposure >= bucket.min && row.exposure < bucket.max);
      const exposure = sum(rows, row => row.exposure);
      return {
        ...bucket,
        posts: rows.length,
        exposure,
        exposureShare: safeRate(exposure, curExp)
      };
    });
    const highBucketExposure = sum(buckets.slice(0, 2), bucket => bucket.exposure);
    const top3Exposure = sum(buckets.slice(0, 3), bucket => bucket.exposure);
    const concentrationHtml = exposureRows.length ? `<div class="concentration-chart">${buckets.map(bucket => {
      const width = bucket.exposure > 0 ? Math.max(2, bucket.exposureShare * 100) : 0;
      return `<div class="concentration-row">
        <div class="concentration-label">${escapeHtml(bucket.label)}</div>
        <div class="concentration-track"><span class="concentration-fill ${bucket.cls}" style="width:${width.toFixed(1)}%"></span></div>
        <div class="concentration-meta">${formatInteger(bucket.posts)}帖 · ${formatPct(bucket.exposureShare)}</div>
      </div>`;
    }).join("")}</div><div class="concentration-summary">10万+与5-10万两档贡献 ${formatPct(safeRate(highBucketExposure, curExp))}；1万以上三档合计 ${formatPct(safeRate(top3Exposure, curExp))}。</div>` : renderEmpty("当前周期暂无曝光数据。");
    const channelItems = [
      { label: "社群", derived: community, metricLabel: "互动", value: community.currentTotals.interaction, topLabel: community.channelRows[0]?.label || "暂无" },
      { label: "社媒", derived: social, metricLabel: "曝光", value: social.currentTotals.exposure, topLabel: social.channelRows[0]?.label || "暂无" },
      { label: "KOL", derived: kol, metricLabel: "曝光", value: kol.currentTotals.exposure, topLabel: kol.channelRows[0]?.label || "暂无" }
    ];
    const totalChannelVal = sum(channelItems, c => c.value);
    const channelHtml = channelItems.map(item => {
      const prevVal = item.label === "社群" ? (deriveForScope("社群").previousTotals.interaction||0) : (item.label === "社媒" ? (social.previousTotals.exposure||0) : (kol.previousTotals.exposure||0));
      const wow = safeWoW(item.value, prevVal);
      const wowColor = wow > 0.1 ? "var(--up)" : wow < -0.1 ? "var(--down)" : "var(--muted)";
      const wowArrow = wow > 0.1 ? "↑" : wow < -0.1 ? "↓" : "→";
      const share = safeRate(item.value, Math.max(totalChannelVal, 1));
      const barW = Math.max(4, (share * 100).toFixed(1));
      const postCount = item.derived.currentPostCount || item.derived.poolPosts.length || 0;
      const perPost = safeRate(item.value, Math.max(postCount, 1));
      const perPostLabel = item.label === "社群" ? formatCompact(perPost) + "/帖" : "贴均" + formatCompact(perPost);
      return `<div style="padding:12px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px;">
          <strong style="font-size:13px;">${escapeHtml(item.label)}</strong>
          <span style="font-family:var(--font-mono);font-weight:700;font-size:14px;">${formatCompact(item.value)}</span>
        </div>
        <div style="height:6px;background:var(--line);border-radius:999px;overflow:hidden;margin-bottom:6px;">
          <span style="display:block;height:100%;width:${barW}%;background:var(--brand);border-radius:999px;"></span>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted);">
          <span>${formatInteger(postCount)}帖 · ${perPostLabel}</span>
          <span style="color:${wowColor};font-weight:600;">${wowArrow} ${formatPct(Math.abs(wow))}</span>
        </div>
      </div>`;
    }).join("");
    const topPosts = topPostsFromPool(all.poolPosts, "exposure", 3);
    const compareTone = value => !avgExp ? "is-neutral" : value >= avgExp * 1.2 ? "is-above" : value <= avgExp * 0.8 ? "is-below" : "is-neutral";
    const compareText = value => avgExp ? `${formatDelta(safeWoW(value, avgExp))} vs贴均` : "无贴均";
    const topRows = topPosts.map((post, index) => {
      const title = asText(post.title).slice(0, 32) || "无标题";
      const titleCell = post.link
        ? `<a href="${escapeHtml(post.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(title)}</a>`
        : escapeHtml(title);
      return `<tr><td class="label">Top ${index + 1}</td><td>${titleCell}<div style="font-size:11px;color:var(--muted);margin-top:2px;">${escapeHtml(post.channel || "未知渠道")}</div></td><td>${formatCompact(post.metrics.exposure)}</td><td class="${compareTone(post.metrics.exposure)}">${compareText(post.metrics.exposure)}</td></tr>`;
    }).join("");
    const contentHtml = `<div class="table-wrap"><table class="per-post-table">
      <thead><tr><th>项目</th><th>内容</th><th>曝光</th><th>对比</th></tr></thead>
      <tbody>
        ${topRows || `<tr><td colspan="4">暂无 Top 内容。</td></tr>`}
        <tr><td class="label">贴均曝光</td><td>全部有表现帖子</td><td>${formatCompact(avgExp)}</td><td class="is-neutral">基准</td></tr>
        <tr><td class="label">曝光中位数</td><td>${formatInteger(exposureValues.length)} 帖（复盘周期有新增曝光）</td><td>${formatCompact(medianExp)}</td><td class="${compareTone(medianExp)}">${compareText(medianExp)}</td></tr>
      </tbody>
    </table></div>`;
    return `${buildMetricCards("overview")}${buildNarrative("overview")}<div class="three-col-grid">
      <section class="panel">
        <div class="panel-head"><div class="panel-title"><h3>渠道速览</h3><p>批次内帖子在复盘周期的新增数据。</p></div></div>
        <div class="panel-body">${channelHtml}</div>
        <a href="#" class="quick-link" data-view="channel">进入渠道诊断</a>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title"><h3>曝光集中度</h3><p>按复盘周期单帖新增曝光分成 7 档。</p></div></div>
        <div class="panel-body">${concentrationHtml}</div>
        <a href="#" class="quick-link" data-view="cohort">查看 Cohort 矩阵</a>
      </section>
      <section class="panel">
        <div class="panel-head"><div class="panel-title"><h3>内容速览</h3><p>Top3 按复盘周期新增曝光，与贴均/中位对比。</p></div></div>
        <div class="panel-body">${contentHtml}</div>
        <a href="#" class="quick-link" data-view="detail">进入帖子明细</a>
      </section>
    </div>`;
  }

  function renderChannelDiagnosis(){
    const all = deriveForScope("all");
    const community = deriveForScope("社群");
    const social = deriveForScope("社媒");
    const kol = deriveForScope("KOL");
    const heatmapData = buildChannelHeatmap(all.poolPosts.filter(p => p.normalizedChannelType !== "社群"));
    const heatmapMax = Math.max(1, ...heatmapData.flatMap(group => (group.cells || []).map(cell => asNumber(cell.value))));
    const funnelRows = deriveFunnelDistribution(all.poolPosts.filter(post => post.normalizedChannelType !== "社群"));
    const projectRows = deriveProjectRows(all.poolPosts).slice(0, 6);
    const productLineRows = deriveProductLineRows(all.poolPosts);
    const avgInteractionRate = safeRate(all.currentTotals.interaction, all.currentTotals.exposure);
    const commMap = new Map();
    community.poolPosts.forEach(post => {
      const name = post.displayChannelName || post.channelName || "未知群";
      if (!commMap.has(name)) commMap.set(name, { label: name, posts: 0, interaction: 0 });
      const r = commMap.get(name);
      r.posts += 1;
      const diff = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      r.interaction += diff.interaction;
    });
    const communityRows = Array.from(commMap.values());
    const commMax = Math.max(1, ...communityRows.map(r => r.interaction));
    const communityHeatHtml = communityRows.length ? `<div class="bar-list">${communityRows.map(r => {
      const w = Math.max(3, Math.round(r.interaction / commMax * 100));
      return `<div class="bar-row"><div class="bar-name">${escapeHtml(r.label)}</div><div class="bar-track"><span class="bar-fill" style="width:${w}%;background:var(--brand);"></span></div><div class="bar-value">互动 ${formatCompact(r.interaction)} · ${formatInteger(r.posts)}帖</div></div>`;
    }).join("")}</div>` : renderEmpty("暂无社群数据。");
    const nonCommunity = deriveFromPosts("非社群", all.poolPosts.filter(post => post.normalizedChannelType !== "社群"));
    const baselineAvgExposure = safeRate(nonCommunity.currentTotals.exposure, nonCommunity.currentPostCount || nonCommunity.poolPosts.length || 1);
    const perPostRows = [
      { label: "社媒", derived: social },
      { label: "KOL", derived: kol }
    ];
    const perPostBody = perPostRows.map(row => {
      const postCount = row.derived.currentPostCount || row.derived.poolPosts.length || 0;
      const avgExposure = safeRate(row.derived.currentTotals.exposure, postCount || 1);
      const delta = row.baseline || !baselineAvgExposure ? 0 : safeWoW(avgExposure, baselineAvgExposure);
      const tone = row.baseline ? "is-neutral" : delta > 0.05 ? "is-above" : delta < -0.05 ? "is-below" : "is-neutral";
      const relative = row.baseline ? "基准" : baselineAvgExposure ? formatDelta(delta) : "-";
      const topSource = row.derived.channelRows[0]?.label || "暂无";
      return `<tr>
        <td class="label">${escapeHtml(row.label)}</td>
        <td>${formatInteger(postCount)}</td>
        <td>${formatCompact(row.derived.currentTotals.exposure)}</td>
        <td class="${tone}">${formatCompact(avgExposure)}</td>
        <td class="${tone}">${escapeHtml(relative)}</td>
        <td>${escapeHtml(topSource)}</td>
      </tr>`;
    }).join("");
    const perPostExposureTable = `<section class="panel">
      <div class="panel-head"><div class="panel-title"><h3>贴均曝光对比</h3><p>${formatDate(reviewWindow.start)} ~ ${formatDate(reviewWindow.end)} · 按有表现帖子数计算。</p></div></div>
      <div class="table-wrap"><table class="per-post-table">
        <thead><tr><th>范围</th><th>有表现帖</th><th>总曝光</th><th>贴均曝光</th><th>相对整体</th><th>Top来源</th></tr></thead>
        <tbody>${perPostBody}</tbody>
      </table></div>
    </section>`;
    return `${buildMetricCards("channel")}${buildNarrative("channel")}<section class="panel"><div class="panel-head"><div class="panel-title"><h3>渠道热力图</h3><p>${formatDate(reviewWindow.start)} ~ ${formatDate(reviewWindow.end)}。</p></div><div style="display:flex;gap:4px;"><button class="chip-button is-active" type="button" data-action="heatmap-toggle" data-heatmap-toggle="social-kol">社媒+KOL</button><button class="chip-button" type="button" data-action="heatmap-toggle" data-heatmap-toggle="community">社群</button></div></div><div data-heatmap-content="social-kol">${renderHeatmap(heatmapData, heatmapMax)}</div><div data-heatmap-content="community" hidden><p style="font-size:12px;color:var(--muted);margin-bottom:8px;">社群仅统计互动，无曝光口径。</p>${communityHeatHtml}</div></section>
    ${perPostExposureTable}
    <div class="color-legend" style="display:flex;gap:20px;align-items:center;font-size:12px;color:var(--muted);margin-bottom:16px;padding:10px 16px;background:var(--surface-warm);border-radius:var(--radius-sm);flex-wrap:wrap;">
      <span style="font-weight:600;color:var(--ink);">图例</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:var(--brand);margin-right:4px;vertical-align:middle;"></span> 进度条 = 曝光量占比</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:var(--up);margin-right:4px;vertical-align:middle;"></span> 绿色 = 高于均值 / 上涨</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:var(--down);margin-right:4px;vertical-align:middle;"></span> 红色 = 低于均值 / 下跌</span>
      <span><span style="display:inline-block;width:12px;height:12px;border-radius:999px;background:var(--warn);margin-right:4px;vertical-align:middle;"></span> 橙黄 = 接近均值</span>
    </div>
    <div class="three-col-grid">
      <section class="panel"><div class="panel-head"><div class="panel-title"><h3>漏斗分布</h3></div></div><p style="font-size:12px;color:var(--muted);margin-bottom:10px;">仅统计非社群帖子，观察各漏斗层级曝光分布和互动效率差异。</p>${(() => {
      if (!funnelRows.length) return renderEmpty("暂无漏斗数据。");
      const maxExp = Math.max(1, ...funnelRows.map(r => asNumber(r.exposure)));
      return funnelRows.map((r, i) => {
        const w = Math.max(4, asNumber(r.exposure) / maxExp * 100);
        return `<div style="padding:8px 0;border-bottom:1px solid var(--line);"><div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;"><strong>${i + 1}. ${escapeHtml(r.label)}</strong><span style="font-size:11px;color:var(--muted);">${formatInteger(r.posts)}帖</span></div><div style="margin-top:6px;display:grid;grid-template-columns:1fr auto;gap:8px;"><div style="height:8px;border-radius:999px;background:var(--line);overflow:hidden;"><span style="display:block;height:100%;width:${w.toFixed(1)}%;background:var(--brand);"></span></div><div style="font-size:11px;color:var(--muted);">${formatCompact(r.exposure)}</div></div><div style="margin-top:4px;font-size:11px;color:var(--muted);">互动率 ${formatPct(r.interactionRate)} · 占比 ${formatPct(r.exposureShare)}</div></div>`;
      }).join("");
    })()}</section>
      <section class="panel"><div class="panel-head"><div class="panel-title"><h3>项目对比</h3></div></div><p style="font-size:12px;color:var(--muted);margin-bottom:10px;">按项目聚合曝光和互动，关注不同项目的结构差异。</p>${(() => {
      if (!projectRows.length) return renderEmpty("暂无项目数据。");
      const maxExp = Math.max(1, ...projectRows.map(r => asNumber(r.exposure)));
      return projectRows.map((r, i) => {
        const w = Math.max(4, asNumber(r.exposure) / maxExp * 100);
        return `<div style="padding:8px 0;border-bottom:1px solid var(--line);"><div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;"><strong>${i + 1}. ${escapeHtml(r.label)}</strong><span style="font-size:11px;color:var(--muted);">${formatInteger(r.posts)}帖</span></div><div style="margin-top:6px;display:grid;grid-template-columns:1fr auto;gap:8px;"><div style="height:8px;border-radius:999px;background:var(--line);overflow:hidden;"><span style="display:block;height:100%;width:${w.toFixed(1)}%;background:var(--brand);"></span></div><div style="font-size:11px;color:var(--muted);">${formatCompact(r.exposure)}</div></div><div style="margin-top:4px;font-size:11px;color:var(--muted);">互动 ${formatCompact(r.interaction)} · 互动率 ${formatPct(r.interactionRate)}</div></div>`;
      }).join("");
    })()}</section>
      <section class="panel"><div class="panel-head"><div class="panel-title"><h3>品线排行</h3></div></div><p style="font-size:12px;color:var(--muted);margin-bottom:10px;">品线按曝光排序，互动率红色&lt;2%、黄色2-3%、绿色&gt;3%，最后一列为与全样本均值的定性对比。</p>${renderProductLineRanking(productLineRows.slice(0, 5), avgInteractionRate)}</section>
    </div>`;
  }
  function deriveTopPostsRankingRows(poolPosts, channelFilter = "全部渠道"){
    const normalizedFilter = asText(channelFilter) || "全部渠道";
    return (poolPosts || []).filter(post => {
      if (normalizedFilter === "全部渠道") return true;
      return asText(post.normalizedChannelType || normalizeChannelType(post.channelType, post.channelName || post.platform)) === normalizedFilter;
    }).map(post => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      const publishDate = post.publishDateObj || parseDate(post.publishDate);
      const week = publishDate ? naturalWeekRange(publishDate) : null;
      const weekLabel = week ? `${week.start.getFullYear()}-W${`${weekOfYear(week.start)}`.padStart(2, "0")}` : "-";
      const productLine = asText(post.productLine1) || asText(post.productLine2) || "未标记品线";
      return {
        title: asText(post.title) || contentLabel(post),
        link: asText(post.link),
        owner: asText(post.owner) || "未知",
        channel: asText(post.displayChannelName || post.channelName || post.platform) || "未知渠道",
        normalizedChannelType: asText(post.normalizedChannelType || normalizeChannelType(post.channelType, post.channelName || post.platform)),
        publishWeek: weekLabel,
        productLine,
        exposure: metrics.exposure,
        interaction: metrics.interaction,
        interactionRate: safeRate(metrics.interaction, metrics.exposure)
      };
    }).filter(row => row.exposure > 0 || row.interaction > 0)
      .sort((a, b) => b.exposure - a.exposure)
      .slice(0, 20);
  }

  function renderTopPostsRankingBody(poolPosts, channelFilter = "全部渠道"){
    const rows = deriveTopPostsRankingRows(poolPosts, channelFilter);
    if (!rows.length) return `<tr><td colspan="9">当前筛选条件下暂无可排序帖子。</td></tr>`;
    return rows.map((row, idx) => {
      const titleCell = row.link
        ? `<a href="${escapeHtml(row.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>`
        : escapeHtml(row.title);
      return `<tr><td>${idx + 1}</td><td>${titleCell}</td><td>${escapeHtml(row.owner)}</td><td>${escapeHtml(row.channel)}</td><td>${escapeHtml(row.publishWeek)}</td><td>${formatInteger(row.exposure)}</td><td>${formatInteger(row.interaction)}</td><td>${formatPct(row.interactionRate)}</td><td>${escapeHtml(row.productLine)}</td></tr>`;
    }).join("");
  }

  function renderTopPostsRanking(poolPosts){
    const selected = asText((dom.stage.querySelector("#top-posts-filter") || {}).value) || "全部渠道";
    const options = ["全部渠道", "社媒", "KOL", "社群"].map(value => `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(value)}</option>`).join("");
    const body = renderTopPostsRankingBody(poolPosts, selected);
    return `<div style="margin-bottom:8px;"><select id="top-posts-filter">${options}</select></div><div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>标题</th><th>发布人</th><th>渠道</th><th>发布周</th><th>曝光</th><th>互动</th><th>互动率</th><th>品线</th></tr></thead><tbody data-top-posts-tbody>${body}</tbody></table></div>`;
  }

  function renderQualityContentRanking(poolPosts){
    const isQuality = post => {
      const flag = asText(post && post.featuredQuality).trim();
      return flag === "1" || flag === "1.0";
    };
    const rows = (poolPosts || []).filter(isQuality).map(post => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      const publishDate = post.publishDateObj || parseDate(post.publishDate);
      const week = publishDate ? naturalWeekRange(publishDate) : null;
      const weekLabel = week ? `${week.start.getFullYear()}-W${`${weekOfYear(week.start)}`.padStart(2, "0")}` : "-";
      const productLine = asText(post.productLine1) || asText(post.productLine2) || "未标记品线";
      return {
        title: asText(post.title) || contentLabel(post),
        link: asText(post.link),
        owner: asText(post.owner) || "未知",
        channel: asText(post.displayChannelName || post.channelName || post.platform) || "未知渠道",
        publishWeek: weekLabel,
        productLine,
        exposure: metrics.exposure,
        interaction: metrics.interaction,
        interactionRate: safeRate(metrics.interaction, metrics.exposure)
      };
    }).sort((a, b) => b.interaction - a.interaction);
    if (!rows.length) return renderEmpty("当前周期暂无优质内容样本。");
    const limited = rows.slice(0, 50);
    const summary = `<div class="ranking-summary">优质内容 ${formatInteger(rows.length)} 帖，展示前 ${formatInteger(limited.length)} 帖；总曝光 ${formatCompact(sum(rows, row => row.exposure))}，总互动 ${formatCompact(sum(rows, row => row.interaction))}。</div>`;
    const tableRows = limited.map((row, idx) => {
      const titleCell = row.link
        ? `<a href="${escapeHtml(row.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.title)}</a>`
        : escapeHtml(row.title);
      return [
        `${idx + 1}`,
        titleCell,
        escapeHtml(row.owner),
        escapeHtml(row.channel),
        escapeHtml(row.publishWeek),
        formatInteger(row.exposure),
        formatInteger(row.interaction),
        formatPct(row.interactionRate),
        escapeHtml(row.productLine)
      ];
    });
    return summary + renderSimpleTable(["#","标题","发布人","渠道","发布周","曝光","互动","互动率","品线"], tableRows);
  }

  function renderTopicAnalysis(poolPosts){
    const groups = new Map();
    (poolPosts || []).forEach(post => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      if (metrics.exposure <= 0 && metrics.interaction <= 0) return;
      const rawTopic = asText(post.contentTopic || post.normalizedTopic);
      const topics = rawTopic
        ? rawTopic.split(/[;；,，]+/).map(part => asText(part).trim()).filter(t => t && t !== "未知" && t !== "未标记")
        : [];
      const uniqueTopics = [...new Set(topics)];
      uniqueTopics.forEach(topic => {
        if (!groups.has(topic)) groups.set(topic, { topic, postCount: 0, exposure: 0, interaction: 0 });
        const row = groups.get(topic);
        row.postCount += 1;
        row.exposure += metrics.exposure;
        row.interaction += metrics.interaction;
      });
    });
    const rows = Array.from(groups.values()).map(row => ({
      ...row,
      interactionRate: safeRate(row.interaction, row.exposure)
    })).sort((a, b) => b.exposure - a.exposure);
    if (!rows.length) return renderEmpty("当前周期暂无主题分析数据。");
    const maxExposure = Math.max(1, ...rows.map(row => row.exposure));
    return `<div class="bar-list">${rows.map(row => {
      const width = Math.max(3, Number((row.exposure / maxExposure * 100).toFixed(1)));
      let tone = "is-green";
      if (row.interactionRate < 0.02) tone = "is-red";
      else if (row.interactionRate <= 0.03) tone = "is-amber";
      return `<div class="bar-row topic-bar-row">
        <div class="bar-name">${escapeHtml(row.topic)}</div>
        <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
        <div class="bar-value">帖数 ${formatInteger(row.postCount)} · 曝光 ${formatCompact(row.exposure)} · <span class="topic-rate-badge ${tone}">互动率 ${formatPct(row.interactionRate)}</span></div>
      </div>`;
    }).join("")}</div>`;
  }

  function applyDetailFilters(tableId){
    const root = dom.stage.querySelector(`[data-detail-table-id="${tableId}"]`);
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!root || !store) return;
    const filters = Object.assign({}, state._activeFilters || {});
    root.querySelectorAll(".filter-bar .detail-filter[data-filter]").forEach(input => {
      filters[input.dataset.filter] = asText(input.value).trim().toLowerCase();
    });
    const dateFrom = parseDate(root.querySelector(".date-range-input[data-filter-date='from']")?.value);
    const dateTo = parseDate(root.querySelector(".date-range-input[data-filter-date='to']")?.value);
    const filtered = store.allRows.filter(row => {
      let matched = true;
      Object.entries(filters).forEach(([key, value]) => {
        if (!matched || !value || value === "all") return;
        const rowVal = asText(row[key] || "").toLowerCase();
        if (!rowVal.includes(value)) matched = false;
      });
      if (matched && (dateFrom || dateTo)) {
        const publishDate = parseDate(row.publishDate);
        if (!publishDate) matched = false;
        if (matched && dateFrom && publishDate < dateFrom) matched = false;
        if (matched && dateTo && publishDate > dateTo) matched = false;
      }
      return matched;
    });
    store.filteredRows = filtered.slice();
    updateDetailTable(tableId, store.filteredRows, 0);
  }

  function sortDetailTable(tableId, colIdx, dir){
    const root = dom.stage.querySelector(`[data-detail-table-id="${tableId}"]`);
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!root || !store || !Array.isArray(store.filteredRows)) return;
    const sortDir = dir === "desc" ? "desc" : "asc";
    root.dataset.sortColIdx = String(colIdx);
    root.dataset.sortDir = sortDir;
    root.querySelectorAll("th[data-col-idx]").forEach(th => {
      if (Number(th.dataset.colIdx) === colIdx) {
        th.dataset.dir = sortDir;
      } else {
        delete th.dataset.dir;
      }
    });
    const isNumericCol = new Set([8, 11, 12, 13, 14, 15, 16]).has(colIdx);
    const valueOf = row => {
      if (colIdx === 1) return row.publishDate;
      if (colIdx === 2) return row.channelType;
      if (colIdx === 3) return row.channelName;
      if (colIdx === 4) return row.productLine;
      if (colIdx === 5) return row.project;
      if (colIdx === 6) return row.topic;
      if (colIdx === 7) return row.format;
      if (colIdx === 8) return Number(asText(row.featuredQuality)) === 1 ? 1 : 0;
      if (colIdx === 9) return row.title;
      if (colIdx === 10) return row.ownerDisplay;
      if (colIdx === 11) return row.exposure;
      if (colIdx === 12) return row.interaction;
      if (colIdx === 13) return row.likes;
      if (colIdx === 14) return row.comments;
      if (colIdx === 15) return row.shares;
      if (colIdx === 16) return row.saves;
      return "";
    };
    store.filteredRows.sort((a, b) => {
      const left = valueOf(a);
      const right = valueOf(b);
      if (isNumericCol) {
        const diff = asNumber(left) - asNumber(right);
        return sortDir === "asc" ? diff : -diff;
      }
      const diff = String(left || "").localeCompare(String(right || ""), "zh-CN");
      return sortDir === "asc" ? diff : -diff;
    });
    updateDetailSortControls(root, colIdx, sortDir);
    updateDetailTable(tableId, store.filteredRows, 0);
  }

  function resetDetailFilters(tableId){
    const root = dom.stage.querySelector(`[data-detail-table-id="${tableId}"]`);
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!root || !store) return;
    state._activeFilters = {};
    closeFilterPopover();
    root.querySelectorAll(".filter-bar select[data-filter-key]").forEach(select => {
      select.value = "all";
    });
    root.querySelectorAll(".filter-bar .detail-filter[data-filter]").forEach(input => {
      input.value = "";
    });
    root.querySelectorAll(".filter-bar .date-range-input[data-filter-date]").forEach(input => {
      input.value = "";
    });
    updateDetailDateRangeLabel(root);
    root.querySelectorAll("th[data-col-idx]").forEach(th => {
      delete th.dataset.dir;
    });
    delete root.dataset.sortColIdx;
    delete root.dataset.sortDir;
    updateDetailSortControls(root, null, null);
    store.filteredRows = store.allRows.slice();
    updateFilterTags(root);
    updateDetailTable(tableId, store.filteredRows, 0);
  }

  function filterQualityContent(tableId){
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!store) return;
    const isQuality = row => {
      const text = asText(row.featuredQuality).trim();
      if (text === "1.0" || text === "1") return true;
      const post = store.postsById ? store.postsById[row.postId] : null;
      const postFlag = asText(post && post.featuredQuality).trim();
      return postFlag === "1.0" || postFlag === "1";
    };
    store.filteredRows = store.allRows.filter(isQuality);
    updateDetailTable(tableId, store.filteredRows, 0);
  }

  function exportDetailCSV(tableId){
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!store) return;
    const rows = Array.isArray(store.filteredRows) ? store.filteredRows : [];
    const headers = ["发布时间","渠道类型","平台","品线","项目","主题","形式","优质","标题","负责人","曝光","互动","点赞","评论","分享","收藏"];
    const escapeCsv = value => {
      const text = String(value == null ? "" : value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
    };
    const lines = [headers.join(",")];
    rows.forEach(row => {
      lines.push([
        row.publishDate,
        row.channelType,
        row.channelName,
        row.productLine,
        row.project,
        row.topic,
        row.format,
        (asText(row.featuredQuality) === "1.0" || asText(row.featuredQuality) === "1") ? "1.0" : "0",
        row.title,
        row.ownerDisplay,
        row.exposure,
        row.interaction,
        row.likes,
        row.comments,
        row.shares,
        row.saves
      ].map(escapeCsv).join(","));
    });
    downloadText(`post-detail-${state.reportEndDate || formatDate(reviewWindow.end)}.csv`, `\uFEFF${lines.join("\n")}`, "text/csv;charset=utf-8");
  }

  function renderDetailTitleCell(row){
    const link = normalizePostUrl(row.link);
    if (!link) return "-";
    const label = asText(row.title) || shortDisplayUrl(link);
    if (!label) return "-";
    return `<a class="link-cell detail-title-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(label)}">${escapeHtml(label)}</a>`;
  }

  function renderDetailTextCell(value){
    const text = asText(value);
    return text ? escapeHtml(text) : "-";
  }

  function renderDetailRow(row, index){
    const projectCell = renderDetailTextCell(row.project);
    const quality = (asText(row.featuredQuality) === "1.0" || asText(row.featuredQuality) === "1") ? "1.0" : "0";
    return `<tr data-detail-row="${index}">
      <td>${renderDetailTextCell(row.publishDate)}</td>
      <td>${renderDetailTextCell(row.channelType)}</td>
      <td>${renderDetailTextCell(row.channelName)}</td>
      <td>${renderDetailTextCell(row.productLine)}</td>
      <td>${projectCell}</td>
      <td>${renderDetailTextCell(row.topic)}</td>
      <td>${renderDetailTextCell(row.format)}</td>
      <td>${quality}</td>
      <td class="detail-title-cell">${renderDetailTitleCell(row)}</td>
      <td>${renderDetailTextCell(row.ownerDisplay)}</td>
      <td class="num">${formatInteger(row.exposure)}</td>
      <td class="num">${formatInteger(row.interaction)}</td>
      <td class="num">${formatInteger(row.likes)}</td>
      <td class="num">${formatInteger(row.comments)}</td>
      <td class="num">${formatInteger(row.shares)}</td>
      <td class="num">${formatInteger(row.saves)}</td>
    </tr>`;
  }

  function updateDetailSortControls(root, colIdx, dir){
    root.querySelectorAll("button[data-action='data-detail-sort']").forEach(btn => {
      const isActive = Number(btn.dataset.colIdx) === colIdx;
      btn.classList.toggle("is-active", isActive);
      btn.setAttribute("aria-pressed", isActive ? "true" : "false");
      btn.textContent = isActive ? (dir === "asc" ? "↑" : "↓") : "↕";
    });
  }

  function updateDetailPagination(root, totalRows, page, pageSize){
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    root.dataset.currentPage = String(page);
    const pageLabel = root.querySelector("[data-detail-page-label]");
    if (pageLabel) pageLabel.textContent = String(page + 1);
    const totalLabel = root.querySelector("[data-detail-total-pages]");
    if (totalLabel) totalLabel.textContent = String(totalPages);
    root.querySelectorAll("[data-page='prev'],[data-page='0']").forEach(btn => { btn.disabled = page === 0; });
    root.querySelectorAll("[data-page='next']").forEach(btn => { btn.disabled = page >= totalPages - 1; });
    root.querySelectorAll("[data-page]:not([data-page='prev']):not([data-page='next']):not([data-page='0'])").forEach(btn => {
      btn.dataset.page = String(totalPages - 1);
      btn.disabled = page >= totalPages - 1;
    });
  }

  function updateDetailTable(tableId, rows, page = 0){
    const root = dom.stage.querySelector(`[data-detail-table-id="${tableId}"]`);
    const store = (window.__weeklyDetailTables || {})[tableId];
    if (!root || !store) return;
    const tbody = root.querySelector("tbody");
    const statsEl = root.querySelector(".detail-stats");
    const dataRows = Array.isArray(rows) ? rows : [];
    const pageSize = 25;
    const totalPages = Math.max(1, Math.ceil(dataRows.length / pageSize));
    const safePage = Math.min(Math.max(0, Number(page) || 0), totalPages - 1);
    const pageRows = dataRows.slice(safePage * pageSize, safePage * pageSize + pageSize);
    if (tbody) {
      tbody.innerHTML = pageRows.length ? pageRows.map((row, index) => renderDetailRow(row, safePage * pageSize + index)).join("") : `<tr><td colspan="16">暂无满足条件的帖子</td></tr>`;
    }
    updateDetailPagination(root, dataRows.length, safePage, pageSize);
    if (statsEl) {
      const exposure = sum(dataRows, row => row.exposure);
      const interaction = sum(dataRows, row => row.interaction);
      statsEl.textContent = `共 ${formatInteger(store.allRows.length)} 帖 · 当前 ${formatInteger(dataRows.length)} 帖 · 总曝光 ${formatCompact(exposure)} · 总互动 ${formatCompact(interaction)}`;
    }
  }

  function renderOffsiteDetailSection(){
    const dtc = source.dtcSection || { totalCurrent: 0, totalPrevious: 0, totalLastYear: 0, rows: [] };
    const hasCurrentData = dtc.hasCurrentData !== false;
    const hasPreviousData = dtc.hasPreviousData !== false;
    const hasLastYearData = dtc.hasLastYearData !== false;
    const offsiteStart = parseDate(state.offsiteStartDate) || previousWindow.start;
    const offsiteEnd = parseDate(state.offsiteEndDate) || previousWindow.end;
    const prMetrics = Array.isArray(dtc.prMetrics) ? dtc.prMetrics : [];
    const tableRows = (dtc.rows || []).map(row => [
      escapeHtml(sanitizeOffsiteLabel(row.label || row.site || row.channel || "未知来源")),
      escapeHtml(row.type || "-"),
      escapeHtml(row.channel || "-"),
      escapeHtml(row.site || "-"),
      displayOffsiteValue(row.current, hasCurrentData),
      displayOffsiteShare(row, dtc, hasCurrentData),
      displayOffsiteValue(row.interaction, hasCurrentData),
      displayOffsiteValue(row.previous, hasPreviousData),
      displayOffsiteWow(row.current, row.previous, hasCurrentData, hasPreviousData)
    ]);
    return `<section class="panel offsite-detail-panel">
      <div class="panel-head">
        <div class="panel-title"><h3>站外数据</h3><p>沿用 1.0 D 模块口径，放在帖子明细底部作为补充展示。</p></div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${renderOffsiteWeekButton(offsiteStart, offsiteEnd)}
          <button class="button-sm" type="button" data-action="refresh-offsite-data">更新站外数据</button>
        </div>
      </div>
      <div class="dtc-summary">
        ${renderOffsiteSummaryCard("社交媒体提及量", displayOffsiteMetricValue(prMetrics[0]), "")}
        ${renderOffsiteSummaryCard("Media提及量", displayOffsiteMetricValue(prMetrics[1]), "")}
        ${renderOffsiteSummaryCard("SOV（Pending）", displayOffsiteMetricValue(prMetrics[2]), "")}
      </div>
      ${renderSimpleTable(["来源", "类型", "渠道", "站点", "曝光", "曝光占比", "互动", "上周曝光", "上周曝光环比"], tableRows)}
    </section>`;
  }

  function renderOffsiteWeekButton(start, end){
    return `<button class="button-sm" type="button" data-action="offsite-week-picker" style="display:flex;align-items:center;gap:6px;">
      <strong>W${String(weekOfYear(start)).padStart(2, "0")}</strong><span>${formatDate(start)} ~ ${formatDate(end)}</span><span style="font-size:10px;color:var(--muted);">▼</span>
    </button>`;
  }

  function displayOffsiteValue(value, hasData){
    return hasData ? formatCompact(asNumber(value)) : "-";
  }

  function displayOffsiteShare(row, dtc, hasData){
    if (!hasData) return "-";
    const share = Number.isFinite(Number(row.exposureShare))
      ? Number(row.exposureShare)
      : safeRate(asNumber(row.current), asNumber(dtc.totalCurrent));
    return formatPct(share);
  }

  function displayOffsiteWow(current, previous, hasCurrentData, hasPreviousData){
    const prev = asNumber(previous);
    if (!hasCurrentData || !hasPreviousData || !prev) return "-";
    return formatDelta(safeWoW(asNumber(current), prev));
  }

  function displayOffsiteMetricValue(metric){
    if (!metric || metric.hasData === false) return "-";
    if (metric.format === "pct") return formatPct(asNumber(metric.value));
    if (metric.format === "text") return metric.value ? String(metric.value) : "-";
    return formatCompact(asNumber(metric.value));
  }

  async function refreshOffsiteData(button){
    const endpoint = "http://127.0.0.1:8787/api/offsite/refresh";
    const label = button ? button.textContent : "";
    if (button) {
      button.disabled = true;
      button.textContent = "更新中...";
    }
    showToast("正在从飞书只读更新站外数据...");
    try {
      const url = `${endpoint}?start=${encodeURIComponent(state.offsiteStartDate)}&end=${encodeURIComponent(state.offsiteEndDate)}`;
      const response = await fetch(url);
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload.dtcSection) {
        throw new Error(payload?.error || `本地同步服务返回 ${response.status}`);
      }
      source = {
        ...source,
        dtcSection: cloneData(payload.dtcSection)
      };
      saveOffsiteCacheForCurrentRange(payload.dtcSection);
      await savePersistedImport(source);
      recompute();
      render();
      showToast(`站外数据已更新 · ${formatInteger(payload.dtcSection.rows?.length || 0)} 行`);
    } catch (error) {
      const message = error && error.name === "TypeError"
        ? "本地同步服务未启动，请先运行 start-dashboard-with-offsite-sync.cmd 打开看板。"
        : (error.message || error);
      showToast(`站外数据更新失败：${message}`);
      console.error("refreshOffsiteData error", error);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = label || "更新站外数据";
      }
    }
  }

  async function refreshWarehousePosts(button){
    const label = button ? button.textContent : "";
    const useCloudApi = shouldUseCloudWarehouseApi();
    const controller = new AbortController();
    let waitTimer = null;
    let slowTimer = null;
    let timeoutTimer = null;
    if (button) {
      button.disabled = true;
      button.textContent = "同步中...";
    }
    showToast(useCloudApi ? "正在触发云端数仓同步..." : "正在只读查询数仓全量帖子数据...");
    try {
      waitTimer = window.setTimeout(() => {
        if (button) button.textContent = "仍在查询...";
        showToast(useCloudApi ? "云端数仓同步仍在执行，通常需要 20-60 秒。" : "数仓仍在查询中，通常需要 20-60 秒。");
      }, 5000);
      slowTimer = window.setTimeout(() => {
        if (button) button.textContent = "查询较慢...";
        showToast("数仓查询仍未完成，请保持页面打开；超过 90 秒将自动判定超时。");
      }, 60000);
      timeoutTimer = window.setTimeout(() => controller.abort(), useCloudApi ? 15 * 60 * 1000 : 90000);
      const nextSource = useCloudApi
        ? await fetchWarehouseSourceFromCloud(controller.signal, button)
        : await fetchWarehouseSourceFromLocal(controller.signal);
      showWarehousePreview(nextSource);
    } catch (error) {
      const message = error && error.name === "AbortError"
        ? (useCloudApi ? "云端数仓查询超过 90 秒仍未返回，请稍后重试或检查 Netlify 函数日志。" : "数仓查询超过 90 秒仍未返回，请稍后重试或检查本地同步服务。")
        : error && error.name === "TypeError" && !useCloudApi
          ? "本地同步服务未启动，请先运行 start-dashboard-with-offsite-sync.cmd 打开看板。"
          : (error.message || error);
      showToast(`数仓同步失败：${message}`);
      console.error("refreshWarehousePosts error", error);
    } finally {
      window.clearTimeout(waitTimer);
      window.clearTimeout(slowTimer);
      window.clearTimeout(timeoutTimer);
      if (button) {
        button.disabled = false;
        button.textContent = label || "同步数仓";
      }
    }
  }

  function shouldUseCloudWarehouseApi(){
    const host = window.location.hostname;
    if (!host) return false;
    return !["127.0.0.1", "localhost", "::1"].includes(host);
  }

  async function fetchWarehouseSourceFromLocal(signal){
    const endpoint = "http://127.0.0.1:8787/api/posts/warehouse-refresh";
    const response = await fetch(`${endpoint}?full=1`, { signal, cache: "no-store" });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload.source?.posts) {
      throw new Error(payload?.error || `本地同步服务返回 ${response.status}`);
    }
    return payload.source;
  }

  async function fetchWarehouseSourceFromCloud(signal, button){
    const syncResponse = await fetch(`/api/posts/warehouse-sync-background?full=1&t=${Date.now()}`, {
      method: "POST",
      signal,
      cache: "no-store"
    });
    const syncPayload = await syncResponse.json().catch(() => null);
    if (!syncResponse.ok) {
      throw new Error(syncPayload?.error || `云端同步服务返回 ${syncResponse.status}`);
    }
    if (button) button.textContent = "后台同步...";
    showToast("云端后台同步已启动，正在等待数仓缓存更新...");
    const status = await waitForCloudWarehouseSync(signal, button);
    if (button) button.textContent = "读取缓存...";
    const range = status.meta?.range ? ` · ${status.meta.range}` : "";
    showToast(`云端缓存已更新${range}，正在读取数据...`);
    const cacheResponse = await fetch(`/api/posts/warehouse-cache?full=1&t=${Date.now()}`, {
      signal,
      cache: "no-store"
    });
    const cachePayload = await cacheResponse.json().catch(() => null);
    if (!cacheResponse.ok || !cachePayload?.ok || !cachePayload.source?.posts) {
      throw new Error(cachePayload?.error || `云端缓存服务返回 ${cacheResponse.status}`);
    }
    return cachePayload.source;
  }

  async function waitForCloudWarehouseSync(signal, button){
    const startedAt = Date.now();
    let lastStatusText = "";
    while (Date.now() - startedAt < 15 * 60 * 1000) {
      await sleepWithAbort(5000, signal);
      const response = await fetch(`/api/posts/warehouse-status?full=1&t=${Date.now()}`, {
        signal,
        cache: "no-store"
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error || `云端同步状态返回 ${response.status}`);
      }
      if (payload.status === "done") return payload;
      if (payload.status === "error") throw new Error(payload.error || "云端后台同步失败");
      const nextText = payload.status === "running" ? "后台同步中..." : "等待同步...";
      if (button && button.textContent !== nextText) button.textContent = nextText;
      const elapsed = Math.max(5, Math.round((Date.now() - startedAt) / 1000));
      const statusText = `云端数仓后台同步中，已等待 ${elapsed} 秒。`;
      if (statusText !== lastStatusText && elapsed % 15 === 0) {
        showToast(statusText);
        lastStatusText = statusText;
      }
    }
    throw new Error("云端后台同步超过 15 分钟仍未完成，请检查 Netlify 函数日志。");
  }

  function sleepWithAbort(ms, signal){
    if (signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      if (!signal) return;
      signal.addEventListener("abort", () => {
        window.clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  function showWarehousePreview(nextSource){
    const prepared = {
      ...nextSource,
      dtcSection: source.dtcSection
    };
    const audit = buildWarehousePreviewAudit(prepared);
    const canConfirm = (prepared.posts || []).length > 0;
    const channelRows = Object.keys(audit.channelDistribution || {})
      .sort((a, b) => a.localeCompare(b, "zh-CN"))
      .map(key => [escapeHtml(key), formatInteger(audit.channelDistribution[key])]);
    const metricRows = [
      ["有曝光快照", formatInteger(audit.metricObservedRows.exposure || 0)],
      ["有互动快照", formatInteger(audit.metricObservedRows.interaction || 0)]
    ];
    showModal({
      title: canConfirm ? "数仓同步预检" : "数仓同步未通过",
      subtitle: canConfirm ? "确认后才会替换当前帖子数据；取消不会影响现有看板。" : "数仓没有返回有效帖子，当前数据不会被替换。",
      body: `
        <div class="quality-grid">
          ${renderQualityCard("数据来源", "数仓只读同步", escapeHtml(prepared.importMeta?.range || "全量"))}
          ${renderQualityCard("帖子数", formatInteger((prepared.posts || []).length), "按平台帖子 ID 聚合")}
          ${renderQualityCard("原始快照行", formatInteger(audit.totalRows || 0), "来自指标源表")}
          ${renderQualityCard("有效帖子", formatInteger(audit.acceptedRows || 0), "可进入看板")}
          ${renderQualityCard("统计日期", escapeHtml(audit.statDateRange || "暂无"), "用于曝光/互动快照")}
          ${renderQualityCard("发布时间", escapeHtml(audit.publishDateRange || "暂无"), "用于内容批次")}
        </div>
        <div class="two-col" style="margin-top:14px">
          ${renderSimpleTable(["渠道类型","帖子数"], channelRows)}
          ${renderSimpleTable(["指标检查","快照数"], metricRows)}
        </div>
        <div class="empty-state" style="margin-top:14px">同步会覆盖当前本机帖子缓存；站外数据卡片仍保留当前缓存，不会被本次同步清空。</div>
      `,
      actions: `
        <button class="secondary-button" type="button" data-modal-close>取消</button>
        <button class="primary-button" type="button" ${canConfirm ? "" : "disabled"} data-confirm-warehouse-sync>确认同步</button>
      `,
      onMount(modal) {
        const confirm = modal.querySelector("[data-confirm-warehouse-sync]");
        if (!confirm || !canConfirm) return;
        confirm.addEventListener("click", async () => {
          await applyWarehouseSource(prepared, audit);
        });
      }
    });
  }

  function buildWarehousePreviewAudit(nextSource){
    const audit = createEmptyAudit((nextSource.audit && nextSource.audit.totalRows) || 0);
    const previewPosts = preprocessPosts(nextSource.posts || []);
    audit.acceptedRows = previewPosts.length;
    previewPosts.forEach(post => {
      audit.channelDistribution[post.normalizedChannelType] = (audit.channelDistribution[post.normalizedChannelType] || 0) + 1;
      audit.publishDates.push(post.publishDate);
      (post.snapshots || []).forEach(snapshot => {
        audit.statDates.push(snapshot.capturedAt);
        if (asNumber(snapshot.exposure) > 0) audit.metricObservedRows.exposure += 1;
        if (asNumber(snapshot.interaction) > 0) audit.metricObservedRows.interaction += 1;
      });
    });
    audit.statDateRange = rangeText(audit.statDates);
    audit.publishDateRange = rangeText(audit.publishDates);
    delete audit.statDates;
    delete audit.publishDates;
    return audit;
  }

  async function applyWarehouseSource(nextSource, audit){
    source = mergeImportedSource(nextSource);
    state.sourceLabel = "数仓数据";
    state.importMeta = nextSource.importMeta || { fileName: "数仓只读同步", savedAt: formatDate(new Date()) };
    state.importAudit = audit || nextSource.audit || null;
    await savePersistedImport({
      ...source,
      importAudit: state.importAudit
    });
    recompute();
    closeModal();
    render();
    const syncedRange = state.importMeta?.range || audit?.statDateRange || "全量";
    showToast(`帖子数据已同步 · ${formatInteger(source.posts.length)} 帖 · ${syncedRange}`);
  }

  function renderOffsiteSummaryCard(label, value, foot){
    return `<article class="summary-card">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
      <div class="summary-foot">${escapeHtml(foot || "")}</div>
    </article>`;
  }

  function offsiteCacheRangeKey(start = state.offsiteStartDate, end = state.offsiteEndDate){
    return `${start || ""}_${end || ""}`;
  }

  function loadOffsiteCache(){
    const cache = loadJson(OFFSITE_CACHE_KEY);
    return cache && typeof cache === "object" ? cache : { ranges: {}, lastRange: null };
  }

  function saveOffsiteCache(cache){
    saveJson(OFFSITE_CACHE_KEY, {
      ranges: cache.ranges || {},
      lastRange: cache.lastRange || null
    });
  }

  function restoreOffsiteStateFromCache(){
    const cache = loadOffsiteCache();
    const last = cache.lastRange || null;
    if (!last || !parseDate(last.start) || !parseDate(last.end)) return;
    state.offsiteStartDate = last.start;
    state.offsiteEndDate = last.end;
  }

  function saveOffsiteCacheForCurrentRange(dtcSection){
    const cache = loadOffsiteCache();
    const key = offsiteCacheRangeKey();
    cache.ranges = cache.ranges || {};
    cache.ranges[key] = {
      start: state.offsiteStartDate,
      end: state.offsiteEndDate,
      savedAt: new Date().toISOString(),
      dtcSection: cloneData(dtcSection)
    };
    cache.lastRange = { start: state.offsiteStartDate, end: state.offsiteEndDate };
    saveOffsiteCache(cache);
  }

  function applyCachedOffsiteForCurrentRange(){
    const cache = loadOffsiteCache();
    const entry = cache.ranges && cache.ranges[offsiteCacheRangeKey()];
    source = {
      ...source,
      dtcSection: cloneData(entry?.dtcSection || emptyOffsiteSection())
    };
    return !!entry;
  }

  function emptyOffsiteSection(){
    return {
      totalCurrent: 0,
      totalPrevious: 0,
      totalLastYear: 0,
      rows: [],
      prMetrics: [],
      hasCurrentData: false,
      hasPreviousData: false,
      hasLastYearData: false,
      source: { type: "local-cache", note: "当前站外周期尚未更新。" }
    };
  }

  function renderDetail(){
    const all = deriveForScope("all");
    const poolPosts = all.scoped || [];
    const tableId = "detail-main";
    const rows = poolPosts.map((post, index) => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      const firstProject = asText(post.project) || (post.projectKey || "").split("::")[0] || "-";
      const ownerDisplay = asText(post.owner) || "未知";
      return {
        postId: post.id || `post-${index}`,
        publishDate: post.publishDate || "",
        channelType: post.normalizedChannelType || normalizeChannelType(post.channelType, post.channelName || post.platform),
        channelName: post.displayChannelName || canonicalChannelName(post.channelName || post.platform || "未知"),
        productLine: asText(post.productLine1) || asText(post.productLine2) || "未标记品线",
        project: firstProject,
        topic: post.normalizedTopic || normalizeDimension(post.contentTopic) || "未知",
        format: post.normalizedFormat || normalizeContentFormat(post.contentFormat) || "未知",
        featuredQuality: asText(post.featuredQuality) || "0",
        title: post.title || contentLabel(post),
        owner: ownerDisplay.toLowerCase(),
        ownerDisplay,
        link: asText(post.link),
        exposure: metrics.exposure,
        interaction: metrics.interaction,
        likes: metrics.likes,
        comments: metrics.comments,
        shares: metrics.shares,
        saves: metrics.saves
      };
    });
    rows.sort((a, b) => asNumber(b.exposure) - asNumber(a.exposure));
    const uniqueValues = key => [...new Set(rows.map(row => asText(row[key]).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    const channelTypes = uniqueValues("channelType");
    const channels = uniqueValues("channelName");
    const productLines = uniqueValues("productLine");
    const projects = uniqueValues("project");
    const topics = uniqueValues("topic");
    const formats = uniqueValues("format");
    const detailStore = window.__weeklyDetailTables = window.__weeklyDetailTables || {};
    detailStore[tableId] = {
      allRows: rows.slice(),
      filteredRows: rows.slice(),
      postsById: poolPosts.reduce((acc, post) => {
        const id = asText(post.id);
        if (id) acc[id] = post;
        return acc;
      }, {})
    };
    state.filterCache = {
      channelType: channelTypes,
      channelName: channels,
      productLine: productLines,
      project: projects,
      topic: topics,
      format: formats
    };
    const sortableDetailCols = new Set([1, 11, 12, 13, 14, 15, 16]);
    const thWithSort = (colIdx, label) => {
      if (!sortableDetailCols.has(colIdx)) return `<th>${label}</th>`;
      const defaultDir = colIdx === 11 ? " data-dir=\"desc\"" : "";
      return `<th data-col-idx="${colIdx}"${defaultDir}>${label}<button type="button" class="detail-sort-btn" data-action="data-detail-sort" data-col-idx="${colIdx}" aria-label="${label}排序" aria-pressed="${colIdx === 11 ? "true" : "false"}">↕</button></th>`;
    };
    return `${buildMetricCards("detail")}${buildNarrative("detail")}<section class="panel" data-detail-table-id="${tableId}" data-sort-col-idx="11" data-sort-dir="desc">
      <div class="panel-head">
        <div class="panel-title"><h3>帖子明细</h3><p>默认展示全量帖子；发布时间、渠道、品线等筛选只在本表内收窄结果。</p></div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end;">
          <div style="display:flex;gap:8px;">
            <button class="button-sm" type="button" data-action="refresh-warehouse-posts">同步数仓</button>
            <button class="button-sm" type="button" data-action="data-detail-action" data-detail-kind="reset-filters">重置筛选</button>
            <button class="button-sm" type="button" data-action="data-detail-action" data-detail-kind="filter-quality">仅优质</button>
            <button class="button-sm" type="button" data-action="data-detail-action" data-detail-kind="export-csv">导出 CSV</button>
          </div>
          <div class="detail-ranking-toolbar">
            <button class="chip-button is-active" type="button" data-action="detail-view-mode" data-view-mode="detail">帖子明细</button>
            <button class="chip-button" type="button" data-action="detail-view-mode" data-view-mode="top">Top 帖子</button>
            <button class="chip-button" type="button" data-action="detail-view-mode" data-view-mode="quality">优质内容</button>
            <button class="chip-button" type="button" data-action="detail-view-mode" data-view-mode="topic">主题分析</button>
          </div>
        </div>
      </div>
      <div class="filter-bar" style="position:relative;">
          <div class="filter-dropdowns" style="display:flex;flex-wrap:wrap;gap:6px;">
          ${["channelType","channelName","productLine","project","topic","format"].map(key => {
            const keyLabels = {channelType:"渠道类型",channelName:"平台",productLine:"品线",project:"项目",topic:"主题",format:"形式"};
            const withSearch = ["productLine","project","topic"].includes(key);
            return `<div class="filter-dropdown" data-filter-dropdown="${key}">
              <button class="filter-dropdown-btn" type="button" data-action="toggle-filter-dropdown" data-filter-key="${key}">${keyLabels[key]} ▾</button>
              ${withSearch ? "" : ""}
            </div>`;
          }).join("")}
          <input class="detail-filter" type="text" data-filter="owner" placeholder="搜索负责人..." style="min-width:110px;height:34px;">
          <div class="date-range-picker">
            <button class="date-range-button" type="button" data-action="detail-date-range">
              <span data-detail-date-label>发布时间</span>
              <span class="date-range-caret">▼</span>
            </button>
            <input class="date-range-input" type="hidden" data-filter-date="from">
            <input class="date-range-input" type="hidden" data-filter-date="to">
          </div>
        </div>
        <div class="filter-tags" data-filter-tags style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;"></div>
        <div class="filter-popover-container" data-filter-popover style="display:none;position:absolute;top:100%;left:0;z-index:55;min-width:220px;max-height:320px;overflow-y:auto;background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:0 12px 40px rgba(15,23,42,.12);padding:8px 0;margin-top:4px;"></div>
      </div>
      <div class="table-wrap detail-table-wrap" style="margin-top:10px;">
        <table class="data-table detail-data-table">
          <thead>
            <tr>
              ${thWithSort(1, "发布时间")}
              ${thWithSort(2, "渠道类型")}
              ${thWithSort(3, "平台")}
              ${thWithSort(4, "品线")}
              ${thWithSort(5, "项目")}
              ${thWithSort(6, "主题")}
              ${thWithSort(7, "形式")}
              ${thWithSort(8, "优质")}
              ${thWithSort(9, "标题")}
              ${thWithSort(10, "负责人")}
              ${thWithSort(11, "曝光")}
              ${thWithSort(12, "互动")}
              ${thWithSort(13, "点赞")}
              ${thWithSort(14, "评论")}
              ${thWithSort(15, "分享")}
              ${thWithSort(16, "收藏")}
            </tr>
          </thead>
        <tbody>${rows.slice(0, 25).map((row, index) => renderDetailRow(row, index)).join("") || `<tr><td colspan="16">暂无数据</td></tr>`}</tbody>
        </table>
      </div>
      ${(() => {
        const pageSize = 25;
        const totalPages = Math.ceil(rows.length / pageSize);
        if (totalPages <= 1) return "";
        return `<div style="display:flex;align-items:center;justify-content:center;gap:8px;margin-top:12px;font-size:12px;">
          <button class="button-sm" type="button" data-action="detail-page" data-page="0">首页</button>
          <button class="button-sm" type="button" data-action="detail-page" data-page="prev">上一页</button>
          <span style="color:var(--muted);">第 <strong style="color:var(--ink);" data-detail-page-label>1</strong> / <strong style="color:var(--ink);" data-detail-total-pages>${totalPages}</strong> 页</span>
          <button class="button-sm" type="button" data-action="detail-page" data-page="next">下一页</button>
          <button class="button-sm" type="button" data-action="detail-page" data-page="${totalPages - 1}">末页</button>
        </div>`;
      })()}
      <div class="detail-stats" style="display:flex;align-items:center;justify-content:space-between;">
        <span>全量共 ${formatInteger(rows.length)} 帖 · 复盘周期曝光 ${formatCompact(sum(rows, row => row.exposure))} · 复盘周期互动 ${formatCompact(sum(rows, row => row.interaction))}</span>
        <span style="font-size:11px;color:var(--muted);">每页 25 条</span>
      </div>
    </section>${renderOffsiteDetailSection()}`;
  }
  function normalizeCohortMatrix(rows){return (rows||[]).map(row=>({key:row.cohortWeek||row.key,publishWeekStart:row.publishWeekStart,publishWeekEnd:row.publishWeekEnd,postCount:row.postCount||0,matureWeeks:row.matureWeeks||0,maturity:row.matureWeeks>=4,cumulativeExposure:row.totalExposure||0,interactionRate:row.interactionRate||0,maturityText:`成熟 ${formatInteger(row.matureWeeks||0)}/4 周`,weeks:(row.windows||[]).map(w=>({exposure:w.exposure||0,interaction:w.interaction||0,maturityText:w.mature?"成熟":"未成熟",isImmature:!w.mature}))}));}

  function renderCohort(){const all=deriveForScope("all"),poolPosts=all.poolPosts,allPosts=preprocessPosts(source.posts||[]),reviewStart=reviewWindow.start,reviewEnd=reviewWindow.end;const breakdown=buildWeekBreakdown(poolPosts,reviewStart,reviewEnd);const cohortPosts=allPosts.filter(post=>post&&post.publishDateObj&&post.publishDateObj<=reviewEnd);const matrix=normalizeCohortMatrix(buildCohortMatrix(cohortPosts,reviewEnd));const reviewWeekKey = reviewWindow.start.getFullYear() + '-W' + String(weekOfYear(reviewWindow.start)).padStart(2, '0');const previousReviewWeek=naturalWeekRange(addDays(reviewWindow.start,-7));const previousReviewWeekKey=previousReviewWeek.start.getFullYear()+'-W'+String(weekOfYear(previousReviewWeek.start)).padStart(2,'0');const currentWeekRow = matrix.find(function(row) { return row.key === reviewWeekKey; });const breakdownRows=breakdown.rows||[];const maxBreakdownExposure=Math.max(0,...breakdownRows.map(row=>row.exposure||0));const yMax=maxBreakdownExposure>0?maxBreakdownExposure:1;const yTicks=[1,0.75,0.5,0.25,0].map(tick=>`<span>${formatCompact(yMax*tick)}</span>`).join("");const breakdownBars=breakdownRows.map(row=>{const pct=Math.max(2,Math.round((row.exposureShare||0)*100));const isCurrentWeek=row.key===reviewWeekKey;const isLastWeek=row.key===previousReviewWeekKey;const barCls=["week-breakdown-bar"];if(isCurrentWeek)barCls.push("is-current");if(isLastWeek)barCls.push("is-last");const heightPct=Math.max(8,safeRate(row.exposure||0,yMax)*100);return `<div class="week-breakdown-item"><div class="week-breakdown-meta">${formatCompact(row.exposure||0)}</div><div class="week-breakdown-meta">${formatPct(row.exposureShare||0)}</div><div class="${barCls.join(" ")}" style="height:${heightPct.toFixed(1)}%;" onmouseenter="this.style.opacity='0.8'" onmouseleave="this.style.opacity='1'"></div></div>`;}).join("");const breakdownLabels=breakdownRows.map(row=>`<div class="week-breakdown-label">${escapeHtml(row.key||"更早")}</div>`).join("");const breakdownHtml=breakdownRows.length?`<div class="week-breakdown-chart"><div class="week-breakdown-y-axis">${yTicks}</div><div class="week-breakdown-plot">${breakdownBars}</div><div class="week-breakdown-x-axis">${breakdownLabels}</div></div>`:"";const topBreakdownWeek=breakdownRows.reduce((best,row)=>(row.exposure||0)>(best?.exposure||0)?row:best,null);const matrixRows=matrix.map((row,ri)=>{const weekCells=row.weeks.map((w,wi)=>{if(!(w.exposure>0||w.interaction>0))return `<td class="cohort-cell is-empty">-</td>`;const prev=ri>0?matrix[ri-1]?.weeks?.[wi]:null;const upArrow=!!(prev&&w.exposure>(prev.exposure||0)*1.3);return `<td>${renderWeekMeta(formatCompact(w.exposure),w.maturityText,w.isImmature,upArrow)}</td>`;}).join("");return `<tr class="cohort-row ${row.key===reviewWeekKey?"is-current-week":""}" data-publish-week="${escapeHtml(row.key)}"><td style="cursor:pointer;" data-action="expand-publish-week" data-week-key="${escapeHtml(row.key)}"><strong>${escapeHtml(row.key)}${row.key===reviewWeekKey?" (复盘周期发布周)":""}</strong><div class="cohort-cell-maturity">${formatDate(row.publishWeekStart)} ~ ${formatDate(row.publishWeekEnd)} · ${escapeHtml(row.maturityText)} · ${formatInteger(row.postCount)}帖</div></td>${weekCells}<td><div class="cohort-cell"><div class="cohort-cell-value">${formatCompact(row.cumulativeExposure)}</div><div class="cohort-cell-maturity">累计曝光</div></div></td><td><div class="cohort-cell"><div class="cohort-cell-value">${formatPct(row.interactionRate)}</div><div class="cohort-cell-maturity">互动率</div></div></td></tr>`;}).join("");return `${buildMetricCards("cohort")}${buildNarrative("cohort")}<section class="panel"><div class="panel-head"><div class="panel-title"><h3>本周总曝光拆解</h3></div></div><p style="font-size:12px;color:var(--muted);margin-bottom:10px;">按发布周拆解本周的总曝光贡献。</p>${breakdownHtml?`<div class="breakdown-layout"><div class="breakdown-left"><div class="week-breakdown">${breakdownHtml}</div></div><div class="breakdown-right"><div class="breakdown-side-card"><div class="label">📌 最大贡献周</div><div class="value">${escapeHtml(topBreakdownWeek?.key || "暂无")} · ${topBreakdownWeek?.exposure ? formatCompact(topBreakdownWeek.exposure) : "-"} · ${topBreakdownWeek?.exposureShare ? formatPct(topBreakdownWeek.exposureShare) : "-"}</div><div class="note">${topBreakdownWeek?.key === reviewWeekKey ? "复盘周期发布周贡献最大，新帖表现强劲" : topBreakdownWeek?.key === previousReviewWeekKey ? "上一发布周正处于爆发峰值" : "历史帖子仍在持续释放曝光"}</div></div><div class="breakdown-side-card"><div class="label">📊 新老帖占比</div><div class="mini-stacked-bar"><span class="seg-current" style="width:${((breakdown.rows.find(r=>r.key===reviewWeekKey)?.exposureShare||0)*100).toFixed(1)}%"></span><span class="seg-last" style="width:${((breakdown.rows.find(r=>r.key===previousReviewWeekKey)?.exposureShare||0)*100).toFixed(1)}%"></span><span class="seg-older" style="flex:1"></span></div><div class="mini-legend"><span style="font-size:11px;"><span style="display:inline-block;width:8px;height:8px;background:var(--blue);border-radius:2px;vertical-align:middle;"></span> 本周帖 ${breakdown.rows.find(r=>r.key===reviewWeekKey)?.exposure ? formatCompact(breakdown.rows.find(r=>r.key===reviewWeekKey).exposure) : "-"}</span><br><span style="font-size:11px;"><span style="display:inline-block;width:8px;height:8px;background:var(--up);border-radius:2px;vertical-align:middle;"></span> 上周帖 ${breakdown.rows.find(r=>r.key===previousReviewWeekKey)?.exposure ? formatCompact(breakdown.rows.find(r=>r.key===previousReviewWeekKey).exposure) : "-"}</span><br><span style="font-size:11px;"><span style="display:inline-block;width:8px;height:8px;background:var(--line);border-radius:2px;vertical-align:middle;"></span> 更早 ${(()=>{const c=(breakdown.rows.find(r=>r.key===reviewWeekKey)?.exposureShare||0)+(breakdown.rows.find(r=>r.key===previousReviewWeekKey)?.exposureShare||0);return formatPct(Math.max(0,1-c));})()}</span></div></div><div class="breakdown-side-card"><div class="label">⚡ 数据成熟度</div><div class="value">${currentWeekRow ? escapeHtml(currentWeekRow.maturityText) : "该周无帖"}</div><div class="note" style="color:var(--warn);">${!currentWeekRow ? "选中周无发布帖，无法评估成熟度" : currentWeekRow.maturity ? "该周帖子 4 周生命周期已全部走完，数据可做结论" : "该周帖子仅走完 " + currentWeekRow.matureWeeks + "/4 周，结论需谨慎"}</div></div></div></div>`:renderEmpty("当前周期暂无可拆解曝光数据。")}<div class="cohort-legend"><span><b style="color:var(--warn)">■</b> 本周占比 &lt; 30% = 新帖数据未跑满</span><span><b style="color:var(--up)">■</b> 上周占比 &gt; 30% = 上周有爆款</span></div></section><section class="panel"><div class="panel-head"><div class="panel-title"><h3>Cohort 曝光矩阵</h3><p>点击发布周可展开右侧详情。</p></div></div>${matrix.length?`<div class="table-wrap"><table class="cohort-table"><thead><tr><th>发布周</th><th>第1周<br>发布后1-7天</th><th>第2周<br>发布后8-14天</th><th>第3周<br>发布后15-21天</th><th>第4周<br>发布后22-28天</th><th>累计曝光</th><th>互动率</th></tr></thead><tbody>${matrixRows}</tbody></table></div>`:renderEmpty("暂无 Cohort 矩阵数据。")}</section>`;}

  function renderPublishWeekDetail(weekKey,matrixRow,poolPosts){
    const panel=document.getElementById("publish-week-detail");
    if(!panel)return;
    const target=asText(weekKey);
    const rows=Array.isArray(poolPosts)?poolPosts:[];
    const weekPosts=rows.filter(post=>{
      if(!post||!post.publishDateObj)return false;
      const date=post.publishDateObj;
      const key=`${date.getFullYear()}-W${`${weekOfYear(date)}`.padStart(2,"0")}`;
      return key===target;
    });
    const totals=weekPosts.reduce((acc,post)=>{
      const metrics=diffMetrics(post,reviewWindow.start,reviewWindow.end);
      acc.exposure+=metrics.exposure;
      acc.interaction+=metrics.interaction;
      return acc;
    },{exposure:0,interaction:0});
    const totalExposure=totals.exposure;
    const totalInteraction=totals.interaction;
    const top5=weekPosts.map(post=>{
      const metrics=diffMetrics(post,reviewWindow.start,reviewWindow.end);
      return {
        title:post.title||"无标题",
        link:post.link||"",
        owner:post.owner||"未知",
        channel:post.displayChannelName||post.channelName||post.platform||"未知",
        exposure:metrics.exposure,
        interactionRate:safeRate(metrics.interaction,metrics.exposure)
      };
    }).sort((a,b)=>b.exposure-a.exposure).slice(0,5);
    const productLines=deriveProductLineRows(weekPosts);
    const channels=buildChannelRows(weekPosts,{exposure:totalExposure,interaction:totalInteraction});
    const periodText=matrixRow&&matrixRow.publishWeekStart&&matrixRow.publishWeekEnd
      ? `${formatDate(matrixRow.publishWeekStart)} ~ ${formatDate(matrixRow.publishWeekEnd)}`
      : "该周发布时间范围缺失";
    const lineBars=productLines.slice(0,5).map(row=>`<div class="bar-row"><div>${escapeHtml(row.label)}</div><div class="bar-track"><span class="bar-fill" style="width:${Math.max(4,Math.round((row.exposureShare||0)*100))}%"></span></div><div>${formatCompact(row.exposure)} · ${formatPct(row.exposureShare)}</div></div>`).join("");
    const channelBars=channels.slice(0,5).map(row=>`<div class="bar-row"><div>${escapeHtml(row.label)}</div><div class="bar-track"><span class="bar-fill" style="width:${Math.max(4,Math.round((row.exposureShare||0)*100))}%"></span></div><div>${formatCompact(row.exposure)} · ${formatPct(row.exposureShare)}</div></div>`).join("");
    panel.innerHTML=`<div class="panel-head"><div class="panel-title"><h3>${escapeHtml(target||"发布周详情")}</h3><p>${escapeHtml(periodText)}</p></div><button class="button-sm" type="button" data-action="close-detail">关闭</button></div><div class="metric-grid"><div class="metric-card"><strong>${formatInteger(weekPosts.length)}</strong><p>帖子数</p></div><div class="metric-card"><strong>${formatCompact(totalExposure)}</strong><p>总曝光</p></div><div class="metric-card"><strong>${formatCompact(totalInteraction)}</strong><p>总互动</p></div><div class="metric-card"><strong>${formatPct(safeRate(totalInteraction,totalExposure))}</strong><p>互动率</p></div></div><section class="panel"><div class="panel-head"><div class="panel-title"><h3>品线分布</h3></div></div>${lineBars||renderEmpty("该发布周暂无品线数据。")}</section><section class="panel"><div class="panel-head"><div class="panel-title"><h3>渠道分布</h3></div></div>${channelBars||renderEmpty("该发布周暂无渠道数据。")}</section><section class="panel"><div class="panel-head"><div class="panel-title"><h3>Top 5 帖子（按曝光）</h3></div></div><div class="table-wrap"><table class="data-table"><thead><tr><th>#</th><th>标题</th><th>负责人</th><th>渠道</th><th>曝光</th><th>互动率</th></tr></thead><tbody>${top5.map((item,i)=>`<tr><td>${i+1}</td><td>${item.link?`<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`:escapeHtml(item.title)}</td><td>${escapeHtml(item.owner)}</td><td>${escapeHtml(item.channel)}</td><td>${formatCompact(item.exposure)}</td><td>${formatPct(item.interactionRate)}</td></tr>`).join("")||`<tr><td colspan="6">暂无数据</td></tr>`}</tbody></table></div></section>`;
    panel.hidden=false;
  }



  function lifecycleDiagnosis(row, gap, isCommunity){
    if (!row.posts) return "无数据";
    if (isCommunity) {
      if (row.interactionShare >= 0.5) return "互动集中";
      if (row.interactionShare >= 0.25) return "可观察";
      return "低贡献";
    }
    if (Math.abs(gap) < 0.05) return "曝光互动匹配";
    return gap > 0 ? "互动效率高" : "曝光高互动低";
  }

  function buildFactCards(derived){
    return [
      { label: "样本帖子数", value: formatInteger(derived.poolPosts.length), foot: "内容批次周期内发布" },
      { label: "本期曝光", value: formatCompact(derived.currentTotals.exposure), foot: `较前期 ${formatDelta(safeWoW(derived.currentTotals.exposure, derived.previousTotals.exposure))}` },
      { label: "本期互动", value: formatCompact(derived.currentTotals.interaction), foot: `较前期 ${formatDelta(safeWoW(derived.currentTotals.interaction, derived.previousTotals.interaction))}` },
      { label: "互动率", value: formatPct(derived.interactionRate), foot: `较前期 ${formatPctDelta(derived.interactionRate - derived.previousInteractionRate)}` }
    ];
  }

  function channelMetricCards(derived, isCommunity){
    if (isCommunity) {
      const topFiveInteraction = sum(derived.topPosts.slice(0, 5), post => post.metrics.interaction);
      const activeGroups = derived.channelRows.filter(row => row.interaction > 0).length;
      return [
        { label: "社群帖子数", value: formatInteger(derived.poolPosts.length), foot: "内容批次周期内发布" },
        { label: "本期互动", value: formatCompact(derived.currentTotals.interaction), foot: `较前期 ${formatDelta(safeWoW(derived.currentTotals.interaction, derived.previousTotals.interaction))}` },
        { label: "贴均互动", value: formatCompact(safeRate(derived.currentTotals.interaction, derived.currentPostCount)), foot: "互动 ÷ 有表现帖子" },
        { label: "Top5互动占比", value: formatPct(safeRate(topFiveInteraction, derived.currentTotals.interaction)), foot: `${formatInteger(activeGroups)} 个社群有互动` }
      ];
    }
    return [
      { label: "样本帖子数", value: formatInteger(derived.poolPosts.length), foot: "内容批次周期内发布" },
      { label: "本期曝光", value: formatCompact(derived.currentTotals.exposure), foot: `较前期 ${formatDelta(safeWoW(derived.currentTotals.exposure, derived.previousTotals.exposure))}` },
      { label: "本期互动", value: formatCompact(derived.currentTotals.interaction), foot: `互动率 ${formatPct(derived.interactionRate)}` },
      { label: "贴均曝光", value: formatCompact(safeRate(derived.currentTotals.exposure, derived.currentPostCount)), foot: "曝光 ÷ 有表现帖子" }
    ];
  }

  function buildOverviewHighlights(groups){
    const topChannel = groups.all.channelRows[0];
    const nonCommunity = deriveFromPosts("非社群", posts.filter(post => post.normalizedChannelType !== "社群"));
    const topInteraction = [...nonCommunity.channelRows].sort((a, b) => b.interaction - a.interaction)[0];
    const topFiveExposure = sum(nonCommunity.topPosts.slice(0, 5), post => post.metrics.exposure);
    const topFiveShare = safeRate(topFiveExposure, nonCommunity.currentTotals.exposure);
    const socialTop = groups.social.channelRows[0];
    const kolTop = groups.kol.channelRows[0];
    const quality = state.importAudit || buildBuiltinAudit();
    const recommendedMissing = getRecommendedMissing(quality);
    const projectRows = deriveProjectRows(groups.all.poolPosts);
    const topProject = projectRows[0];
    const funnelRows = deriveFunnelDistribution(groups.all.poolPosts);
    const topFunnel = funnelRows[0];
    return [
      {
        title: "渠道结构",
        body: topChannel ? `曝光优先看 ${topChannel.label}，贡献 ${formatPct(safeRate(topChannel.exposure, groups.all.currentTotals.exposure))} 曝光；互动优先看 ${topInteraction ? topInteraction.label : "暂无"}，贡献 ${formatPct(safeRate(topInteraction ? topInteraction.interaction : 0, nonCommunity.currentTotals.interaction))} 互动。这里是程序聚合事实，不解释原因。` : "暂无足够曝光数据。"
      },
      {
        title: "Top 内容边界",
        body: `Top5 帖子曝光占比 ${formatPct(topFiveShare)}。${topFiveShare >= 0.3 ? "可作为重点内容复盘入口，但仍需负责人确认原因。" : "低于 30%，只能说明 Top 内容具备复盘价值，不能写成 Top 内容带动整体。"}`
      },
      {
        title: "社媒与 KOL 的复盘入口",
        body: `社媒 Top 来源：${socialTop ? socialTop.label : "暂无"}；KOL Top 来源：${kolTop ? kolTop.label : "暂无"}。进入各渠道页查看 Top 帖、生命周期和负责人总结。`
      },
      {
        title: "数据质量边界",
        body: state.importMeta
          ? `导入有效行 ${formatInteger(quality.acceptedRows || 0)}，跳过 ${formatInteger((quality.totalRows || 0) - (quality.acceptedRows || 0))}；负责人缺失 ${formatInteger(recommendedMissing.owner || 0)}，链接缺失 ${formatInteger(recommendedMissing.link || 0)}。负责人归因和原帖判断必须人工补充。`
          : "当前为内置样例数据，只能演示界面和流程；正式结论需先导入本周 Excel。"
      },
      {
        title: "项目维度",
        body: topProject ? `项目维度 Top 为 ${topProject.label}，曝光 ${formatCompact(topProject.exposure)}，互动 ${formatCompact(topProject.interaction)}，样本 ${formatInteger(topProject.posts)} 帖。项目维度只做聚合排序，不自动解释项目效果。` : "暂无项目维度数据。"
      },
      {
        title: "漏斗结构",
        body: topFunnel ? `非社群漏斗 Top 为 ${topFunnel.label}，曝光占比 ${formatPct(topFunnel.exposureShare)}，互动率 ${formatPct(topFunnel.interactionRate)}。该结构只说明内容分布和表现入口，不代表转化效果。` : "暂无非社群漏斗结构数据。"
      }
    ];
  }

  function buildChannelProgramConclusions(scope, derived, topPosts){
    const isCommunity = scope === "社群";
    const topSource = derived.channelRows[0];
    const topInteractionSource = [...derived.channelRows].sort((a, b) => b.interaction - a.interaction)[0];
    const topFiveMetric = isCommunity
      ? sum(topPosts.slice(0, 5), post => post.metrics.interaction)
      : sum(topPosts.slice(0, 5), post => post.metrics.exposure);
    const topFiveShare = safeRate(topFiveMetric, isCommunity ? derived.currentTotals.interaction : derived.currentTotals.exposure);
    const lifecycleRows = buildLifecycleRows(derived.lifecyclePoolPosts, isCommunity);
    const lifecycleMetric = isCommunity ? "interaction" : "exposure";
    const lifecycleTop = [...lifecycleRows].sort((a, b) => asNumber(b[lifecycleMetric]) - asNumber(a[lifecycleMetric]))[0];
    if (isCommunity) {
      return [
        {
          title: "互动结构",
          body: `本期社群样本 ${formatInteger(derived.poolPosts.length)} 帖，总互动 ${formatInteger(derived.currentTotals.interaction)}。Top 来源为 ${topSource ? topSource.label : "暂无"}，Top5 帖互动占比 ${formatPct(topFiveShare)}。`
        },
        {
          title: "生命周期样本",
          body: `当前发帖周样本 ${formatInteger(derived.lifecyclePoolPosts.length)} 帖，${lifecycleTop ? `${lifecycleTop.label} 互动 ${formatInteger(lifecycleTop.interaction)}，贡献 ${formatPct(lifecycleTop.interactionShare)}。` : "暂无生命周期数据。"}生命周期互动和本期互动不是同一统计窗口，不能直接相加。`
        },
        {
          title: "人工复盘入口",
          body: "程序只能识别互动集中和 Top 帖链接，不能判断话题为什么有效；负责人需要补充话题、提问方式、评论引导和实际负责人。"
        }
      ];
    }
    const funnelRows = deriveFunnelDistribution(derived.poolPosts);
    const topFunnel = funnelRows[0];
    return [
      {
        title: "来源结构",
        body: `${scope} 本期样本 ${formatInteger(derived.poolPosts.length)} 帖，曝光 ${formatCompact(derived.currentTotals.exposure)}，互动 ${formatCompact(derived.currentTotals.interaction)}。曝光 Top 来源为 ${topSource ? topSource.label : "暂无"}，互动 Top 来源为 ${topInteractionSource ? topInteractionSource.label : "暂无"}。`
      },
      {
        title: "Top 内容边界",
        body: `Top5 曝光占比 ${formatPct(topFiveShare)}。${topFiveShare >= 0.3 ? "可进入重点拆解，但仍不能替代负责人判断原因。" : "低于 30%，只能作为复盘入口，不能写成带动整体。"}`
      },
      {
        title: "生命周期入口",
        body: `当前发帖周样本 ${formatInteger(derived.lifecyclePoolPosts.length)} 帖，${lifecycleTop ? `${lifecycleTop.label} 曝光 ${formatCompact(lifecycleTop.exposure)}，互动 ${formatCompact(lifecycleTop.interaction)}。` : "暂无生命周期数据。"}这只说明该发帖周的释放节奏，不代表所有内容通用规律。`
      },
      {
        title: "漏斗效率",
        body: topFunnel ? `${scope} 漏斗 Top 为 ${topFunnel.label}，曝光 ${formatCompact(topFunnel.exposure)}，互动 ${formatCompact(topFunnel.interaction)}，互动率 ${formatPct(topFunnel.interactionRate)}。漏斗效率只能说明曝光和互动承接差异，不能直接写成转化结果。` : "暂无漏斗层级数据，不能判断漏斗效率。"
      }
    ];
  }

  function renderChannelMiniCard(label, derived, metric){
    const top = derived.channelRows[0];
    const topPost = derived.topPosts[0];
    const value = metric === "interaction" ? derived.currentTotals.interaction : derived.currentTotals.exposure;
    return `<article class="quality-card">
      <strong>${escapeHtml(label)}</strong>
      <p>本期${metric === "interaction" ? "互动" : "曝光"} ${formatCompact(value)}，样本 ${formatInteger(derived.poolPosts.length)} 帖。</p>
      <p>Top来源：${escapeHtml(top ? top.label : "暂无")}；Top内容：${escapeHtml(topPost ? topPost.title : "暂无")}。</p>
    </article>`;
  }

  function renderPlaybookCard(channel){
    const key = normalizeStorageKey(channel);
    const reuseKey = `${PLAYBOOK_PREFIX}.${key}.reuse`;
    const riskKey = `${PLAYBOOK_PREFIX}.${key}.risk`;
    return `<article class="playbook-card">
      <h4>${escapeHtml(channel)}</h4>
      <label class="field-label">可复用经验
        <textarea data-playbook-key="${escapeHtml(reuseKey)}" placeholder="沉淀可以复用的内容形式、话题、协作方式。">${escapeHtml(loadText(reuseKey))}</textarea>
      </label>
      <label class="field-label">避雷区
        <textarea data-playbook-key="${escapeHtml(riskKey)}" placeholder="记录不建议继续复制的问题、口径风险或执行注意事项。">${escapeHtml(loadText(riskKey))}</textarea>
      </label>
    </article>`;
  }

  function renderLongTermExperienceCards(items){
    if (!items.length) return renderEmpty("长期假设达到验证周期并由负责人确认后，会沉淀在这里。");
    return `<div class="longterm-experience-grid">${items.map(item => {
      const latest = latestLongTermRecord(item);
      return `<article class="longterm-experience-card">
        <div class="longterm-card-top">
          <strong>${escapeHtml(item.title)}</strong>
          ${pill("长期经验", "confirmed")}
        </div>
        <p>${escapeHtml(item.experienceDraft || item.description || "")}</p>
        <div class="longterm-evidence-line">最近验证：${escapeHtml(latest ? latest.evidence : "暂无记录")}</div>
      </article>`;
    }).join("")}</div>`;
  }

  function renderLongTermCard(item){
    const stats = longTermStats(item);
    const latest = latestLongTermRecord(item);
    const progress = Math.min(100, stats.support / LONG_TERM_SUPPORT_TARGET * 100);
    const canAccept = item.status === "candidate";
    const canWatch = item.status === "reopened";
    return `<article class="longterm-card" data-long-term-id="${escapeHtml(item.id)}">
      <div class="longterm-card-top">
        <div>
          <span class="longterm-channel">${escapeHtml(item.channel || "全局")}</span>
          <h4>${escapeHtml(item.title)}</h4>
        </div>
        ${pill(longTermStatusLabel(item.status), longTermStatusTone(item.status))}
      </div>
      <p class="longterm-desc">${escapeHtml(item.description || "")}</p>
      <div class="longterm-meter" aria-label="长期假设验证进度">
        <span style="width:${progress.toFixed(1)}%"></span>
      </div>
      <div class="longterm-stats">
        <span>支持 ${formatInteger(stats.support)}</span>
        <span>反证 ${formatInteger(stats.refute)}</span>
        <span>数据不足 ${formatInteger(stats.insufficient)}</span>
        <span>进度 ${Math.min(stats.support, LONG_TERM_SUPPORT_TARGET)}/${LONG_TERM_SUPPORT_TARGET}</span>
      </div>
      <div class="longterm-latest">
        <strong>${latest ? `${escapeHtml(latest.reportStartDate)} ~ ${escapeHtml(latest.reportEndDate)} · ${escapeHtml(longTermResultLabel(latest.result))}` : "暂无本周验证"}</strong>
        <p>${escapeHtml(latest ? latest.evidence : "导入数据后会自动写入本周验证记录。")}</p>
        ${latest && latest.counterEvidence ? `<p class="is-risk">${escapeHtml(latest.counterEvidence)}</p>` : ""}
      </div>
      <div class="longterm-actions">
        ${canAccept ? `<button class="primary-button" type="button" data-action="accept-long-term-hypothesis">加入长期经验</button>` : ""}
        ${canWatch ? `<button class="secondary-button" type="button" data-action="watch-long-term-hypothesis">重新进入判断</button>` : ""}
      </div>
    </article>`;
  }

  function syncLongTermHypothesisPool(){
    if (!posts.length || !state.reportStartDate || !state.reportEndDate) return;
    const stored = loadLongTermPool();
    const byId = new Map(stored.map(item => [item.id, item]));
    const seeds = buildLongTermHypothesisSeeds();
    const now = formatDate(new Date());
    const next = seeds.map(seed => {
      const previous = byId.get(seed.id) || {};
      const item = {
        ...previous,
        id: seed.id,
        title: seed.title,
        channel: seed.channel,
        description: seed.description,
        experienceDraft: seed.experienceDraft,
        createdAt: previous.createdAt || now,
        records: upsertLongTermRecord(previous.records || [], seed.record),
        updatedAt: now
      };
      return applyLongTermStatus(item);
    });
    saveLongTermPool(next);
  }

  function buildLongTermHypothesisSeeds(){
    const social = deriveForScope("社媒");
    const kol = deriveForScope("KOL");
    const community = deriveForScope("社群");
    return [
      buildKolTikTokLongTermSeed(kol),
      buildKolTopConcentrationSeed(kol),
      buildCommunityConcentrationSeed(community),
      buildSocialRoleSplitSeed(social)
    ];
  }

  function buildKolTikTokLongTermSeed(kol){
    const tiktok = findChannelRow(kol.channelRows, "TikTok");
    const hasEnough = kol.poolPosts.length >= 30 && tiktok;
    const support = hasEnough && tiktok.interactionShare >= 0.55 && tiktok.exposureShare >= 0.5;
    const refute = hasEnough && (tiktok.interactionShare < 0.4 || tiktok.exposureShare < 0.35);
    return longTermSeed({
      id: "kol-tiktok-primary",
      title: "KOL 是否长期由 TikTok 贡献主要表现",
      channel: "KOL",
      description: "验证 KOL 复盘是否应长期优先从 TikTok Top 内容切入。",
      experienceDraft: "KOL 周复盘优先检查 TikTok Top 内容，再由负责人判断题材、展示方式和达人语境是否可复用。",
      result: !hasEnough ? "insufficient" : support ? "support" : refute ? "refute" : "insufficient",
      evidence: tiktok
        ? `TikTok 曝光占比 ${formatPct(tiktok.exposureShare)}，互动占比 ${formatPct(tiktok.interactionShare)}，KOL 样本 ${formatInteger(kol.poolPosts.length)} 帖。`
        : "KOL 中暂无 TikTok 可验证数据。",
      counterEvidence: refute ? "TikTok 贡献占比低于长期假设阈值，本周不支持将 TikTok 作为 KOL 首要复盘入口。" : "",
      metrics: {
        posts: kol.poolPosts.length,
        tiktokExposureShare: tiktok ? tiktok.exposureShare : 0,
        tiktokInteractionShare: tiktok ? tiktok.interactionShare : 0
      }
    });
  }

  function buildKolTopConcentrationSeed(kol){
    const topExposurePosts = topPostsFromPool(kol.poolPosts, "exposure", 5);
    const topInteractionPosts = topPostsFromPool(kol.poolPosts, "interaction", 5);
    const exposureShare = safeRate(sum(topExposurePosts, post => post.metrics.exposure), kol.currentTotals.exposure);
    const interactionShare = safeRate(sum(topInteractionPosts, post => post.metrics.interaction), kol.currentTotals.interaction);
    const hasEnough = kol.poolPosts.length >= 30 && (kol.currentTotals.exposure > 0 || kol.currentTotals.interaction > 0);
    const support = hasEnough && (exposureShare >= 0.45 || interactionShare >= 0.45);
    const refute = hasEnough && exposureShare < 0.25 && interactionShare < 0.25;
    return longTermSeed({
      id: "kol-top-content-concentration",
      title: "KOL Top 内容是否能长期作为复盘样本",
      channel: "KOL",
      description: "验证 KOL 表现是否长期集中在少数 Top 内容，适不适合沉淀内容模板。",
      experienceDraft: "KOL Top 内容进入负责人拆解清单，重点记录内容结构、产品露出、互动触发点和不可复用原因。",
      result: !hasEnough ? "insufficient" : support ? "support" : refute ? "refute" : "insufficient",
      evidence: `KOL Top5 曝光占比 ${formatPct(exposureShare)}，Top5 互动占比 ${formatPct(interactionShare)}，样本 ${formatInteger(kol.poolPosts.length)} 帖。`,
      counterEvidence: refute ? "Top 内容集中度不足，本周更像分散表现，不适合沉淀为少数内容模板。" : "",
      metrics: { exposureShare, interactionShare, posts: kol.poolPosts.length }
    });
  }

  function buildCommunityConcentrationSeed(community){
    const topFiveInteraction = sum(community.topPosts.slice(0, 5), post => post.metrics.interaction);
    const topFiveShare = safeRate(topFiveInteraction, community.currentTotals.interaction);
    const hasEnough = community.poolPosts.length >= 10 && community.currentTotals.interaction >= 50;
    const support = hasEnough && topFiveShare >= 0.5;
    const refute = hasEnough && topFiveShare < 0.3;
    return longTermSeed({
      id: "community-top-interaction",
      title: "社群互动是否长期集中在 Top 帖",
      channel: "社群",
      description: "验证社群是否适合长期只围绕 Top 互动帖做轻量复盘。",
      experienceDraft: "社群复盘保留 Top 帖、话题、提问方式和负责人总结，避免用曝光或互动率解释。",
      result: !hasEnough ? "insufficient" : support ? "support" : refute ? "refute" : "insufficient",
      evidence: `社群 Top5 互动占比 ${formatPct(topFiveShare)}，总互动 ${formatInteger(community.currentTotals.interaction)}，样本 ${formatInteger(community.poolPosts.length)} 帖。`,
      counterEvidence: refute ? "Top5 互动占比偏低，本周社群互动更分散，不支持只围绕少数帖子复盘。" : "",
      metrics: { topFiveShare, interaction: community.currentTotals.interaction, posts: community.poolPosts.length }
    });
  }

  function buildSocialRoleSplitSeed(social){
    const exposureLeader = [...social.channelRows].sort((a, b) => b.exposure - a.exposure)[0];
    const interactionLeader = [...social.channelRows].sort((a, b) => b.interaction - a.interaction)[0];
    const hasEnough = social.poolPosts.length >= 100 && exposureLeader && interactionLeader;
    const support = hasEnough
      && exposureLeader.label !== interactionLeader.label
      && exposureLeader.exposureShare >= 0.35
      && interactionLeader.interactionShare >= 0.35;
    const refute = hasEnough
      && (exposureLeader.label === interactionLeader.label || Math.abs(exposureLeader.exposureShare - interactionLeader.interactionShare) < 0.08);
    return longTermSeed({
      id: "social-platform-role-split",
      title: "社媒是否长期存在曝光与互动角色分化",
      channel: "社媒",
      description: "验证社媒复盘是否需要长期拆分曝光入口和互动入口，而不是用单一平台解释。",
      experienceDraft: "社媒复盘按平台角色拆开看：曝光入口看高曝光平台，互动入口看高互动平台，再由负责人补内容原因。",
      result: !hasEnough ? "insufficient" : support ? "support" : refute ? "refute" : "insufficient",
      evidence: exposureLeader && interactionLeader
        ? `曝光最高为 ${exposureLeader.label}（${formatPct(exposureLeader.exposureShare)}），互动最高为 ${interactionLeader.label}（${formatPct(interactionLeader.interactionShare)}）。`
        : "社媒暂无可验证的平台分布数据。",
      counterEvidence: refute ? "曝光和互动主要由同一平台贡献，或差异不足，本周不支持角色分化假设。" : "",
      metrics: {
        posts: social.poolPosts.length,
        exposureLeader: exposureLeader ? exposureLeader.label : "",
        interactionLeader: interactionLeader ? interactionLeader.label : "",
        exposureLeaderShare: exposureLeader ? exposureLeader.exposureShare : 0,
        interactionLeaderShare: interactionLeader ? interactionLeader.interactionShare : 0
      }
    });
  }

  function longTermSeed(config){
    return {
      id: config.id,
      title: config.title,
      channel: config.channel,
      description: config.description,
      experienceDraft: config.experienceDraft,
      record: {
        weekKey: currentLongTermWeekKey(),
        reportStartDate: state.reportStartDate,
        reportEndDate: state.reportEndDate,
        result: config.result,
        score: config.result === "support" ? 1 : config.result === "refute" ? -1 : 0,
        evidence: config.evidence,
        counterEvidence: config.counterEvidence || "",
        metrics: config.metrics || {},
        generatedAt: formatDate(new Date())
      }
    };
  }

  function upsertLongTermRecord(records, nextRecord){
    const normalized = (records || []).filter(Boolean);
    const index = normalized.findIndex(record => record.weekKey === nextRecord.weekKey);
    if (index >= 0) normalized[index] = { ...normalized[index], ...nextRecord };
    else normalized.push(nextRecord);
    return normalized.sort((a, b) => asText(a.reportEndDate).localeCompare(asText(b.reportEndDate)));
  }

  function applyLongTermStatus(item){
    const stats = longTermStats(item);
    const recent = longTermValidRecords(item).slice(-LONG_TERM_RECENT_WINDOW);
    const recentSupport = recent.filter(record => record.result === "support").length;
    const recentRefute = recent.filter(record => record.result === "refute").length;
    const previouslyAccepted = Boolean(item.acceptedAt);
    if (previouslyAccepted && recent.length >= LONG_TERM_RECENT_WINDOW && recentRefute >= LONG_TERM_RECENT_THRESHOLD) {
      return { ...item, status: "reopened", acceptedAt: "", reopenedAt: formatDate(new Date()) };
    }
    if (previouslyAccepted) return { ...item, status: "established" };
    if (stats.support >= LONG_TERM_SUPPORT_TARGET && recent.length >= LONG_TERM_RECENT_WINDOW && recentSupport >= LONG_TERM_RECENT_THRESHOLD) {
      return { ...item, status: "candidate" };
    }
    if (stats.refute >= LONG_TERM_RECENT_WINDOW && recent.length >= LONG_TERM_RECENT_WINDOW && recentRefute >= LONG_TERM_RECENT_THRESHOLD) {
      return { ...item, status: "rejected" };
    }
    return { ...item, status: item.status === "reopened" ? "reopened" : "observing" };
  }

  function acceptLongTermHypothesis(id){
    if (!id) return;
    const pool = loadLongTermPool();
    const next = pool.map(item => item.id === id
      ? { ...item, status: "established", acceptedAt: formatDate(new Date()), reopenedAt: "" }
      : item);
    saveLongTermPool(next);
    renderPreservingScroll();
    showToast("已加入长期经验，后续仍会继续被每周数据验证。");
  }

  function watchLongTermHypothesis(id){
    if (!id) return;
    const pool = loadLongTermPool();
    const next = pool.map(item => item.id === id
      ? { ...item, status: "observing", acceptedAt: "", reopenedAt: "" }
      : item);
    saveLongTermPool(next);
    renderPreservingScroll();
    showToast("已重新进入判断阶段。");
  }

  function getLongTermExperiences(pool = loadLongTermPool()){
    return pool.filter(item => item.status === "established");
  }

  function longTermStats(item){
    return (item.records || []).reduce((acc, record) => {
      if (record.result === "support") acc.support += 1;
      else if (record.result === "refute") acc.refute += 1;
      else acc.insufficient += 1;
      return acc;
    }, { support: 0, refute: 0, insufficient: 0 });
  }

  function longTermValidRecords(item){
    return (item.records || []).filter(record => record.result === "support" || record.result === "refute");
  }

  function latestLongTermRecord(item){
    const records = item.records || [];
    return records.length ? records[records.length - 1] : null;
  }

  function currentLongTermWeekKey(){
    return `${state.reportStartDate}_${state.reportEndDate}`;
  }

  function findChannelRow(rows, label){
    const target = asText(label).toLowerCase();
    return (rows || []).find(row => asText(row.label).toLowerCase() === target) || null;
  }

  function longTermStatusLabel(status){
    const labels = {
      observing: "观察中",
      candidate: "候选经验",
      established: "长期经验",
      reopened: "重新判断",
      rejected: "暂不成立"
    };
    return labels[status] || "观察中";
  }

  function longTermStatusTone(status){
    const tones = {
      observing: "local",
      candidate: "warning",
      established: "confirmed",
      reopened: "risk",
      rejected: "risk"
    };
    return tones[status] || "local";
  }

  function longTermResultLabel(result){
    const labels = {
      support: "支持",
      refute: "反证",
      insufficient: "数据不足"
    };
    return labels[result] || "数据不足";
  }

  function buildProgramPlaybookDraft(channel){
    const scope = channel === "站外数据" ? "站外" : channel;
    if (scope === "站外") {
      const offsite = deriveOffsite();
      const top = offsite.rows[0];
      return {
        reuse: `只展示站外来源结构。Top 来源：${top ? sanitizeOffsiteLabel(top.label) : "暂无"}，数量 ${top ? formatCompact(top.value) : "0"}。`,
        risk: "站外没有与具体内容链接映射时，不进入内容原因判断。"
      };
    }
    const derived = deriveForScope(scope);
    const isCommunity = scope === "社群";
    const metric = isCommunity ? "interaction" : "exposure";
    const topPosts = topPostsForScope(scope, metric, 10);
    const topSource = derived.channelRows[0];
    const topPost = topPosts[0];
    if (isCommunity) {
      return {
        reuse: `复盘入口是 Top 社群和 Top 帖。Top 来源：${topSource ? topSource.label : "暂无"}；Top 帖互动 ${topPost ? formatInteger(topPost.metrics.interaction) : "0"}。`,
        risk: "程序不能判断话题好在哪里，只能提示负责人补充话题、互动方式和实际负责人。"
      };
    }
    return {
      reuse: `复盘入口是 Top 来源和 Top 帖。Top 来源：${topSource ? topSource.label : "暂无"}；Top 内容：${topPost ? topPost.title : "暂无"}。`,
      risk: "程序只排序和聚合，不能判断创意、脚本、达人类型或平台机制原因。"
    };
  }

  function buildHypotheses(){
    const all = deriveFromPosts("非社群", posts.filter(post => post.normalizedChannelType !== "社群"));
    const community = deriveForScope("社群");
    const social = deriveForScope("社媒");
    const kol = deriveForScope("KOL");
    const quality = state.importAudit || buildBuiltinAudit();
    const recommendedMissing = getRecommendedMissing(quality);
    const communityTopFive = sum(community.topPosts.slice(0, 5), post => post.metrics.interaction);
    const gapRows = all.channelRows.map(row => ({
      ...row,
      gap: safeRate(row.interaction, all.currentTotals.interaction) - safeRate(row.exposure, all.currentTotals.exposure)
    })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
    const gap = gapRows[0];
    return [
      {
        id: "interaction-gap",
        title: "曝光贡献和互动贡献是否错位",
        phenomenon: gap ? `${gap.label} 的曝光贡献和互动贡献差异最大。` : "暂无贡献差。",
        hypothesis: "如果某渠道曝光占比高但互动占比低，需要复盘内容承接和互动动机。",
        validation: gap ? `曝光占比 ${formatPct(safeRate(gap.exposure, all.currentTotals.exposure))}，互动占比 ${formatPct(safeRate(gap.interaction, all.currentTotals.interaction))}，差值 ${formatPctDelta(gap.gap)}。` : "缺少可验证数据。",
        result: gap && Math.abs(gap.gap) >= 0.05 ? "支持：存在明显贡献错位。" : "未充分支持：贡献差未达到明显阈值。",
        channel: "总体",
        risk: "互动口径受平台机制影响，不能跨平台直接判定优劣。"
      },
      {
        id: "community-interaction",
        title: "社群互动是否集中在少数社群或帖子",
        phenomenon: community.channelRows[0] ? `${community.channelRows[0].label} 是社群互动最高来源。` : "社群暂无互动来源。",
        hypothesis: "如果社群 Top5 帖子贡献较高，应让负责人复盘具体话题和互动方式。",
        validation: `社群 Top5 帖子互动占比 ${formatPct(safeRate(communityTopFive, community.currentTotals.interaction))}；社群样本 ${formatInteger(community.poolPosts.length)} 帖。`,
        result: safeRate(communityTopFive, community.currentTotals.interaction) >= 0.5 ? "支持：社群互动集中在少数内容。" : "未充分支持：社群互动分布相对分散或数据不足。",
        channel: "社群",
        risk: "社群样本量较小，结论应围绕互动集中度保持保守。"
      },
      {
        id: "social-kol-top-posts",
        title: "社媒和 KOL 是否能从 Top 帖子提炼复用经验",
        phenomenon: `社媒样本 ${formatInteger(social.poolPosts.length)} 帖，KOL样本 ${formatInteger(kol.poolPosts.length)} 帖。`,
        hypothesis: "如果 Top 帖子在曝光或互动上形成明显贡献，可以由负责人总结内容结构并沉淀复用经验。",
        validation: `社媒 Top来源 ${social.channelRows[0] ? social.channelRows[0].label : "暂无"}；KOL Top来源 ${kol.channelRows[0] ? kol.channelRows[0].label : "暂无"}。`,
        result: social.topPosts.length || kol.topPosts.length ? "支持：已有 Top 帖子可进入人工复盘。" : "未支持：当前缺少 Top 帖子样本。",
        channel: "社媒/KOL",
        risk: "程序只排序和聚合，不替代负责人判断内容好在哪里。"
      },
      {
        id: "data-quality",
        title: "数据质量是否足以支撑本期结论",
        phenomenon: state.importMeta
          ? `导入文件 ${state.importMeta.fileName || "未命名文件"}，Excel明细行 ${formatInteger(quality.totalRows || 0)}，有效行数 ${formatInteger(quality.acceptedRows || 0)}，跳过行数 ${formatInteger((quality.totalRows || 0) - (quality.acceptedRows || 0))}。`
          : "当前为内置样例数据，只能用于界面演示；正式业务分析需要先导入本周 Excel。",
        hypothesis: "如果缺失必填字段过多，结论应标注数据风险。",
        validation: `重复链接 ${formatInteger(quality.duplicateLinks || 0)}；统计日期 ${quality.statDateRange || "暂无"}；发布时间 ${quality.publishDateRange || "暂无"}；建议字段缺失：负责人 ${formatInteger(recommendedMissing.owner || 0)}，帖子链接 ${formatInteger(recommendedMissing.link || 0)}。`,
        result: state.importMeta
          ? "支持：当前导入数据可用于生成草稿，但最终结论仍需负责人确认。"
          : "未支持：内置样例不能作为正式业务分析输入。",
        channel: "数据质量",
        risk: "缺失 发布时间 或 统计日期 的行不会被兜底纳入。"
      }
    ];
  }

  function renderHypothesisCard(item){
    const aiDraft = findAiDraftForHypothesis(item.id);
    const confirmKey = `${CONFIRM_PREFIX}.${BUILTIN_DATASET_TOKEN}.${item.id}`;
    const confirmed = loadText(confirmKey);
    return `<article class="chain-card" data-hypothesis-id="${escapeHtml(item.id)}">
      <div class="chain-head">
        <h4>${escapeHtml(item.title)}</h4>
        <div>${pill(confirmed ? "负责人确认" : (aiDraft ? "AI草稿" : "待补充"), confirmed ? "confirmed" : (aiDraft ? "ai" : "warning"))}</div>
      </div>
      <div class="chain-grid">
        ${renderChainStep("数据现象", item.phenomenon)}
        ${renderChainStep("假设", item.hypothesis)}
        ${renderChainStep("验证", item.validation)}
        ${renderChainStep("结果", item.result)}
        ${renderChainStep("风险", item.risk)}
      </div>
      <div class="draft-box">
        <div class="field-label">AI 草稿
          ${renderAiDraftPanel(aiDraft)}
        </div>
        <label class="field-label">负责人确认后的最终口径
          <textarea data-confirm-text placeholder="负责人确认后再写入最终汇报口径。">${escapeHtml(confirmed)}</textarea>
        </label>
        <div class="inline-actions">
          <button class="primary-button" type="button" data-action="confirm-hypothesis">确认口径</button>
        </div>
      </div>
    </article>`;
  }

  function renderAiDraftPanel(item){
    if (!item) return `<div class="ai-draft-panel is-empty">尚未导入对应 AI 草稿。</div>`;
    const sections = [
      { label: "结论", value: item.conclusion || item.draft || item.summary || "", tone: "is-primary" },
      { label: "验证", value: item.validation || item.evidence || item.evidenceMetrics || "" },
      { label: "风险", value: item.risk || item.risks || "" },
      { label: "负责人问题", value: item.ownerQuestion || item.question || "" }
    ].filter(section => asText(section.value));
    if (!sections.length) return `<div class="ai-draft-panel is-empty">AI 草稿缺少可展示内容。</div>`;
    return `<div class="ai-draft-panel">
      ${sections.map(section => `<section class="ai-draft-section ${section.tone || ""}">
        <strong>${escapeHtml(section.label)}</strong>
        <div class="ai-draft-copy">${renderAiDraftSectionText(section.value)}</div>
      </section>`).join("")}
    </div>`;
  }

  function renderAiDraftSectionText(value){
    const text = asText(value);
    const parts = text.split(/(?=支持证据：|反面证据：|缺失字段：|反面检验：)/g)
      .map(part => part.trim())
      .filter(Boolean);
    return (parts.length ? parts : [text]).map(part => `<p>${escapeHtml(part)}</p>`).join("");
  }

  function confirmHypothesis(card){
    if (!card) return;
    const id = card.dataset.hypothesisId;
    const text = card.querySelector("[data-confirm-text]")?.value || "";
    saveText(`${CONFIRM_PREFIX}.${BUILTIN_DATASET_TOKEN}.${id}`, text.trim());
    renderPreservingScroll();
    showToast(text.trim() ? "负责人确认口径已保存。" : "已清空该假设的确认口径。");
  }

  function renderTopPostsTable(topPosts, community){
    const rows = topPosts.map((post, index) => {
      const base = [
        `Top ${index + 1}`,
        escapeHtml(post.title),
        escapeHtml(post.channel),
        escapeHtml(post.owner || "未知"),
        escapeHtml(post.publishDate)
      ];
      if (community) {
        return [
          ...base,
          formatInteger(post.metrics.interaction),
          post.link ? `<a class="link-cell" href="${escapeHtml(post.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortDisplayUrl(post.link))}</a>` : "缺少链接"
        ];
      }
      return [
        ...base,
        formatInteger(post.metrics.exposure),
        formatInteger(post.metrics.interaction),
        formatPct(safeRate(post.metrics.interaction, post.metrics.exposure)),
        post.link ? `<a class="link-cell" href="${escapeHtml(post.link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(shortDisplayUrl(post.link))}</a>` : "缺少链接"
      ];
    });
    return community
      ? renderSimpleTable(["排名","帖子","社群","负责人","发布时间","互动","链接"], rows)
      : renderSimpleTable(["排名","帖子","渠道","负责人","发布时间","曝光","互动","互动率","链接"], rows);
  }

  function renderBarPanel(title, rows, metric, subtitle = "Top 10，当前复盘周期。"){
    const sorted = [...rows].sort((a, b) => asNumber(b[metric]) - asNumber(a[metric])).slice(0, 10);
    const max = Math.max(1, ...sorted.map(row => asNumber(row[metric])));
    return `<div class="table-panel panel">
      <div class="panel-title"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(subtitle)}</p></div>
      <div class="bar-list">
        ${sorted.map(row => {
          const value = asNumber(row[metric]);
          const width = value > 0 ? Math.max(2, value / max * 100).toFixed(1) : "0";
          return `<div class="bar-row">
            <div class="bar-name">${escapeHtml(row.label)}</div>
            <div class="bar-track"><span class="bar-fill" style="width:${width}%"></span></div>
            <div class="bar-value">${formatCompact(value)}</div>
          </div>`;
        }).join("") || renderEmpty("暂无数据")}
      </div>
    </div>`;
  }

  function renderFunnelChart(rows, title){
    if (!Array.isArray(rows) || !rows.length) return renderEmpty("暂无数据");
    const palette = ["#3b82f6", "#0ea5e9", "#14b8a6", "#22c55e", "#84cc16", "#f59e0b"];
    const normalizedRows = rows.map(row => ({
      label: row?.label || "未命名",
      exposure: asNumber(row?.exposure),
      interactionRate: asNumber(row?.interactionRate)
    }));
    const maxExposure = Math.max(1, ...normalizedRows.map(row => row.exposure));
    return `<div class="table-panel panel funnel-chart">
      <div class="panel-title"><h3 class="funnel-title">${escapeHtml(title || "漏斗图")}</h3></div>
      <div class="funnel-body">
        ${normalizedRows.map((row, index) => {
          const width = Math.max(8, row.exposure / maxExposure * 100).toFixed(1);
          return `<div class="funnel-layer" style="width:${width}%;background:${palette[index % palette.length]}">
            <span class="funnel-layer-label">${escapeHtml(row.label)}</span>
            <span class="funnel-layer-metrics">
              <span>${formatCompact(row.exposure)}</span>
              <span>${formatPct(row.interactionRate)}</span>
            </span>
          </div>`;
        }).join("")}
      </div>
    </div>`;
  }

  function renderLineChart(lifecycleRows, isCommunity){
    if (!Array.isArray(lifecycleRows) || !lifecycleRows.length) return renderEmpty("暂无数据");
    const width = 600;
    const height = 280;
    const margin = { top: 24, right: 24, bottom: 54, left: 64 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const series = [
      { key: "exposure", label: "曝光", color: "#3b82f6", show: !isCommunity },
      { key: "interaction", label: "互动", color: "#22c55e", show: true }
    ].filter(item => item.show);
    if (!series.length) return renderEmpty("暂无数据");
    const maxValue = Math.max(
      1,
      ...lifecycleRows.flatMap(row => series.map(item => asNumber(row?.[item.key])))
    );
    const tickCount = 5;
    const xOf = index => {
      if (lifecycleRows.length === 1) return margin.left + plotWidth / 2;
      return margin.left + index * (plotWidth / (lifecycleRows.length - 1));
    };
    const yOf = value => margin.top + plotHeight - (asNumber(value) / maxValue) * plotHeight;

    const grid = Array.from({ length: tickCount + 1 }, (_, index) => {
      const value = maxValue * (index / tickCount);
      const y = yOf(value);
      return `<g>
        <line x1="${margin.left}" y1="${y.toFixed(2)}" x2="${(margin.left + plotWidth).toFixed(2)}" y2="${y.toFixed(2)}" stroke="#e2e8f0" stroke-width="1" />
        <text x="${margin.left - 8}" y="${(y + 4).toFixed(2)}" text-anchor="end" fill="#64748b" font-size="11">${escapeHtml(formatCompact(value))}</text>
      </g>`;
    }).join("");

    const xLabels = lifecycleRows.map((row, index) => {
      const x = xOf(index);
      return `<text x="${x.toFixed(2)}" y="${height - 18}" text-anchor="middle" fill="#475569" font-size="11">${escapeHtml(row?.label || `#${index + 1}`)}</text>`;
    }).join("");

    const seriesSvg = series.map((item, seriesIndex) => {
      const points = lifecycleRows.map((row, index) => `${xOf(index).toFixed(2)},${yOf(row?.[item.key]).toFixed(2)}`).join(" ");
      const markers = lifecycleRows.map((row, index) => {
        const x = xOf(index);
        const y = yOf(row?.[item.key]);
        const value = asNumber(row?.[item.key]);
        const labelOffset = series.length > 1 ? (seriesIndex === 0 ? -10 : 14) : -10;
        return `<g>
          <circle cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="3.5" fill="${item.color}" />
          <text x="${x.toFixed(2)}" y="${(y + labelOffset).toFixed(2)}" text-anchor="middle" fill="${item.color}" font-size="10">${escapeHtml(formatCompact(value))}</text>
        </g>`;
      }).join("");
      return `<g>
        <polyline points="${points}" fill="none" stroke="${item.color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
        ${markers}
      </g>`;
    }).join("");

    const legend = series.map((item, index) => {
      const x = margin.left + index * 110;
      const y = 12;
      return `<g>
        <line x1="${x}" y1="${y}" x2="${x + 20}" y2="${y}" stroke="${item.color}" stroke-width="3" stroke-linecap="round" />
        <text x="${x + 26}" y="${y + 4}" fill="#334155" font-size="12">${escapeHtml(item.label)}</text>
      </g>`;
    }).join("");

    return `<svg class="line-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势折线图">
      ${legend}
      ${grid}
      <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#94a3b8" stroke-width="1.2" />
      <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#94a3b8" stroke-width="1.2" />
      ${seriesSvg}
      ${xLabels}
    </svg>`;
  }

  function renderMetricCard(card){
    return `<article class="metric-card">
      <div class="metric-label">${escapeHtml(card.label)}</div>
      <div class="metric-value">${escapeHtml(card.value)}</div>
      <div class="metric-foot">${escapeHtml(card.foot || "")}</div>
    </article>`;
  }

  function renderQualityCard(label, value, foot){
    return `<article class="quality-card"><strong>${escapeHtml(label)}</strong><p>${value}</p><p>${escapeHtml(foot || "")}</p></article>`;
  }

  function renderSummaryItem(title, body){
    return `<div class="summary-item"><strong>${escapeHtml(title)}</strong><p>${body}</p></div>`;
  }

  function renderChainStep(title, body){
    return `<div class="chain-step"><strong>${escapeHtml(title)}</strong><p>${escapeHtml(body)}</p></div>`;
  }

  function renderSimpleTable(headers, rows){
    const body = rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join("")}</tr>`).join("") : `<tr><td colspan="${headers.length}">暂无数据</td></tr>`;
    return `<div class="table-wrap"><table class="data-table"><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderEmpty(text){
    return `<div class="empty-state">${escapeHtml(text)}</div>`;
  }

  function pill(text, tone = ""){
    return `<span class="state-pill ${tone ? `is-${tone}` : ""}">${escapeHtml(text)}</span>`;
  }

  function preprocessPosts(rawPosts){
    return rawPosts.map(post => {
      const snapshots = [...(post.snapshots || [])].map(snapshot => ({
        ...snapshot,
        capturedAt: toDateString(snapshot.capturedAt),
        dateObj: parseDate(toDateString(snapshot.capturedAt)),
        exposure: asNumber(snapshot.exposure),
        likes: asNumber(snapshot.likes),
        comments: asNumber(snapshot.comments),
        shares: asNumber(snapshot.shares),
        saves: asNumber(snapshot.saves),
        interaction: metricInteraction(snapshot)
      })).filter(snapshot => snapshot.capturedAt && snapshot.dateObj && !Number.isNaN(snapshot.dateObj.getTime()))
        .sort((a, b) => a.dateObj - b.dateObj);
      const publishDate = toDateString(post.publishDate);
      return {
        ...post,
        publishDate,
        publishDateObj: parseDate(publishDate),
        snapshots,
        displayChannelName: displayChannelNameForPost(post),
        normalizedChannelType: normalizeChannelType(post.channelType, post.channelName || post.platform),
        normalizedTopic: normalizeDimension(post.contentTopic),
        normalizedFormat: normalizeContentFormat(post.contentFormat)
      };
    }).filter(post => post.publishDate && post.publishDateObj && !Number.isNaN(post.publishDateObj.getTime()));
  }

  function filterPostsByScope(items, scope){
    if (scope === "all") return items;
    return items.filter(post => post.normalizedChannelType === scope);
  }

  function buildChannelRows(items, totals, start = reviewWindow.start, end = reviewWindow.end){
    const groups = new Map();
    items.forEach(post => {
      const label = post.displayChannelName || "未知渠道";
      if (!groups.has(label)) groups.set(label, { label, exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0, posts: 0 });
      const row = groups.get(label);
      const metrics = diffMetrics(post, start, end);
      row.exposure += metrics.exposure;
      row.interaction += metrics.interaction;
      row.likes += metrics.likes;
      row.comments += metrics.comments;
      row.shares += metrics.shares;
      row.saves += metrics.saves;
      if (metrics.exposure > 0 || metrics.interaction > 0) row.posts += 1;
    });
    return Array.from(groups.values()).map(row => ({
      ...row,
      exposureShare: safeRate(row.exposure, totals.exposure),
      interactionShare: safeRate(row.interaction, totals.interaction)
    })).sort((a, b) => (b.exposure || b.interaction) - (a.exposure || a.interaction));
  }

  function topPostsForScope(scope, metric, limit){
    return topPostsFromPool(deriveForScope(scope).poolPosts, metric, limit);
  }

  function topPostsFromPool(pool, metric, limit){
    return pool.map(post => {
      const metrics = diffMetrics(post, reviewWindow.start, reviewWindow.end);
      return {
        id: post.id || `post-${hashText(post.link || post.title || post.publishDate)}`,
        title: post.title || contentLabel(post),
        link: post.link || "",
        owner: post.owner || "未知",
        channel: post.displayChannelName || post.channelName || post.platform || "未知渠道",
        channelType: post.normalizedChannelType,
        publishDate: post.publishDate,
        metrics
      };
    }).filter(post => post.metrics.exposure > 0 || post.metrics.interaction > 0)
      .sort((a, b) => asNumber(b.metrics[metric]) - asNumber(a.metrics[metric]))
      .slice(0, limit);
  }

  function sumPostsForRange(items, start, end){
    return items.reduce((acc, post) => {
      const diff = diffMetrics(post, start, end);
      acc.exposure += diff.exposure;
      acc.interaction += diff.interaction;
      acc.likes += diff.likes;
      acc.comments += diff.comments;
      acc.shares += diff.shares;
      acc.saves += diff.saves;
      return acc;
    }, { exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 });
  }

  function countPostsForRange(items, start, end){
    return items.reduce((count, post) => {
      const diff = diffMetrics(post, start, end);
      return count + ((diff.exposure > 0 || diff.interaction > 0) ? 1 : 0);
    }, 0);
  }

  function diffMetrics(post, start, end){
    const endCum = cumulativeAt(post, end);
    const beforeCum = cumulativeAt(post, addDays(start, -1));
    return {
      exposure: Math.max(0, endCum.exposure - beforeCum.exposure),
      interaction: Math.max(0, endCum.interaction - beforeCum.interaction),
      likes: Math.max(0, endCum.likes - beforeCum.likes),
      comments: Math.max(0, endCum.comments - beforeCum.comments),
      shares: Math.max(0, endCum.shares - beforeCum.shares),
      saves: Math.max(0, endCum.saves - beforeCum.saves)
    };
  }

  function cumulativeAt(post, date){
    const snapshots = post.snapshots || [];
    let selected = null;
    for (const snapshot of snapshots) {
      if (snapshot.dateObj <= date) selected = snapshot;
      else break;
    }
    if (!selected) return { exposure: 0, interaction: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
    return {
      exposure: asNumber(selected.exposure),
      interaction: asNumber(selected.interaction),
      likes: asNumber(selected.likes),
      comments: asNumber(selected.comments),
      shares: asNumber(selected.shares),
      saves: asNumber(selected.saves)
    };
  }

  async function readRowsFromFile(file){
    const ext = file.name.split(".").pop().toLowerCase();
    if (window.XLSX && ext !== "csv") return readRowsWithXlsx(file);
    if (ext === "csv") return readRowsFromCsvText(await file.text(), file.name);
    throw new Error("Excel 解析库加载失败，请联网后刷新页面重试。");
  }

  async function readRowsWithXlsx(file){
    const buffer = await file.arrayBuffer();
    const workbook = window.XLSX.read(buffer, { type: "array", cellDates: true });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error("没有识别到工作表。");
    const worksheet = workbook.Sheets[sheetName];
    const ref = worksheet && worksheet["!ref"];
    const range = ref ? window.XLSX.utils.decode_range(ref) : null;
    const rows = window.XLSX.utils.sheet_to_json(worksheet, { defval: null, raw: true });
    applyWorksheetHyperlinks(worksheet, rows);
    return {
      rows,
      sheetName,
      totalRows: range ? Math.max(0, range.e.r - range.s.r) : rows.length,
      columnCount: range ? Math.max(0, range.e.c - range.s.c + 1) : 0
    };
  }

  function applyWorksheetHyperlinks(worksheet, rows){
    const ref = worksheet && worksheet["!ref"];
    if (!ref || !rows.length || !window.XLSX) return;
    const range = window.XLSX.utils.decode_range(ref);
    const headers = [];
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const headerCell = worksheet[window.XLSX.utils.encode_cell({ r: range.s.r, c: col })];
      headers[col] = asText(headerCell && headerCell.v);
    }
    rows.forEach((row, rowIndex) => {
      const sheetRow = range.s.r + 1 + rowIndex;
      headers.forEach((header, col) => {
        if (!header) return;
        const cell = worksheet[window.XLSX.utils.encode_cell({ r: sheetRow, c: col })];
        const link = extractCellHyperlink(cell);
        if (link) row[header] = link;
      });
    });
  }

  function extractCellHyperlink(cell){
    if (!cell) return "";
    const direct = cell.l && (cell.l.Target || cell.l.target);
    if (direct) return asText(direct);
    const formula = asText(cell.f);
    const match = formula.match(/^HYPERLINK\(\s*"([^"]+)"/i);
    return match ? match[1] : "";
  }

  function readRowsFromCsvText(text, name){
    const lines = String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
    if (!lines.length) throw new Error("CSV 文件为空。");
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map(line => {
      const cells = parseCsvLine(line);
      const row = {};
      headers.forEach((header, index) => { row[header] = cells[index] ?? null; });
      return row;
    });
    return { rows, sheetName: name || "CSV", totalRows: rows.length, columnCount: headers.length };
  }

  function parseCsvLine(line){
    const out = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === "\"") {
        if (quoted && line[i + 1] === "\"") {
          current += "\"";
          i += 1;
        } else {
          quoted = !quoted;
        }
      } else if (ch === "," && !quoted) {
        out.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    out.push(current);
    return out;
  }

  function buildSourceFromParsedRows(parsed, file){
    const result = buildPostsFromImportedRows(parsed.rows || []);
    const latestStat = latestStatDate(result.posts);
    const reviewRange = latestStat ? latestCompleteNaturalWeek(latestStat) : parseReviewWindow(initialSource.reviewWeek && initialSource.reviewWeek.dateRange);
    const importedSource = {
      generatedAt: formatDate(new Date()),
      currentSample: reviewRange ? `${reviewRange.end.getFullYear()}-W${weekOfYear(reviewRange.end)}` : `import-${formatDate(new Date())}`,
      reviewWeek: latestStat ? {
        weekIndex: weekOfYear(reviewRange.end),
        dateRange: `${formatDate(reviewRange.start)} ~ ${formatDate(reviewRange.end)}`,
        publishWindow: `${formatDate(new Date(reviewRange.end.getFullYear(), reviewRange.end.getMonth(), 1))} ~ ${formatDate(reviewRange.end)} 发布帖子`
      } : cloneData(initialSource.reviewWeek),
      posts: result.posts,
      importAudit: {
        ...result.audit,
        totalRows: parsed.totalRows || result.audit.totalRows
      },
      importMeta: {
        fileName: file.name,
        fileSize: file.size,
        sheetName: parsed.sheetName,
        importedAt: formatDate(new Date())
      }
    };
    return {
      fileName: file.name,
      sheetName: parsed.sheetName,
      columnCount: parsed.columnCount,
      source: importedSource,
      audit: importedSource.importAudit
    };
  }

  function buildPostsFromImportedRows(rows){
    const audit = createEmptyAudit(rows.length);
    const groups = new Map();
    const seenLinks = new Set();
    rows.forEach((row, rowIndex) => {
      const normalized = normalizeImportedRow(row, rowIndex, audit);
      if (!normalized) return;
      audit.acceptedRows += 1;
      audit.channelDistribution[normalized.channelType] = (audit.channelDistribution[normalized.channelType] || 0) + 1;
      if (normalized.exposure > 0) audit.metricObservedRows.exposure += 1;
      if (normalized.interaction > 0) audit.metricObservedRows.interaction += 1;
      if (normalized.link) {
        if (seenLinks.has(normalized.link)) audit.duplicateLinks += 1;
        seenLinks.add(normalized.link);
      }
      audit.statDates.push(normalized.statDate);
      audit.publishDates.push(normalized.publishDate);
      if (!groups.has(normalized.postKey)) {
        groups.set(normalized.postKey, {
          id: `imp-${hashText(normalized.postKey)}`,
          link: normalized.link,
          title: normalized.title,
          platform: normalized.platform,
          channelType: normalized.channelType,
          channelName: normalized.channelName,
          owner: normalized.owner,
          contentFormat: normalized.contentFormat,
          contentTopic: normalized.contentTopic,
          featuredQuality: normalized.featuredQuality,
          productLine1: normalized.productLine1,
          productLine2: normalized.productLine2,
          collabRequirement: normalized.collabRequirement,
          funnelStage: normalized.funnelStage,
          contentSource: normalized.contentSource,
          viewers: normalized.viewers,
          skuCount: normalized.skuCount,
          publishDate: normalized.publishDate,
          project: normalized.project,
          projectKeys: new Set(),
          snapshotsByDate: new Map()
        });
      }
      const group = groups.get(normalized.postKey);
      if (normalized.projectKey) group.projectKeys.add(normalized.projectKey);
      const existing = group.snapshotsByDate.get(normalized.statDate);
      if (!existing) {
        group.snapshotsByDate.set(normalized.statDate, {
          capturedAt: normalized.statDate,
          exposure: normalized.exposure,
          likes: normalized.likes,
          comments: normalized.comments,
          shares: normalized.shares,
          saves: normalized.saves
        });
      } else {
        existing.exposure = Math.max(existing.exposure, normalized.exposure);
        existing.likes = Math.max(existing.likes, normalized.likes);
        existing.comments = Math.max(existing.comments, normalized.comments);
        existing.shares = Math.max(existing.shares, normalized.shares);
        existing.saves = Math.max(existing.saves, normalized.saves);
      }
    });
    const postsFromRows = Array.from(groups.values()).map(group => {
      const snapshots = Array.from(group.snapshotsByDate.values())
        .sort((a, b) => parseDate(a.capturedAt) - parseDate(b.capturedAt))
        .map((snapshot, index) => ({ ...snapshot, weekIndex: index + 1 }));
      return {
        id: group.id,
        link: group.link,
        title: group.title,
        platform: group.platform,
        channelType: group.channelType,
        channelName: group.channelName,
        owner: group.owner,
        contentFormat: group.contentFormat,
        contentTopic: group.contentTopic,
        featuredQuality: group.featuredQuality,
        productLine1: group.productLine1,
        productLine2: group.productLine2,
        collabRequirement: group.collabRequirement,
        funnelStage: group.funnelStage,
        contentSource: group.contentSource,
        viewers: group.viewers,
        skuCount: group.skuCount,
        publishDate: group.publishDate,
        project: group.project,
        projectKey: [...group.projectKeys].filter(Boolean).join("; "),
        projectLinks: Math.max(1, group.projectKeys.size || 1),
        snapshots
      };
    }).filter(post => post.snapshots.length);
    audit.statDateRange = rangeText(audit.statDates);
    audit.publishDateRange = rangeText(audit.publishDates);
    delete audit.statDates;
    delete audit.publishDates;
    return { posts: postsFromRows, audit };
  }

  function createEmptyAudit(totalRows){
    return {
      totalRows,
      acceptedRows: 0,
      missingRequired: { statDate: 0, publishDate: 0, channelType: 0, channelName: 0 },
      missingRecommended: { owner: 0, link: 0 },
      duplicateLinks: 0,
      channelDistribution: {},
      metricObservedRows: { exposure: 0, interaction: 0 },
      statDates: [],
      publishDates: [],
      statDateRange: "",
      publishDateRange: ""
    };
  }

  function normalizeImportedRow(row, rowIndex, audit){
    const statDate = toDateString(getImportedValue(row, ["统计日期"]));
    const publishDate = toDateString(getImportedValue(row, ["发布时间"]));
    const rawType = asText(getImportedValue(row, ["渠道类型", "渠道大类", "类型"]));
    const rawName = asText(getImportedValue(row, ["渠道名称", "平台", "平台名称", "渠道平台", "渠道"]));
    const ownerRaw = asText(getImportedValue(row, ["负责人", "负责人员", "Owner", "owner"]));
    const link = normalizePostUrl(getImportedValue(row, [
      "帖子链接","帖子URL","帖子url","链接","URL","url","链接地址","内容链接","原文链接","视频链接","视频URL","作品链接","作品URL","素材链接","笔记链接","笔记URL","Post URL","PostURL","Post Link","post_url","post link"
    ]));
    const missing = [];
    if (!statDate) missing.push("statDate");
    if (!publishDate) missing.push("publishDate");
    if (!rawType) missing.push("channelType");
    if (!rawName) missing.push("channelName");
    if (missing.length) {
      missing.forEach(key => { audit.missingRequired[key] += 1; });
      return null;
    }
    if (!ownerRaw) audit.missingRecommended.owner += 1;
    if (!link) audit.missingRecommended.link += 1;
    const channelType = normalizeChannelType(rawType, rawName);
    const channelName = channelType === "社群" ? rawName : rawName;
    const platform = (channelType === "社群" ? rawType : rawName).toLowerCase();
    const project = asText(getImportedValue(row, ["项目"]));
    const topic = asText(getImportedValue(row, ["内容主题"]));
    const format = normalizeContentFormat(getImportedValue(row, ["内容形式"]));
    const msku = asText(getImportedValue(row, ["MSKU", "SKU"]));
    const productLine1 = asText(getImportedValue(row, ["一级品线", "产品线", "品类"])) || null;
    const productLine2 = asText(getImportedValue(row, ["二级品线", "子品类"])) || null;
    const collabRequirement = asText(getImportedValue(row, ["合作要求", "合作方式", "内容要求"])) || null;
    const funnelStage = asText(getImportedValue(row, ["营销漏斗层级", "漏斗层级", "漏斗阶段"])) || null;
    const contentSource = asText(getImportedValue(row, ["内容来源", "来源"])) || null;
    const viewers = asNumber(getImportedValue(row, ["浏览人数", "观看人数", "浏览数"]));
    const skuCount = asNumber(getImportedValue(row, ["SKU数量", "SKU数"]));
    const title = [project, topic].filter(text => text && text !== "未知").join(" · ") || `${channelName} 内容`;
    const owner = ownerRaw || "未知";
    const postKey = link || [channelType, channelName, publishDate, title, rowIndex].map(value => asText(value)).join("__");
    const likes = asNumber(getImportedValue(row, ["点赞数"]));
    const comments = asNumber(getImportedValue(row, ["评论数"]));
    const shares = asNumber(getImportedValue(row, ["转发数", "分享数"]));
    const saves = asNumber(getImportedValue(row, ["收藏数"]));
    const interaction = Math.max(asNumber(getImportedValue(row, ["互动量"])), likes + comments + shares + saves);
    return {
      postKey,
      link,
      title,
      platform,
      channelType,
      channelName,
      owner,
      contentFormat: format,
      contentTopic: topic || "未知",
      featuredQuality: asText(getImportedValue(row, ["是否为优质内容"])) || "未知",
      publishDate,
      statDate,
      projectKey: [project, msku].filter(Boolean).join("::"),
      project: project || null,
      productLine1,
      productLine2,
      collabRequirement,
      funnelStage,
      contentSource,
      viewers: Number.isFinite(viewers) ? viewers : null,
      skuCount: Number.isFinite(skuCount) ? skuCount : null,
      exposure: channelType === "社群" ? 0 : asNumber(getImportedValue(row, ["曝光量", "曝光"])),
      likes,
      comments,
      shares,
      saves,
      interaction
    };
  }

  function getImportedValue(row, aliases){
    const keyMap = getNormalizedHeaderMap(row);
    for (const alias of aliases) {
      const key = keyMap.get(normalizeHeader(alias));
      if (key) return row[key];
    }
    return null;
  }

  function getNormalizedHeaderMap(row){
    if (row.__normalizedHeaderMap) return row.__normalizedHeaderMap;
    const map = new Map();
    Object.keys(row).forEach(key => map.set(normalizeHeader(key), key));
    row.__normalizedHeaderMap = map;
    return map;
  }

  function normalizeHeader(text){
    return String(text || "").replace(/\s+/g, "").toLowerCase();
  }

  function buildBuiltinAudit(){
    const audit = createEmptyAudit((source.posts || []).length);
    audit.acceptedRows = (source.posts || []).length;
    posts.forEach(post => {
      audit.channelDistribution[post.normalizedChannelType] = (audit.channelDistribution[post.normalizedChannelType] || 0) + 1;
      audit.publishDates.push(post.publishDate);
      (post.snapshots || []).forEach(snapshot => audit.statDates.push(snapshot.capturedAt));
    });
    audit.statDateRange = rangeText(audit.statDates);
    audit.publishDateRange = rangeText(audit.publishDates);
    delete audit.statDates;
    delete audit.publishDates;
    return audit;
  }

  function buildAnalysisPackage(){
    const all = deriveForScope("all");
    const nonCommunity = deriveFromPosts("非社群", posts.filter(post => post.normalizedChannelType !== "社群"));
    const community = deriveForScope("社群");
    const businessReady = Boolean(state.importMeta);
    return {
      version: APP_VERSION,
      generatedAt: formatDate(new Date()),
      businessReady,
      boundary: "AI 只能生成草稿和待确认问题，最终口径必须由负责人确认。",
      analysisRules: [
        "如果 businessReady 为 false，请停止分析并提示用户先导入本周 Excel。",
        "report 是表现统计窗口，batch 是内容发布时间样本池，两者不是二选一。",
        "lifecycleWeek 是生命周期样本周：只纳入该自然周发布的帖子，用于观察这些帖子发布后第1-4周表现。",
        "社群没有曝光和互动率口径，只能按互动、帖子、社群名称和负责人总结分析。",
        "Top5 曝光占比低于 30% 时，不得写 Top 内容带动整体，只能写具备复盘价值。",
        "不得使用资源购买类表达；若来源名含相关词，只能作为来源名称引用，不得发散分析。",
        "不要推断账号粉丝量、完播率、转化、内容文本、活动背景或置顶等数据包未提供的信息。",
        "hypothesisDrafts.hypothesisId 必须使用 hypotheses 中已有 id，不得改写为 H1/H2。"
      ],
      periods: {
        report: { start: state.reportStartDate, end: state.reportEndDate, role: "表现统计窗口：本期曝光、互动等表现均按此窗口计算。" },
        batch: { start: state.batchStartDate, end: state.batchEndDate, role: "内容样本池：仅纳入此发布时间范围内的内容。" },
        lifecycleWeek: { start: state.lifecycleStartDate, end: state.lifecycleEndDate, role: "生命周期样本周：只纳入此自然周发布的帖子，用于看发布后第1-4周表现。" }
      },
      dataSource: buildAnalysisDataSource(),
      facts: {
        batchPostCount: all.poolPosts.length,
        reportMetrics: {
          exposure: all.currentTotals.exposure,
          interaction: all.currentTotals.interaction,
          interactionRate: all.interactionRate,
          interactionBreakdown: interactionBreakdown(all.currentTotals)
        },
        nonCommunityChannels: compactChannelRows(nonCommunity.channelRows, true),
        communityInteraction: {
          metricPolicy: communityMetricPolicy(),
          posts: community.poolPosts.length,
          interaction: community.currentTotals.interaction,
          topGroups: compactChannelRows(community.channelRows, false)
        },
        projectBreakdown: deriveProjectRows(all.poolPosts),
        productLineBreakdown: deriveProductLineRows(all.poolPosts),
        funnelDistribution: deriveFunnelDistribution(all.poolPosts),
        collabBreakdown: deriveCollabRequirementBreakdown(all.poolPosts)
      },
      programConclusions: buildProgramConclusionsForPackage(),
      hypotheses: buildHypotheses(),
      longTermHypotheses: buildLongTermHypothesisPackage(),
      channelSummaries: ["社群", "社媒", "KOL"].map(buildChannelAnalysisSummary),
      offsite: buildOffsiteAnalysisSummary(),
      inputLimitations: [
        "数据包不包含视频内容文本、完播率、观看时长、账号粉丝量、转化、GMV 或花费字段。",
        "负责人为空的内容只能显示为未知，不能做责任归因；需要负责人补充后才能进入最终口径。",
        "社媒部分 Top 内容如果 link 为空，只能做表现结构判断，不能分析具体内容好在哪里。",
        "站外数据仅作为展示和背景信息，不进入内容原因判断。"
      ]
    };
  }

  function buildProgramConclusionsForPackage(){
    const all = deriveForScope("all");
    const community = deriveForScope("社群");
    const social = deriveForScope("社媒");
    const kol = deriveForScope("KOL");
    const offsite = deriveOffsite();
    return {
      role: "以下为程序自动聚合、排序和阈值规则可得出的结论，AI 不需要复述，只能基于这些事实提出更深层假设和待确认问题。",
      overview: buildOverviewHighlights({ all, community, social, kol, offsite }),
      channels: ["社群", "社媒", "KOL"].map(scope => {
        const derived = deriveForScope(scope);
        const metric = scope === "社群" ? "interaction" : "exposure";
        return {
          channel: scope,
          conclusions: buildChannelProgramConclusions(scope, derived, topPostsForScope(scope, metric, 10))
        };
      }),
      playbookSeeds: ["社群", "社媒", "KOL", "站外数据"].map(channel => ({
        channel,
        ...buildProgramPlaybookDraft(channel)
      }))
    };
  }

  function buildLongTermHypothesisPackage(){
    return loadLongTermPool().map(item => {
      const stats = longTermStats(item);
      const latest = latestLongTermRecord(item);
      return {
        id: item.id,
        title: item.title,
        channel: item.channel,
        status: item.status,
        statusLabel: longTermStatusLabel(item.status),
        supportCount: stats.support,
        refuteCount: stats.refute,
        insufficientCount: stats.insufficient,
        supportTarget: LONG_TERM_SUPPORT_TARGET,
        latestRecord: latest ? {
          reportStartDate: latest.reportStartDate,
          reportEndDate: latest.reportEndDate,
          result: latest.result,
          evidence: latest.evidence,
          counterEvidence: latest.counterEvidence || ""
        } : null,
        boundary: "AI 只能补充本周支持点、反证和待确认问题；是否加入长期经验由负责人确认。"
      };
    });
  }

  function buildAnalysisDataSource(){
    if (!state.importMeta) {
      return {
        sourceType: "builtin-demo",
        label: "内置样例数据",
        businessReady: false,
        message: "当前数据只用于界面演示，不得用于正式业务分析。请先导入本周 Excel 后重新生成分析包。",
        quality: null
      };
    }
    const audit = state.importAudit || createEmptyAudit(0);
    const recommendedMissing = getRecommendedMissing(audit);
    return {
      sourceType: "imported-file",
      label: "用户导入Excel",
      businessReady: true,
      fileName: state.importMeta.fileName || "",
      sheetName: state.importMeta.sheetName || "",
      importedAt: state.importMeta.importedAt || "",
      quality: {
        totalRows: audit.totalRows || 0,
        acceptedRows: audit.acceptedRows || 0,
        skippedRows: Math.max(0, (audit.totalRows || 0) - (audit.acceptedRows || 0)),
        missingRequired: cloneData(audit.missingRequired || {}),
        missingRecommended: cloneData(recommendedMissing),
        duplicateLinks: audit.duplicateLinks || 0,
        channelDistribution: cloneData(audit.channelDistribution || {}),
        metricObservedRows: cloneData(audit.metricObservedRows || audit.metricCompleteness || {}),
        statDateRange: audit.statDateRange || "",
        publishDateRange: audit.publishDateRange || "",
        note: "metricObservedRows 表示指标有值行数，不表示缺失为 0；missingRecommended 不会阻断导入，但会影响负责人归因和原帖复盘。"
      }
    };
  }

  function buildChannelAnalysisSummary(scope){
    const derived = deriveForScope(scope);
    if (scope === "社群") {
      return {
        channel: scope,
        metricPolicy: communityMetricPolicy(),
        posts: derived.poolPosts.length,
        interaction: derived.currentTotals.interaction,
        lifecycleMethodology: buildLifecycleMethodology(derived.lifecyclePoolPosts.length, true),
        lifecycleRows: compactLifecycleRows(buildLifecycleRows(derived.lifecyclePoolPosts, true), true),
        topGroups: compactChannelRows(derived.channelRows, false),
        topPosts: compactTopPosts(derived.topPosts.slice(0, 10), false)
      };
    }
    return {
      channel: scope,
      metricPolicy: { exposureAvailable: true, interactionRateAvailable: true },
      posts: derived.poolPosts.length,
      exposure: derived.currentTotals.exposure,
      interaction: derived.currentTotals.interaction,
      interactionRate: derived.interactionRate,
      lifecycleMethodology: buildLifecycleMethodology(derived.lifecyclePoolPosts.length, false),
      lifecycleRows: compactLifecycleRows(buildLifecycleRows(derived.lifecyclePoolPosts, false), false),
      topSources: compactChannelRows(derived.channelRows.slice(0, 5), true),
      topPosts: compactTopPosts(derived.topPosts.slice(0, 10), true)
    };
  }

  function compactLifecycleRows(rows, isCommunity){
    return rows.map(row => {
      const base = {
        label: row.label,
        window: row.window,
        posts: row.posts,
        interaction: row.interaction,
        interactionShare: row.interactionShare,
        avgInteraction: row.avgInteraction,
        diagnosis: row.diagnosis
      };
      if (isCommunity) return base;
      return {
        ...base,
        exposure: row.exposure,
        exposureShare: row.exposureShare,
        interactionRate: row.interactionRate,
        contributionGap: row.gap
      };
    });
  }

  function compactChannelRows(rows, exposureAvailable){
    return rows.map(row => {
      const base = {
        label: row.label,
        posts: row.posts || 0,
        interaction: row.interaction || 0,
        interactionShare: row.interactionShare || 0,
        interactionBreakdown: interactionBreakdown(row)
      };
      if (!exposureAvailable) return base;
      return {
        ...base,
        exposure: row.exposure || 0,
        exposureShare: row.exposureShare || 0
      };
    });
  }

  function compactTopPosts(topPosts, exposureAvailable){
    return topPosts.map(post => {
      const base = {
        id: post.id,
        title: post.title,
        link: post.link,
        owner: post.owner || "未知",
        publishDate: post.publishDate
      };
      if (!exposureAvailable) {
        return {
          ...base,
          group: post.channel,
          metrics: {
            interaction: post.metrics.interaction,
            ...interactionBreakdown(post.metrics)
          }
        };
      }
      return {
        ...base,
        channel: post.channel,
        metrics: {
          exposure: post.metrics.exposure,
          interaction: post.metrics.interaction,
          ...interactionBreakdown(post.metrics),
          interactionRate: safeRate(post.metrics.interaction, post.metrics.exposure)
        }
      };
    });
  }

  function interactionBreakdown(metrics){
    const likes = asNumber(metrics && metrics.likes);
    const comments = asNumber(metrics && metrics.comments);
    const shares = asNumber(metrics && metrics.shares);
    const saves = asNumber(metrics && metrics.saves);
    const total = asNumber(metrics && metrics.interaction);
    const knownTotal = likes + comments + shares + saves;
    const other = Math.max(0, total - knownTotal);
    return {
      total,
      likes,
      comments,
      shares,
      saves,
      other,
      likesShare: safeRate(likes, total),
      commentsShare: safeRate(comments, total),
      sharesShare: safeRate(shares, total),
      savesShare: safeRate(saves, total),
      otherShare: safeRate(other, total)
    };
  }

  function communityMetricPolicy(){
    return {
      exposureAvailable: false,
      interactionRateAvailable: false,
      rule: "社群没有曝光口径，不得写曝光为0或互动率为0；只按互动量、Top帖子、社群名称和负责人总结复盘。"
    };
  }

  function buildOffsiteAnalysisSummary(){
    const offsite = deriveOffsite();
    const quantity = deriveQuantityPerformance();
    return {
      mode: offsite.mode,
      metricPolicy: {
        useAsBackgroundOnly: true,
        noCausalLinkToContent: true,
        rule: "站外数据没有与具体内容的映射时，只能作为背景结构，不能推断内容带动。"
      },
      total: offsite.total,
      quantityPerformance: {
        source: quantity.source,
        remark: quantity.remark,
        metrics: quantity.metrics.map(metric => ({
          label: metric.label,
          current: metric.current,
          previous: metric.previous,
          unit: metric.unit || ""
        }))
      },
      rows: offsite.rows.map(row => ({
        label: sanitizeOffsiteLabel(row.label),
        value: row.value,
        interaction: row.interaction || 0,
        note: row.note || ""
      }))
    };
  }

  function buildAiPrompt(pkg){
    return [
      "请基于下面 JSON 做周复盘 AI 草稿。",
      "你的任务不是复述数据，而是帮助负责人判断哪些问题值得人工复盘、哪些说法证据不足、下一步要补什么信息。",
      "业务目标：这是一份内容与渠道周复盘，不存在投放、预算、加码投放等概念。输出对象是管理者和各渠道负责人。",
      "硬性规则：",
      "1. 只返回严格 JSON，不要 Markdown，不要解释文字。",
      "2. 如果 businessReady 为 false，请不要分析，直接返回 questionsForOwner 提醒先导入本周 Excel。",
      "3. 不要使用资源购买类表达，也不要提出追加资源类建议。",
      "4. report 是表现统计窗口，batch 是内容发布时间样本池，两者不是二选一。",
      "5. 社群没有曝光和互动率口径，不得写“曝光为0”或“互动率为0”。",
      "6. Top5 曝光占比低于 30% 时，不得写 Top 内容带动整体，只能写具备复盘价值。",
      "7. hypothesisDrafts.hypothesisId 必须使用输入 hypotheses 中已有 id。",
      "8. 不要推断数据包未提供的账号粉丝量、完播率、转化、内容文本、特殊运营背景。",
      "9. programConclusions 是程序已经自动生成的事实结论，不要在 AI 输出中机械复述。",
      "10. AI 的任务是提出更深层假设、可能解释路径、验证方式和负责人待确认问题。",
      "11. 如果某结论只需要排序、占比、Top 来源、Top5 占比或字段缺失即可得出，请不要把它包装成 AI 结论。",
      "12. 每条结论必须区分证据强度，在 conclusion 开头写【数据直接支撑】、【推断】或【数据不足】。",
      "13. hypothesis 必须可被数据或负责人补充信息推翻，优先使用“如果……那么……”表达；不要把已知结果改写成假设。",
      "14. validation 必须写清用于验证的指标、口径和反面证据；如果缺少字段，直接写缺什么，不要补脑。",
      "15. risk 必须包含反面检验：如果这条判断错了，最可能错在哪里。",
      "16. 如果数据包提供 interactionBreakdown、likes、comments、shares、saves，不要再让负责人确认哪类互动最高；AI 应直接引用已有拆分，只让负责人确认这些互动背后的内容机制。",
      "17. 不要把程序已经能算出的指标做成 ownerQuestion；ownerQuestion 只能问数据里没有的业务语境、内容判断或负责人归因。",
      "18. ownerQuestion 必须是负责人能回答的具体问题，尽量指向 Top 帖、内容主题、素材形式、发布时间、互动方式、负责人归属；不要写泛泛的“请确认原因”。",
      "19. 对社媒，优先分析平台角色分化、曝光入口和互动入口是否不同；不要分析缺链接内容的具体创意。",
      "20. 对 KOL，优先提出内容结构待验证假设，例如开箱、教程、做款、口播、产品露出方式，但必须标注需要负责人看原帖确认。",
      "21. 对社群，只围绕互动、Top 帖、社群名称、话题、提问方式、评论引导和负责人总结；不要和社媒、KOL按曝光口径横向比较。",
      "22. 对站外数据，只作为来源结构展示背景；没有内容链接、日期或 UTM 映射时，不得推断内容带动站外表现。",
      "23. 不要输出空泛动作，如优化、加强、持续关注、重点跟进。若要提出动作，必须包含对象、范围、验证周期、观察指标和停止或调整条件。",
      "24. 每个 channelDrafts 只保留该渠道最需要负责人判断的 1 个问题，不要堆指标摘要。",
      "25. 每个 playbookDrafts 只能写“待验证的复用方向”和“避雷点”，不能写成已验证经验。",
      "26. executiveDrafts 最多 2 条，hypothesisDrafts 只覆盖输入 hypotheses，channelDrafts 按社群、社媒、KOL 各 1 条，playbookDrafts 按社群、社媒、KOL、站外各 1 条。",
      "27. longTermHypotheses 是跨周假设池；AI 只能补充本周支持点、反证和待确认问题，不得自行宣布长期假设成立、失效或加入长期经验。",
      "输出字段写法：",
      "- phenomenon：只写数据现象和口径，不解释原因。",
      "- hypothesis：写一个可被推翻的业务假设。",
      "- validation：写支持证据、反面证据和缺失字段。",
      "- conclusion：用证据强度标签开头，再写对复盘有用的判断。",
      "- risk：写这条判断的限制和最可能的反面解释。",
      "- ownerQuestion：写负责人下一步需要补充的具体信息。",
      "请严格使用以下 JSON 结构：",
      '{"executiveDrafts":[{"title":"","phenomenon":"","hypothesis":"","validation":"","conclusion":"","risk":"","ownerQuestion":""}],"hypothesisDrafts":[{"hypothesisId":"","title":"","phenomenon":"","hypothesis":"","validation":"","conclusion":"","risk":"","ownerQuestion":""}],"channelDrafts":[{"channel":"","title":"","phenomenon":"","hypothesis":"","validation":"","conclusion":"","risk":"","ownerQuestion":""}],"playbookDrafts":[{"channel":"","title":"","reusableExperienceDraft":"","pitfallDraft":"","validationNeeded":"","risk":"","ownerQuestion":""}],"questionsForOwner":[]}',
      `当前数据包版本：${pkg.version}`
    ].join("\n");
  }

  function findAiDraftForHypothesis(id){
    if (!aiResult) return null;
    return (aiResult.hypothesisDrafts || []).find(item => item.hypothesisId === id || item.id === id) || null;
  }

  function loadAiResult(){
    const local = loadJson(AI_RESULT_KEY);
    aiResult = local || window.WeeklyReviewAiResult || null;
  }

  function loadLongTermPool(){
    const local = loadJson(LONG_TERM_POOL_KEY);
    const published = window.WeeklyReviewLongTermHypotheses
      || (window.WeeklyReviewAiResult && window.WeeklyReviewAiResult.longTermHypotheses);
    const raw = Array.isArray(local) ? local : Array.isArray(published) ? published : [];
    return raw.map(item => applyLongTermStatus({
      ...item,
      status: item.status || "observing",
      records: Array.isArray(item.records) ? item.records : []
    }));
  }

  function saveLongTermPool(pool){
    saveJson(LONG_TERM_POOL_KEY, pool);
  }

  function mergeImportedSource(imported){
    return {
      ...cloneData(initialSource),
      ...imported,
      monthlyGoal: cloneData(initialSource.monthlyGoal || imported.monthlyGoal || { month: "", exposureTarget: 0 }),
      manualModules: cloneData(initialSource.manualModules || imported.manualModules || []),
      dtcSection: cloneData(imported.dtcSection || initialSource.dtcSection || { totalCurrent: 0, rows: [] })
    };
  }

  async function loadPersistedImport(){
    try {
      const db = await openImportDb();
      const cached = await idbRequest(db.transaction(IMPORT_STORE_NAME, "readonly").objectStore(IMPORT_STORE_NAME).get(IMPORT_CACHE_KEY));
      if (cached && cached.source) return cached;
    } catch (error) {
      // localStorage fallback below
    }
    return loadLocalStorageImport();
  }

  async function savePersistedImport(imported){
    try {
      const db = await openImportDb();
      const transaction = db.transaction(IMPORT_STORE_NAME, "readwrite");
      await idbRequest(transaction.objectStore(IMPORT_STORE_NAME).put({
        key: IMPORT_CACHE_KEY,
        source: imported,
        savedAt: formatDate(new Date())
      }));
      await idbTransactionDone(transaction);
    } catch (error) {
      // localStorage fallback below
    }
    try {
      saveLocalStorageImport(imported);
    } catch (error) {
      // cache is best effort
    }
  }

  async function clearPersistedImport(){
    try {
      const db = await openImportDb();
      const transaction = db.transaction(IMPORT_STORE_NAME, "readwrite");
      await idbRequest(transaction.objectStore(IMPORT_STORE_NAME).delete(IMPORT_CACHE_KEY));
      await idbTransactionDone(transaction);
    } catch (error) {
      // ignore storage errors
    }
    clearLocalStorageImport();
  }

  function openImportDb(){
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error("IndexedDB unavailable")); return; }
      const request = indexedDB.open(IMPORT_DB_NAME, IMPORT_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IMPORT_STORE_NAME)) db.createObjectStore(IMPORT_STORE_NAME, { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbRequest(request){
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function idbTransactionDone(transaction){
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function loadLocalStorageImport(){
    try {
      const meta = JSON.parse(localStorage.getItem(IMPORT_FALLBACK_META_KEY) || "null");
      if (!meta || !Number.isFinite(meta.chunks) || meta.chunks <= 0) return null;
      let json = "";
      for (let index = 0; index < meta.chunks; index += 1) {
        const chunk = localStorage.getItem(`${IMPORT_FALLBACK_CHUNK_PREFIX}${index}`);
        if (chunk === null) return null;
        json += chunk;
      }
      const imported = JSON.parse(json);
      return { key: IMPORT_CACHE_KEY, source: imported, savedAt: meta.savedAt || "" };
    } catch (error) {
      return null;
    }
  }

  function saveLocalStorageImport(imported){
    const json = JSON.stringify(imported);
    const chunks = Math.ceil(json.length / IMPORT_FALLBACK_CHUNK_SIZE);
    clearLocalStorageImport();
    for (let index = 0; index < chunks; index += 1) {
      localStorage.setItem(`${IMPORT_FALLBACK_CHUNK_PREFIX}${index}`, json.slice(index * IMPORT_FALLBACK_CHUNK_SIZE, (index + 1) * IMPORT_FALLBACK_CHUNK_SIZE));
    }
    localStorage.setItem(IMPORT_FALLBACK_META_KEY, JSON.stringify({ chunks, savedAt: formatDate(new Date()) }));
  }

  function clearLocalStorageImport(){
    try {
      const meta = JSON.parse(localStorage.getItem(IMPORT_FALLBACK_META_KEY) || "null");
      const count = meta && Number.isFinite(meta.chunks) ? meta.chunks : 80;
      for (let index = 0; index < count; index += 1) localStorage.removeItem(`${IMPORT_FALLBACK_CHUNK_PREFIX}${index}`);
      localStorage.removeItem(IMPORT_FALLBACK_META_KEY);
    } catch (error) {
      localStorage.removeItem(IMPORT_FALLBACK_META_KEY);
    }
  }

  function getModalRoot(){
    let root = document.getElementById("modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "modal-root";
    root.className = "modal-root";
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
    return root;
  }

  function showModal(config){
    const modalRoot = getModalRoot();
    modalRoot.classList.add("is-open");
    modalRoot.innerHTML = `
      <div class="modal-shell" role="dialog" aria-modal="true">
        <header class="modal-head">
          <div>
            <h3>${escapeHtml(config.title || "提示")}</h3>
            ${config.subtitle ? `<p>${escapeHtml(config.subtitle)}</p>` : ""}
          </div>
          <button class="modal-close" type="button" data-modal-close aria-label="关闭">×</button>
        </header>
        <div class="modal-body">${config.body || ""}</div>
        <div class="modal-actions">${config.actions || `<button class="primary-button" type="button" data-modal-close>关闭</button>`}</div>
      </div>
    `;
    modalRoot.querySelectorAll("[data-modal-close]").forEach(button => button.addEventListener("click", closeModal));
    modalRoot.addEventListener("pointerdown", modalOutsideClose);
    document.removeEventListener("keydown", modalEscapeClose);
    document.addEventListener("keydown", modalEscapeClose);
    if (typeof config.onMount === "function") config.onMount(modalRoot);
  }

  function closeModal(){
    const modalRoot = document.getElementById("modal-root");
    if (!modalRoot) return;
    modalRoot.classList.remove("is-open");
    modalRoot.innerHTML = "";
    modalRoot.removeEventListener("pointerdown", modalOutsideClose);
    document.removeEventListener("keydown", modalEscapeClose);
  }

  function modalOutsideClose(event){
    const modalRoot = document.getElementById("modal-root");
    if (!modalRoot) return;
    if (event.target === modalRoot) closeModal();
  }

  function modalEscapeClose(event){
    if (event.key === "Escape") closeModal();
  }

  function showToast(text){
    window.clearTimeout(toastTimer);
    dom.toast.textContent = text;
    dom.toast.hidden = false;
    toastTimer = window.setTimeout(() => { dom.toast.hidden = true; }, 3600);
  }

  function downloadText(fileName, text, type){
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  function getActiveView(){
    return VIEWS.find(view => view.key === state.view) || VIEWS[0];
  }

  function resolveDateRange(startText, endText, fallback){
    const start = parseDate(startText);
    const end = parseDate(endText);
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return fallback;
    return start <= end ? { start, end } : { start: end, end: start };
  }

  function resolveLifecycleWeekRange(startText, endText, fallback){
    const base = parseDate(startText) || parseDate(endText);
    if (!base || Number.isNaN(base.getTime())) return fallback;
    return naturalWeekRange(base);
  }

  function resolveShortcut(key, fallback){
    const base = fallback.end || reviewWindow.end;
    if (key === "last7") {
      const week = naturalWeekRange(base);
      return { start: addDays(week.start, -7), end: addDays(week.end, -7) };
    }
    if (key === "week") {
      const day = (base.getDay() + 6) % 7;
      return { start: addDays(base, -day), end: addDays(addDays(base, -day), 6) };
    }
    if (key === "month") return { start: new Date(base.getFullYear(), base.getMonth(), 1), end: new Date(base.getFullYear(), base.getMonth() + 1, 0) };
    if (key === "quarter") {
      const qStart = Math.floor(base.getMonth() / 3) * 3;
      return { start: new Date(base.getFullYear(), qStart, 1), end: new Date(base.getFullYear(), qStart + 3, 0) };
    }
    return fallback;
  }

  function resolveLifecycleDefaultRange(baseDate){
    const reviewWeek = naturalWeekRange(baseDate || reviewWindow.end);
    return { start: addDays(reviewWeek.start, -14), end: addDays(reviewWeek.end, -14) };
  }

  function resolveDefaultReviewWindow(dataSource){
    const latest = latestStatDate((dataSource && dataSource.posts) || []);
    return latest ? latestCompleteNaturalWeek(latest) : parseReviewWindow(dataSource && dataSource.reviewWeek && dataSource.reviewWeek.dateRange);
  }

  function latestCompleteNaturalWeek(referenceDate){
    const week = naturalWeekRange(referenceDate);
    if (referenceDate >= week.end) return week;
    const previousEnd = addDays(week.start, -1);
    return naturalWeekRange(previousEnd);
  }

  function parseReviewWindow(text){
    const parts = String(text || "").split("~").map(part => parseDate(part.trim())).filter(Boolean);
    if (parts.length >= 2) return { start: parts[0], end: parts[1] };
    const today = new Date();
    return { start: addDays(today, -6), end: today };
  }

  function parseDate(text){
    const value = toDateString(text);
    return value ? new Date(`${value}T00:00:00`) : null;
  }

  function toDateString(value){
    if (value instanceof Date && !Number.isNaN(value.getTime())) return formatDate(value);
    if (typeof value === "number") {
      const date = excelSerialToDate(value);
      if (date) return formatDate(date);
    }
    const text = asText(value);
    if (!text) return "";
    const normalized = text.replace(/[./]/g, "-").replace("T", " ").trim();
    const datePart = normalized.split(" ")[0];
    const candidate = new Date(datePart);
    if (!Number.isNaN(candidate.getTime())) return formatDate(candidate);
    const fallback = new Date(normalized);
    if (!Number.isNaN(fallback.getTime())) return formatDate(fallback);
    return "";
  }

  function excelSerialToDate(serial){
    if (!Number.isFinite(serial)) return null;
    const utc = Date.UTC(1899, 11, 30) + Math.round(serial * DAY_MS);
    const date = new Date(utc);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function latestStatDate(items){
    let latest = null;
    items.forEach(post => {
      (post.snapshots || []).forEach(snapshot => {
        const date = parseDate(snapshot.capturedAt);
        if (date && (!latest || date > latest)) latest = date;
      });
    });
    return latest;
  }

  function rangeText(values){
    const dates = values.map(parseDate).filter(date => date && !Number.isNaN(date.getTime())).sort((a, b) => a - b);
    if (!dates.length) return "";
    return `${formatDate(dates[0])} ~ ${formatDate(dates[dates.length - 1])}`;
  }

  function normalizeChannelType(rawType, channelName){
    const type = asText(rawType).toLowerCase();
    const name = asText(channelName);
    if (type.includes("kol") || type.includes("达人")) return "KOL";
    if (type.includes("站外") || type.includes("dtc") || type.includes("offsite")) return "站外";
    if (type.includes("社群") || isCommunityUnitName(name)) return "社群";
    if (type.includes("社媒") || type.includes("social")) return "社媒";
    return "社媒";
  }

  function displayChannelNameForPost(post){
    const type = normalizeChannelType(post.channelType, post.channelName || post.platform);
    if (type === "社群") {
      const name = normalizeDimension(post.channelName);
      if (name) return name;
    }
    return canonicalChannelName(post.channelName || post.platform || "未知渠道");
  }

  function isCommunityUnitName(value){
    const text = normalizeDimension(value);
    if (!text) return false;
    const lower = text.toLowerCase();
    const platformNames = new Set(["facebook","fb","instagram","ins","ig","tiktok","tk","youtube","yt","pinterest","twitter","x"]);
    return !platformNames.has(lower) && (text.includes("群") || ["大群","lovers群","us群","uk群"].includes(lower));
  }

  function canonicalChannelName(value){
    const text = asText(value);
    const lower = text.toLowerCase();
    const map = { tk:"TikTok", tiktok:"TikTok", fb:"Facebook", facebook:"Facebook", ins:"Instagram", instagram:"Instagram", ig:"Instagram", yt:"YouTube", youtube:"YouTube" };
    return map[lower] || text || "未知渠道";
  }

  function normalizeContentFormat(value){
    const raw = asText(value).toLowerCase().replace(/\s+/g, "");
    if (!raw) return "";
    if (raw.includes("视频") || raw.includes("video") || raw.includes("reel") || raw.includes("short")) return "视频";
    if (raw.includes("图文") || raw.includes("image") || raw.includes("photo") || raw.includes("picture") || raw.includes("carousel")) return "图文";
    return asText(value);
  }

  function normalizeDimension(value){
    const text = asText(value);
    if (!text || text === "未知" || text.toLowerCase() === "unknown") return "";
    return text;
  }

  function contentLabel(post){
    return [post.normalizedTopic, post.normalizedFormat, post.displayChannelName].filter(Boolean).join(" · ") || "未命名内容";
  }

  function metricInteraction(snapshot){
    return asNumber(snapshot.interaction) || (asNumber(snapshot.likes) + asNumber(snapshot.comments) + asNumber(snapshot.shares) + asNumber(snapshot.saves));
  }

  function normalizePostUrl(value){
    const text = asText(value);
    if (!text) return "";
    const extracted = text.match(/https?:\/\/[^\s"'<>]+/i)?.[0] || text;
    const urlText = /^https?:\/\//i.test(extracted) ? extracted : `https://${extracted}`;
    try {
      const url = new URL(urlText);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch (error) {
      return "";
    }
  }

  function shortDisplayUrl(value){
    try {
      const url = new URL(value);
      const host = url.hostname.replace(/^www\./i, "");
      const tail = url.pathname.split("/").filter(Boolean).pop() || "";
      return tail ? `${host}/${tail.slice(0, 24)}${tail.length > 24 ? "..." : ""}` : host;
    } catch (error) {
      const text = asText(value);
      return text.length > 32 ? `${text.slice(0, 29)}...` : text;
    }
  }

  function sanitizeOffsiteLabel(value){
    return asText(value)
      .replace(/广告/g, "来源")
      .replace(/\s+/g, " ")
      .trim();
  }

  function requiredLabel(key){
    const map = { statDate:"统计日期", publishDate:"发布时间", channelType:"渠道类型", channelName:"渠道名称", owner:"负责人", link:"帖子链接" };
    return map[key] || key;
  }

  function getRecommendedMissing(audit){
    const required = audit && audit.missingRequired ? audit.missingRequired : {};
    const recommended = audit && audit.missingRecommended ? audit.missingRecommended : {};
    return {
      owner: Number(recommended.owner ?? required.owner ?? 0) || 0,
      link: Number(recommended.link ?? required.link ?? 0) || 0
    };
  }

  function saveText(key, value){
    try { localStorage.setItem(key, value || ""); } catch (error) { /* ignore */ }
  }

  function loadText(key){
    try { return localStorage.getItem(key) || ""; } catch (error) { return ""; }
  }

  function saveJson(key, value){
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* ignore */ }
  }

  function loadJson(key){
    try { return JSON.parse(localStorage.getItem(key) || "null"); } catch (error) { return null; }
  }

  function normalizeStorageKey(value){
    return encodeURIComponent(asText(value).toLowerCase());
  }

  function asText(value){
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function asNumber(value){
    if (value === null || value === undefined || value === "") return 0;
    const num = Number(String(value).replace(/,/g, "").replace(/%/g, ""));
    return Number.isFinite(num) ? num : 0;
  }

  function addDays(date, days){
    return new Date(date.getTime() + days * DAY_MS);
  }

  function naturalWeekRange(date){
    const day = (date.getDay() + 6) % 7;
    const start = addDays(date, -day);
    return { start, end: addDays(start, 6) };
  }

  function inDateRange(date, start, end){
    return date && start && end && date >= start && date <= end;
  }

  function weekOfYear(date){
    const current = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    current.setUTCDate(current.getUTCDate() + 4 - (current.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(current.getUTCFullYear(), 0, 1));
    return Math.ceil((((current - yearStart) / DAY_MS) + 1) / 7);
  }

  function safeRate(numerator, denominator){
    return denominator ? numerator / denominator : 0;
  }

  function safeWoW(current, previous){
    return previous ? current / previous - 1 : 0;
  }
  function wowColor(wow){
    return wow > 0.1 ? "var(--up)" : wow < -0.1 ? "var(--down)" : "var(--muted)";
  }
  function wowLabel(wow){
    return wow > 0.1 ? "↑" : wow < -0.1 ? "↓" : "→";
  }

  function sum(items, getter){
    return items.reduce((acc, item) => acc + getter(item), 0);
  }

  function formatDate(date){
    const y = date.getFullYear();
    const m = `${date.getMonth() + 1}`.padStart(2, "0");
    const d = `${date.getDate()}`.padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function formatYearMonth(date){
    return `${date.getFullYear()}年${date.getMonth() + 1}月`;
  }

  function formatCompact(value){
    const n = Number(value || 0);
    if (Math.abs(n) >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
    if (Math.abs(n) >= 10000) return `${(n / 10000).toFixed(1)}万`;
    return `${Math.round(n)}`;
  }

  function formatInteger(value){
    return Math.round(Number(value || 0)).toLocaleString("zh-CN");
  }

  function formatPct(value){
    return `${(Number(value || 0) * 100).toFixed(1)}%`;
  }

  function formatPctDelta(value){
    const n = Number(value || 0) * 100;
    return `${n > 0 ? "+" : ""}${n.toFixed(1)} pct`;
  }

  function formatDelta(value){
    const n = Number(value || 0) * 100;
    return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
  }

  function hashText(text){
    let hash = 0;
    const value = String(text || "");
    for (let i = 0; i < value.length; i += 1) {
      hash = ((hash << 5) - hash) + value.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash);
  }

  function cloneData(value){
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value){
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&":"&amp;",
      "<":"&lt;",
      ">":"&gt;",
      "\"":"&quot;",
      "'":"&#39;"
    }[ch]));
  }
})();

