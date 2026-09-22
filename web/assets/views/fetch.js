/**
 * views/fetch.js —— 抓取控制台（模块 2）。
 *
 * 页面就是一条流水线，每一步都要用户点头才往下走：
 *   ① 贴目录页链接 → 合规自检（不通过就到此为止，没有"强行继续"的入口）
 *   ② 结构探测 → 可视化确认；认不出来时列出页面里的候选区让用户点选
 *   ③ 试抓前 3 章 → 确认正文干净再开抓
 *   ④ 整本抓取 → 三色进度（已抓 / 待抓 / 失败）+ 暂停 / 继续 / 取消 / 重试 → 抓取报告
 *
 * 注意：抓取参数（并发、同域间隔）不在这里，它们收在设置页的二级设置里，
 * 而且默认值就是合规安全值，改不低。
 */

import { api } from '../api.js';
import { router } from '../router.js';
import { confirmDialog, esc, fmtDuration, toast, toastError } from '../ui.js';

const state = {
  url: '',
  compliance: null,
  probe: null,
  preview: null,
  task: null,
  taskId: '',
  timer: null,
  candidates: null,
  tocSelector: '',
  contentSelector: '',
  busy: false,
};

const REASON_LABEL = {
  ROBOTS_DISALLOWED: 'robots.txt 禁止',
  EMPTY_CONTENT: '抓到的内容是空的',
  COMPLIANCE_REJECTED: '合规自检未通过',
  fetch_failed: '网络或页面异常',
  RETRY_EXHAUSTED: '连续重试都失败',
  HTTP_404: '页面不存在',
};

function stopPolling() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

// ------------------------------------------------------------------ ① 合规

function renderCompliance(check) {
  const box = document.getElementById('complianceBox');
  if (!check) {
    box.innerHTML = '';
    return;
  }
  const level = check.allowed ? 'callout-ok' : 'callout-warn';
  const details = [];
  if (check.robots) {
    details.push(
      `<li>robots.txt：${check.robots.allowed ? '没有禁止这个路径' : '禁止了这个路径'}${
        check.robots.ruleText ? `（命中规则：<span class="mono">${esc(check.robots.ruleText)}</span>）` : ''
      }</li>`
    );
  }
  if (check.login && check.login.detected) {
    details.push(`<li>登录墙：${esc(check.login.evidence.join('、'))}</li>`);
  }
  if (check.paywall && check.paywall.detected) {
    details.push(`<li>付费墙：${esc(check.paywall.evidence.join('、'))}</li>`);
  }
  if (check.page) {
    details.push(`<li>页面状态：${check.page.status}，${check.page.bytes} 字节，识别编码 ${esc(check.page.encoding)}</li>`);
  }

  box.innerHTML = `
    <div class="callout ${level}">
      <p><strong>${check.allowed ? '合规自检通过' : '不能抓这个页面'}</strong></p>
      <p>${esc(check.message)}</p>
      ${check.hint ? `<p class="panel-note">${esc(check.hint)}</p>` : ''}
      ${details.length ? `<ul class="fetch-detail">${details.join('')}</ul>` : ''}
    </div>`;
}

async function runCompliance() {
  const input = document.getElementById('fetchUrl');
  state.url = input.value.trim();
  if (!state.url) {
    toast('先把目录页地址粘进来。', 'warn');
    return;
  }
  const box = document.getElementById('complianceBox');
  box.innerHTML = '<div class="loading">正在做合规自检…</div>';
  document.getElementById('probePanel').hidden = true;
  document.getElementById('previewPanel').hidden = true;

  try {
    const check = await api.post('/api/fetch/compliance', { url: state.url });
    state.compliance = check;
    renderCompliance(check);
    if (!check.allowed) return;
    await runProbe();
  } catch (err) {
    box.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
    toastError(err);
  }
}

// ------------------------------------------------------------------ ② 探测

function renderProbe(probe) {
  const panel = document.getElementById('probePanel');
  panel.hidden = false;

  if (!probe.ok) {
    panel.innerHTML = `
      <h2 class="panel-title">② 确认结构</h2>
      <div class="callout callout-warn">
        <p>${esc(probe.message)}</p>
        <p class="panel-note">${esc(probe.hint || '')}</p>
      </div>
      <h3 class="sub-title">从下面的候选里点选（点一下就等于告诉工具"这块是目录区 / 正文区"）</h3>
      <div id="candidateBox" class="candidate-box"><div class="loading">正在读取页面结构…</div></div>
      <div class="panel-actions">
        <button class="btn btn-primary" id="btnManualProbe" type="button">用选中的区块重新探测</button>
        <button class="btn" id="btnReloadCandidates" type="button">重新读取候选</button>
      </div>`;
    document.getElementById('btnManualProbe').onclick = () => runManualProbe();
    document.getElementById('btnReloadCandidates').onclick = () => loadCandidates();
    loadCandidates();
    return;
  }

  state.probe = probe;
  panel.innerHTML = `
    <h2 class="panel-title">② 确认结构</h2>
    <div class="callout callout-ok">
      <p>认出来了：这本书是《${esc(probe.book.title)}》${probe.book.author ? ` · ${esc(probe.book.author)}` : ''}</p>
      <p class="panel-note">
        目录区：<span class="mono">${esc(probe.toc.selector)}</span>，共 ${probe.toc.linkCount} 个章节链接 ·
        正文区：<span class="mono">${esc(probe.content.selector || '（没认出来）')}</span>
        ${probe.content.charCount ? `，试读片段 ${probe.content.charCount} 字` : ''}
      </p>
    </div>
    ${
      probe.warnings && probe.warnings.length
        ? `<div class="callout callout-warn">${probe.warnings.map((w) => `<p>${esc(w)}</p>`).join('')}</div>`
        : ''
    }
    <h3 class="sub-title">目录前几条</h3>
    <ol class="chapter-preview fetch-links">
      ${probe.toc.sample
        .map(
          (link) => `<li><span class="ch-index">·</span><span class="ch-title">${esc(link.title)}</span>
            <span class="ch-sample mono">${esc(link.url)}</span></li>`
        )
        .join('')}
    </ol>
    ${
      probe.content.sampleText
        ? `<h3 class="sub-title">正文样例（第一章开头）</h3>
           <pre class="preview-block">${esc(probe.content.sampleText)}</pre>`
        : ''
    }
    <div class="panel-actions">
      <button class="btn btn-primary" id="btnPreview" type="button">试抓前 3 章</button>
      <button class="btn" id="btnAdjust" type="button">结构不对，手动改</button>
    </div>
    <div id="candidateBox" hidden></div>`;

  document.getElementById('btnPreview').onclick = () => runPreview();
  document.getElementById('btnAdjust').onclick = () => {
    const box = document.getElementById('candidateBox');
    box.hidden = false;
    loadCandidates();
  };
}

async function runProbe() {
  const panel = document.getElementById('probePanel');
  panel.hidden = false;
  panel.innerHTML = '<div class="loading">正在探测页面结构…</div>';
  try {
    const probe = await api.post('/api/fetch/probe', { url: state.url, skip_compliance: true });
    renderProbe(probe);
  } catch (err) {
    panel.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p>${
      err.hint ? `<p class="panel-note">${esc(err.hint)}</p>` : ''
    }</div>`;
  }
}

async function loadCandidates() {
  const box = document.getElementById('candidateBox');
  box.hidden = false;
  box.innerHTML = '<div class="loading">正在读取页面结构…</div>';
  try {
    const data = await api.post('/api/fetch/candidates', { url: state.url });
    state.candidates = data;
    box.innerHTML = `
      <p class="panel-note">${esc(data.note)}</p>
      <h4 class="sub-title">候选目录区</h4>
      <div class="candidate-list">
        ${
          data.toc.length
            ? data.toc
                .map(
                  (c) => `<button class="candidate-item" type="button" data-kind="toc" data-selector="${esc(c.selector)}">
                    <span class="cand-selector mono">${esc(c.selector)}</span>
                    <span class="cand-meta">${c.linkCount} 个链接</span>
                    <span class="cand-sample">${esc(c.sample.join(' / '))}</span>
                  </button>`
                )
                .join('')
            : '<p class="panel-note">没找到候选目录区，请确认这个地址是目录页。</p>'
        }
      </div>
      <h4 class="sub-title">候选正文区${data.chapter_title ? `（取自：${esc(data.chapter_title)}）` : ''}</h4>
      <div class="candidate-list">
        ${
          data.content.length
            ? data.content
                .map(
                  (c) => `<button class="candidate-item" type="button" data-kind="content" data-selector="${esc(c.selector)}">
                    <span class="cand-selector mono">${esc(c.selector)}</span>
                    <span class="cand-meta">${c.charCount} 字</span>
                    <span class="cand-sample">${esc(c.sample)}</span>
                  </button>`
                )
                .join('')
            : '<p class="panel-note">没找到候选正文区。</p>'
        }
      </div>
      <div class="field-row">
        <label class="field field-grow">
          <span>目录区选择器</span>
          <input type="text" id="tocSelector" class="mono" value="${esc(state.tocSelector)}" />
        </label>
        <label class="field field-grow">
          <span>正文区选择器</span>
          <input type="text" id="contentSelector" class="mono" value="${esc(state.contentSelector)}" />
        </label>
      </div>
      <div class="panel-actions">
        <button class="btn btn-primary" id="btnManualProbe2" type="button">用这两个区块重新探测</button>
      </div>`;

    for (const button of box.querySelectorAll('.candidate-item')) {
      button.onclick = () => {
        const kind = button.dataset.kind;
        const selector = button.dataset.selector;
        if (kind === 'toc') state.tocSelector = selector;
        else state.contentSelector = selector;
        for (const other of box.querySelectorAll(`.candidate-item[data-kind="${kind}"]`)) {
          other.classList.toggle('is-picked', other === button);
        }
        const input = document.getElementById(kind === 'toc' ? 'tocSelector' : 'contentSelector');
        if (input) input.value = selector;
      };
    }
    document.getElementById('btnManualProbe2').onclick = () => {
      state.tocSelector = document.getElementById('tocSelector').value.trim();
      state.contentSelector = document.getElementById('contentSelector').value.trim();
      runManualProbe();
    };
  } catch (err) {
    box.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

async function runManualProbe() {
  if (!state.tocSelector && !state.contentSelector) {
    toast('请先点上至少一块区域，或者直接填选择器。', 'warn');
    return;
  }
  const panel = document.getElementById('probePanel');
  panel.innerHTML = '<div class="loading">正在用你选的区块重新探测…</div>';
  try {
    const probe = await api.post('/api/fetch/probe/manual', {
      url: state.url,
      toc_selector: state.tocSelector || undefined,
      content_selector: state.contentSelector || undefined,
    });
    renderProbe(probe);
  } catch (err) {
    panel.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ ③ 试抓

async function runPreview() {
  if (!state.probe) return;
  const panel = document.getElementById('previewPanel');
  panel.hidden = false;
  panel.innerHTML = '<div class="loading">正在试抓前 3 章…</div>';
  try {
    const data = await api.post('/api/fetch/probe/preview', { probe: state.probe, count: 3 });
    state.preview = data;
    panel.innerHTML = `
      <h2 class="panel-title">③ 试抓确认</h2>
      <div class="callout"><p>${esc(data.note)}</p></div>
      ${data.chapters
        .map(
          (chapter) => `
        <div class="fetch-preview">
          <div class="fetch-preview-head">
            <strong>${esc(chapter.title)}</strong>
            <span class="panel-note">${chapter.charCount} 字${chapter.pages > 1 ? ` · 合并了 ${chapter.pages} 页` : ''}</span>
          </div>
          <pre class="preview-block">${esc(chapter.preview)}</pre>
          ${
            chapter.removed && chapter.removed.length
              ? `<details class="fetch-removed"><summary>剔除了 ${chapter.removed.length} 行（点开核对）</summary>
                   <ul>${chapter.removed.map((r) => `<li><span class="removal-reason">${esc(r.reason)}</span> ${esc(r.snippet)}</li>`).join('')}</ul>
                 </details>`
              : ''
          }
        </div>`
        )
        .join('')}
      <div class="panel-actions">
        <button class="btn btn-primary" id="btnStartFetch" type="button">正文没问题，开始整本抓取</button>
        <button class="btn" id="btnBackAdjust" type="button">还是不对，回去改结构</button>
      </div>`;

    document.getElementById('btnStartFetch').onclick = () => startFetch();
    document.getElementById('btnBackAdjust').onclick = () => {
      panel.hidden = true;
      document.getElementById('probePanel').scrollIntoView({ behavior: 'smooth' });
    };
  } catch (err) {
    panel.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
    toastError(err);
  }
}

// ------------------------------------------------------------------ ④ 整本抓取

async function startFetch() {
  const panel = document.getElementById('taskPanel');
  panel.hidden = false;
  panel.innerHTML = '<div class="loading">正在创建抓取任务…</div>';
  try {
    const created = await api.post('/api/fetch/tasks', {
      url: state.url,
      probe: state.probe,
    });
    state.taskId = created.task_id;
    toast(created.message, 'ok', 4000);
    // 把任务深链写进地址栏，刷新之后还能回到这个任务
    router.go(`/fetch?task=${encodeURIComponent(created.task_id)}`);
    renderTask({ ...created, status: 'running', progress: { done: 0, failed: 0, total: created.total } });
    startPolling();
  } catch (err) {
    panel.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p>${
      err.hint ? `<p class="panel-note">${esc(err.hint)}</p>` : ''
    }</div>`;
  }
}

function renderTask(task) {
  const panel = document.getElementById('taskPanel');
  panel.hidden = false;
  const total = task.progress.total || 1;
  // 语义与 PRD 的三色一致：done = 已经抓到的，failed = 失败的，剩下的是待抓
  const done = task.progress.done || 0;
  const failed = task.progress.failed || 0;
  const pending = Math.max(0, total - done - failed);
  const pct = (n) => `${Math.round((n / total) * 1000) / 10}%`;

  panel.innerHTML = `
    <h2 class="panel-title">④ 抓取进度</h2>
    <div class="tri-bar" role="img" aria-label="已抓 ${done} 章，待抓 ${pending} 章，失败 ${failed} 章">
      <span class="tri-done" style="width:${pct(done)}"></span>
      <span class="tri-failed" style="width:${pct(failed)}"></span>
      <span class="tri-pending" style="width:${pct(pending)}"></span>
    </div>
    <div class="tri-legend">
      <span><i class="swatch tri-done"></i> 已抓 ${done}</span>
      <span><i class="swatch tri-pending"></i> 待抓 ${pending}</span>
      <span><i class="swatch tri-failed"></i> 失败 ${failed}</span>
      ${task.timing ? `<span class="panel-note">已用时 ${esc(fmtDuration(task.timing.elapsedMs))}${
        task.timing.etaMs ? ` · 预计还要 ${esc(fmtDuration(task.timing.etaMs))}` : ''
      }</span>` : ''}
    </div>
    <p class="panel-note">${esc(task.message || '')}</p>
    <div class="panel-actions">
      <button class="btn" id="btnPause" type="button" ${task.status !== 'running' ? 'disabled' : ''}>暂停</button>
      <button class="btn" id="btnResume" type="button" ${task.status !== 'paused' ? 'disabled' : ''}>继续抓</button>
      <button class="btn btn-danger" id="btnCancel" type="button" ${
        !['running', 'paused'].includes(task.status) ? 'disabled' : ''
      }>取消</button>
      <button class="btn" id="btnReport" type="button">看抓取报告</button>
      <a class="btn btn-primary" href="#/book/${esc(task.book_id || state.probe?.book?.book_id || '')}">去这本书的详情页</a>
    </div>
    <div id="reportBox"></div>`;

  const pauseBtn = document.getElementById('btnPause');
  if (pauseBtn) pauseBtn.onclick = () => controlTask('pause');
  const resumeBtn = document.getElementById('btnResume');
  if (resumeBtn) resumeBtn.onclick = () => controlTask('resume');
  const cancelBtn = document.getElementById('btnCancel');
  if (cancelBtn) {
    cancelBtn.onclick = async () => {
      const ok = await confirmDialog({
        title: '要停止这次抓取吗？',
        message: '已经抓到的章节会全部保留。',
        detail: '下次重新发起抓取时，已经抓好的章节不会重抓。',
        confirmText: '停止',
        danger: true,
      });
      if (ok) controlTask('cancel');
    };
  }
  document.getElementById('btnReport').onclick = () => loadReport();
}

async function controlTask(action) {
  try {
    const task = await api.post(`/api/fetch/tasks/${state.taskId}/${action}`, {});
    state.task = task;
    renderTask(task);
    if (['done', 'failed', 'cancelled'].includes(task.status)) {
      stopPolling();
      await loadReport();
    }
  } catch (err) {
    toastError(err);
  }
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(async () => {
    try {
      const task = await api.get(`/api/fetch/tasks/${state.taskId}`);
      state.task = task;
      renderTask(task);
      if (['done', 'failed', 'cancelled'].includes(task.status)) {
        stopPolling();
        await loadReport();
      }
    } catch (err) {
      stopPolling();
      toastError(err);
    }
  }, 600);
}

async function loadReport() {
  const box = document.getElementById('reportBox');
  if (!box) return;
  box.innerHTML = '<div class="loading">正在整理抓取报告…</div>';
  try {
    const report = await api.get(`/api/fetch/tasks/${state.taskId}/report`);
    box.innerHTML = `
      <div class="report-block">
        <h3 class="sub-title">抓取报告</h3>
        <p>
          共 ${report.total} 章：成功 <strong>${report.success}</strong> 章，
          失败 <strong>${report.failed}</strong> 章，
          本次跳过（之前已抓）<strong>${report.skipped}</strong> 章。
        </p>
        <p class="panel-note">用时 ${esc(fmtDuration(report.elapsedMs))} · 章内分页合并 ${report.paginationMerges} 次 ·
          剔除疑似广告/导航 ${report.removedCount} 处</p>
        ${
          report.reasonSummary.length
            ? `<h4 class="sub-title">失败原因归类</h4>
               <ul class="issue-list">${report.reasonSummary
                 .map(
                   (item) => `<li class="issue-item"><span class="issue-tag">${item.count} 章</span>
                     <span class="issue-text">${esc(item.label || REASON_LABEL[item.reason] || item.reason)}</span></li>`
                 )
                 .join('')}</ul>`
            : ''
        }
        ${
          report.failures.length
            ? `<h4 class="sub-title">失败明细</h4>
               <ul class="issue-list">${report.failures
                 .map(
                   (f) => `<li class="issue-item"><span class="issue-tag">第 ${f.index} 章</span>
                     <span class="issue-text">${esc(f.title)}：${esc(f.message)}（重试 ${f.attempts} 次）</span></li>`
                 )
                 .join('')}</ul>
               <div class="panel-actions">
                 <button class="btn" id="btnRetryAll" type="button">重试全部失败章</button>
               </div>`
            : ''
        }
        ${
          report.removedSamples.length
            ? `<details class="fetch-removed" open>
                 <summary>被剔除的片段（抽查一下有没有误删正文）</summary>
                 <ul>${report.removedSamples
                   .slice(0, 60)
                   .map(
                     (r) => `<li><span class="removal-reason">第 ${r.index} 章 · ${esc(r.reason)}</span> ${esc(r.snippet)}</li>`
                   )
                   .join('')}</ul>
                 ${report.removedTruncated ? '<p class="panel-note">（只列出前一部分）</p>' : ''}
               </details>`
            : ''
        }
      </div>`;

    const retryAll = document.getElementById('btnRetryAll');
    if (retryAll) {
      retryAll.onclick = async () => {
        try {
          const result = await api.post(`/api/fetch/tasks/${state.taskId}/retry`, {});
          toast(result.message, result.failed ? 'warn' : 'ok', 4500);
          await loadReport();
        } catch (err) {
          toastError(err);
        }
      };
    }
  } catch (err) {
    box.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ 页面

export async function render(params, query) {
  const view = document.getElementById('view');
  const deepLink = (query && query.task) || '';
  stopPolling();

  view.innerHTML = `
    <section class="fetch-page">
      <div class="page-head">
        <h1>抓取控制台</h1>
        <p class="page-sub">贴一个目录页地址，工具自己把整本抓回来。抓之前会先做合规自检，也会先试抓几章让你确认。</p>
      </div>

      <div class="fetch-steps">
        <span class="fetch-step">① 贴链接</span>
        <span class="fetch-step">② 确认结构</span>
        <span class="fetch-step">③ 试抓确认</span>
        <span class="fetch-step">④ 整本抓取</span>
      </div>

      <div class="panel">
        <div class="search-bar">
          <input type="url" id="fetchUrl" placeholder="粘贴小说目录页地址（以 http:// 或 https:// 开头）" value="${esc(state.url)}" />
          <button class="btn btn-primary" id="btnCheck" type="button">开始检测</button>
        </div>
        <p class="panel-note">
          工具只抓公开、不需要登录也不需要付费的页面。遇到 login / 付费墙、或者 robots.txt 明确禁止的路径，会直接停下来并说明原因。
        </p>
        <div id="complianceBox"></div>
      </div>

      <div class="panel" id="probePanel" hidden></div>
      <div class="panel" id="previewPanel" hidden></div>
      <div class="panel" id="taskPanel" hidden></div>
    </section>`;

  const input = document.getElementById('fetchUrl');
  input.onkeydown = (event) => {
    if (event.key === 'Enter') runCompliance();
  };
  document.getElementById('btnCheck').onclick = () => runCompliance();

  if (deepLink) {
    state.taskId = deepLink;
    try {
      const task = await api.get(`/api/fetch/tasks/${encodeURIComponent(deepLink)}`);
      state.task = task;
      renderTask(task);
      if (task.status === 'running' || task.status === 'paused') startPolling();
      else loadReport();
    } catch (err) {
      toastError(err);
    }
  }
}

export { state as fetchState };
