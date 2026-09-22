/**
 * views/book.js —— 书籍详情与目录（模块 4）。
 *
 * 页面分三块：
 *   1. 头部：书名、作者、状态、进度、来源信息 + 主要动作（继续阅读/重命名/导出/移除）
 *   2. 目录质量：体检 / 更新对比 / 重新分章 / 只看异常（PRD 模块 4 的核心）
 *   3. 目录：虚拟滚动的章节清单，每章可以单独操作（改名/拆分/合并/删除/重抓/导出）
 *
 * 性能：目录一律走虚拟滚动（PRD 模块 5 硬指标：禁止一次性渲染整本书）。
 */

import { api } from '../api.js';
import { router } from '../router.js';
import { confirmDialog, esc, fmtDate, fmtRelative, promptDialog, toast, toastError } from '../ui.js';
import { VirtualList } from '../virtual-list.js';

const state = {
  bookId: '',
  book: null,
  chapters: [],
  diagnose: null,
  onlyIssues: false,
  /** 章号 → 体检问题类型，用来给目录行上色 */
  issueMap: new Map(),
  list: null,
};

const ISSUE_LABEL = {
  jump: '序号跳跃',
  duplicate: '标题重复',
  empty: '空章节',
  failed: '抓取失败',
  missing: '缺失',
};

// ------------------------------------------------------------------ 章节操作菜单

function closeMenus() {
  for (const menu of document.querySelectorAll('.context-menu')) menu.remove();
}

function openChapterMenu(chapter, x, y, reload) {
  closeMenus();
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = `${Math.min(x, window.innerWidth - 190)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - 280)}px`;
  menu.innerHTML = `
    <button type="button" data-act="open">打开这一章</button>
    <button type="button" data-act="rename">改标题</button>
    <button type="button" data-act="split">从这里拆成两章</button>
    <button type="button" data-act="merge">和下一章合并</button>
    <button type="button" data-act="refetch">重新抓取这一章</button>
    <button type="button" data-act="export">导出这一章</button>
    <hr />
    <button type="button" data-act="delete" class="danger">删除这一章</button>`;
  document.body.appendChild(menu);

  const onOutside = (event) => {
    if (!menu.contains(event.target)) {
      menu.remove();
      document.removeEventListener('mousedown', onOutside, true);
    }
  };
  document.addEventListener('mousedown', onOutside, true);

  menu.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const act = button.dataset.act;
    menu.remove();

    try {
      if (act === 'open') {
        window.location.href = `/reader.html?book=${encodeURIComponent(state.bookId)}&ch=${chapter.index}`;
        return;
      }
      if (act === 'rename') {
        const title = await promptDialog({ title: '改章节标题', label: '新标题', value: chapter.title });
        if (!title) return;
        await api.post(`/api/books/${state.bookId}/chapters/rename`, { index: chapter.index, title });
        toast('标题已改好。', 'ok');
        reload();
        return;
      }
      if (act === 'split') {
        const at = await promptDialog({
          title: `把第 ${chapter.index} 章拆成两章`,
          label: `从第几个字开始算作新的一章（1 ~ ${Math.max(1, chapter.char_count - 1)}），留空就按中间切`,
          value: '',
          confirmText: '拆分',
        });
        if (at === null) return;
        const payload = { index: chapter.index };
        if (at !== '') payload.at_offset = Number(at);
        const result = await api.post(`/api/books/${state.bookId}/chapters/split`, payload);
        toast(result.message, 'ok');
        reload();
        return;
      }
      if (act === 'merge') {
        const ok = await confirmDialog({
          title: `把第 ${chapter.index} 章和下一章合并？`,
          message: '两章会并成一章，原来的章节标题会作为小标题保留在正文里。',
          confirmText: '合并',
        });
        if (!ok) return;
        const result = await api.post(`/api/books/${state.bookId}/chapters/merge`, {
          index: chapter.index,
          count: 2,
        });
        toast(result.message, 'ok');
        reload();
        return;
      }
      if (act === 'refetch') {
        const result = await api.post(`/api/books/${state.bookId}/chapters/${chapter.index}/refetch`, {});
        toast(result && result.message ? result.message : '这一章已经重新抓取。', 'ok');
        reload();
        return;
      }
      if (act === 'export') {
        const link = document.createElement('a');
        link.href = `/api/books/${state.bookId}/chapters/${chapter.index}/export`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
      if (act === 'delete') {
        const ok = await confirmDialog({
          title: `删除第 ${chapter.index} 章？`,
          message: '这一章的正文会被删掉，后面的章节序号自动往前补。',
          detail: '这个操作没法撤销，建议先「导出这一本」留个底。',
          confirmText: '删除',
          danger: true,
        });
        if (!ok) return;
        const result = await api.post(`/api/books/${state.bookId}/chapters/delete`, { index: chapter.index });
        toast(result.message, 'ok');
        reload();
      }
    } catch (err) {
      toastError(err);
    }
  });
}

// ------------------------------------------------------------------ 目录质量

async function renderDiagnose(container, reload) {
  container.innerHTML = '<div class="loading">正在体检…</div>';
  try {
    const result = await api.get(`/api/books/${state.bookId}/diagnose`);
    state.diagnose = result;
    state.issueMap = new Map();
    for (const issue of result.issues) {
      if (!state.issueMap.has(issue.chapter_index)) state.issueMap.set(issue.chapter_index, issue);
    }
    if (!result.hasIssues) {
      container.innerHTML = '<div class="callout callout-ok"><p>目录看起来很干净：序号连续、没有重复标题、没有空章节。</p></div>';
    } else {
      container.innerHTML = `
        <div class="callout callout-warn">
          <p>${esc(result.verdict)}</p>
          <p class="panel-note">
            序号跳跃 ${result.summary.jump} · 标题重复 ${result.summary.duplicate} ·
            空章节 ${result.summary.empty} · 抓取失败 ${result.summary.failed} · 缺失 ${result.summary.missing}
          </p>
        </div>
        <ul class="issue-list">
          ${result.issues
            .slice(0, 100)
            .map(
              (issue) => `<li class="issue-item issue-${issue.level}">
                <span class="issue-tag">${esc(ISSUE_LABEL[issue.type] || issue.type)}</span>
                <span class="issue-text">${esc(issue.message)}</span>
                <span class="issue-hint">${esc(issue.hint)}</span>
              </li>`
            )
            .join('')}
        </ul>`;
    }
    if (state.list) {
      state.list.setItems(state.onlyIssues ? filterIssues(state.chapters) : state.chapters);
    }
    void reload;
  } catch (err) {
    container.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

function filterIssues(chapters) {
  if (!state.issueMap.size) return chapters;
  return chapters.filter((ch) => state.issueMap.has(ch.index));
}

async function renderDiff(container) {
  container.innerHTML = '<div class="loading">正在对比…</div>';
  try {
    const result = await api.get(`/api/books/${state.bookId}/diff`);
    if (!result.hasSnapshot) {
      container.innerHTML = `<div class="callout"><p>${esc(result.summary)}</p></div>`;
      return;
    }
    const rows = [];
    for (const item of result.added) {
      rows.push(`<li><span class="issue-tag issue-tag-new">新增</span>
        <span class="issue-text">第 ${item.index} 章 · ${esc(item.title)}（${item.char_count} 字）</span></li>`);
    }
    for (const item of result.revised) {
      rows.push(`<li><span class="issue-tag issue-tag-rev">修订</span>
        <span class="issue-text">第 ${item.index} 章 · ${esc(item.title)}${
        item.title_changed ? `（标题原来是「${esc(item.title_before)}」）` : ''
      }，${item.char_count_before} 字 → ${item.char_count} 字</span></li>`);
    }
    for (const item of result.removed) {
      rows.push(`<li><span class="issue-tag issue-tag-del">少了</span>
        <span class="issue-text">第 ${item.index} 章 · ${esc(item.title)}</span></li>`);
    }

    container.innerHTML = `
      <div class="callout ${result.added.length || result.revised.length ? 'callout-ok' : ''}">
        <p>${esc(result.summary)}</p>
        <p class="panel-note">对比基准：${esc(fmtDate(result.takenAt))} 时的目录快照。</p>
      </div>
      ${rows.length ? `<ul class="issue-list">${rows.join('')}</ul>` : ''}`;
  } catch (err) {
    container.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

async function openRechapterizeDialog(reload) {
  let rules = { rules: [], default: 'default' };
  try {
    rules = await api.get('/api/import/rules');
  } catch (err) {
    toastError(err);
    return;
  }

  const { openOverlay, esc: escapeHtml } = await import('../ui.js');
  const { panel, close } = openOverlay();
  panel.classList.add('rechapterize-panel');
  panel.innerHTML = `
    <h2 class="dialog-title">重新分章</h2>
    <p class="panel-note">
      做法是把现在每一章的「标题 + 正文」按顺序拼回一份完整文本，再用新规则重切一遍。
      所以多切几次也不会越切越碎。先预览，满意了再应用。
    </p>
    <div class="field-row">
      <label class="field">
        <span>分章规则</span>
        <select id="rcRule">
          ${rules.rules
            .map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.label)}</option>`)
            .join('')}
        </select>
      </label>
      <label class="field field-grow">
        <span>自定义正则（可选）</span>
        <input type="text" id="rcPattern" class="mono" placeholder="例如：^\\s*(第[0-9]+节)\\s*$" />
      </label>
    </div>
    <div id="rcResult"></div>
    <div class="dialog-actions">
      <button class="btn" id="rcCancel" type="button">取消</button>
      <button class="btn" id="rcPreview" type="button">预览</button>
      <button class="btn btn-primary" id="rcApply" type="button" disabled>确认重分</button>
    </div>`;

  document.getElementById('rcCancel').onclick = () => close();

  const buildPayload = () => ({
    rule_id: document.getElementById('rcPattern').value ? undefined : document.getElementById('rcRule').value,
    pattern: document.getElementById('rcPattern').value || undefined,
    limit: 60,
  });

  document.getElementById('rcPreview').onclick = async () => {
    const target = document.getElementById('rcResult');
    target.innerHTML = '<div class="loading">正在试切…</div>';
    try {
      const result = await api.post(`/api/books/${state.bookId}/rechapterize`, buildPayload());
      document.getElementById('rcApply').disabled = result.matched === 0;
      target.innerHTML = `
        <div class="callout ${result.matched ? 'callout-ok' : 'callout-warn'}">
          <p>现在 ${result.before} 章 → 重排后 ${result.after} 章。</p>
          <p class="panel-note">${escapeHtml(result.hint)}</p>
        </div>
        <ol class="chapter-preview">
          ${result.chapters
            .map(
              (ch) => `<li><span class="ch-index">${ch.index}</span>
                <span class="ch-title">${escapeHtml(ch.title)}</span>
                <span class="ch-count">${ch.char_count} 字</span>
                <span class="ch-sample">${escapeHtml(ch.preview || '')}</span></li>`
            )
            .join('')}
        </ol>`;
    } catch (err) {
      target.innerHTML = `<div class="callout callout-warn"><p>${escapeHtml(err.message)}</p>${
        err.hint ? `<p class="panel-note">${escapeHtml(err.hint)}</p>` : ''
      }</div>`;
    }
  };

  document.getElementById('rcApply').onclick = async () => {
    const ok = await confirmDialog({
      title: '确认重新分章？',
      message: '这本书的章节目录会被整体重排。',
      detail: '原来的目录会先存一份快照，方便你事后对照；正文内容本身不会丢。',
      confirmText: '确认重分',
    });
    if (!ok) return;
    try {
      const result = await api.post(`/api/books/${state.bookId}/rechapterize`, {
        ...buildPayload(),
        confirm: true,
      });
      close();
      toast(result.hint, 'ok', 4500);
      reload();
    } catch (err) {
      toastError(err);
    }
  };
}

// ------------------------------------------------------------------ 追更

/**
 * 追更区（模块 2）。
 * 关键点：这里只做"检查"，发现新章节只出角标和提示，**不会自动下载**；
 * 真正的下载要用户点「更新」走抓取链路。
 */
async function renderScheduleSection(container, book, reload) {
  if (!book.toc_url) {
    container.innerHTML = `
      <div class="callout">
        <p>这本书是导入进来的，没有目录页地址，所以没法检查更新。</p>
        <p class="panel-note">如果你知道它的目录页地址，可以在设置页给它填上，之后就能追更了。</p>
      </div>`;
    return;
  }

  container.innerHTML = '<div class="loading">正在读取追更设置…</div>';
  try {
    const status = await api.get('/api/fetch/schedule/status');
    const mine = status.books.find((b) => b.book_id === book.book_id) || {};

    container.innerHTML = `
      <div class="field-row">
        <label class="field">
          <span>检查频率</span>
          <select id="checkMode">
            ${status.checkModes
              .map(
                (mode) =>
                  `<option value="${esc(mode.mode)}" ${
                    mode.mode === (mine.check_mode || 'manual') ? 'selected' : ''
                  }>${esc(mode.label)}</option>`
              )
              .join('')}
          </select>
        </label>
        <button class="btn" id="btnCheckNow" type="button">立即检查一次</button>
        <span class="panel-note" id="checkInfo">
          上次检查：${mine.last_checked_at ? esc(fmtRelative(mine.last_checked_at)) : '还没检查过'} ·
          下次检查：${mine.next_check_at ? esc(fmtDate(mine.next_check_at)) : '不自动检查'}
        </span>
      </div>
      <div class="callout">
        <p>发现新章节只会出更新角标和提示，<strong>不会自动下载</strong>；点「更新」才会去抓。</p>
      </div>
      <div id="checkResult"></div>`;

    const modeSelect = document.getElementById('checkMode');
    modeSelect.onchange = async () => {
      try {
        const result = await api.put('/api/fetch/schedule', {
          book_ids: [book.book_id],
          mode: modeSelect.value,
        });
        toast(result.message, 'ok');
        updateCheckInfo(result.books[0]);
      } catch (err) {
        toastError(err);
      }
    };

    const updateCheckInfo = (item) => {
      const info = document.getElementById('checkInfo');
      if (!info) return;
      info.textContent =
        `上次检查：${item.last_checked_at ? fmtRelative(item.last_checked_at) : '还没检查过'} · ` +
        `下次检查：${item.next_check_at ? fmtDate(item.next_check_at) : '不自动检查'}`;
    };

    document.getElementById('btnCheckNow').onclick = async () => {
      const target = document.getElementById('checkResult');
      target.innerHTML = '<div class="loading">正在检查目录页…</div>';
      try {
        const result = await api.post('/api/fetch/schedule/check', { book_id: book.book_id });
        if (result.checked === false) {
          target.innerHTML = `<div class="callout callout-warn"><p>${esc(result.message)}</p></div>`;
          return;
        }
        updateCheckInfo(result);
        if (result.hasNew) {
          target.innerHTML = `
            <div class="callout callout-ok">
              <p>${esc(result.message)}</p>
              <p class="panel-note">${esc(result.hint || '')}</p>
              <ul class="issue-list">
                ${result.newChapters
                  .slice(0, 30)
                  .map(
                    (ch) => `<li class="issue-item"><span class="issue-tag issue-tag-new">新</span>
                      <span class="issue-text">第 ${ch.index} 章 · ${esc(ch.title)}</span></li>`
                  )
                  .join('')}
              </ul>
              <div class="panel-actions">
                <a class="btn btn-primary" href="#/fetch">去抓取控制台更新</a>
              </div>
            </div>`;
          await api.post('/api/notifications/read', {});
        } else if (result.titleChanges && result.titleChanges.length) {
          target.innerHTML = `
            <div class="callout callout-warn">
              <p>${esc(result.message)}</p>
              <p class="panel-note">另外有 ${result.titleChanges.length} 章的标题变了（内容可能也变了），可以在「更新对比」里看细节。</p>
            </div>`;
        } else {
          target.innerHTML = `<div class="callout callout-ok"><p>${esc(result.message)}</p></div>`;
        }
        void reload;
      } catch (err) {
        target.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
      }
    };
  } catch (err) {
    container.innerHTML = `<div class="callout callout-warn"><p>${esc(err.message)}</p></div>`;
  }
}

// ------------------------------------------------------------------ 页面

export async function render(params) {
  const view = document.getElementById('view');
  state.bookId = params.book_id;
  view.innerHTML = '<div class="loading">正在打开这本书…</div>';

  let book;
  let progress = null;
  let diagnose = null;
  try {
    book = await api.get(`/api/books/${encodeURIComponent(state.bookId)}`);
    progress = await api
      .get(`/api/reading/progress?book_id=${encodeURIComponent(state.bookId)}`)
      .catch(() => null);
    diagnose = await api.get(`/api/books/${encodeURIComponent(state.bookId)}/diagnose`).catch(() => null);
  } catch (err) {
    view.innerHTML = `
      <div class="empty-state">
        <h2>打不开这本书</h2>
        <p>${esc(err.message)}</p>
        ${err.hint ? `<p class="hint">${esc(err.hint)}</p>` : ''}
        <p><a class="btn" href="#/shelf">回到书架</a></p>
      </div>`;
    return;
  }

  state.book = book;
  state.chapters = book.chapters.map((ch) => ({
    ...ch,
    state: ch.is_ok ? '成功' : ch.fetched_at ? '失败' : '缺失',
  }));
  state.issueMap = new Map();
  if (diagnose) {
    state.diagnose = diagnose;
    for (const issue of diagnose.issues) {
      if (!state.issueMap.has(issue.chapter_index)) state.issueMap.set(issue.chapter_index, issue);
    }
  }

  const resumeIndex = progress && progress.position ? progress.position.chapter_index : 1;

  view.innerHTML = `
    <section class="book-page">
      <div class="page-head book-head">
        <div class="book-head-main">
          <h1 class="book-head-title">${esc(book.title)}</h1>
          <div class="book-head-meta">
            ${book.author ? `<span>${esc(book.author)}</span>` : ''}
            <span>共 ${book.total_chapters} 章</span>
            <span>已读 ${book.read_chapters} 章</span>
            <span class="state-tag">${esc(book.status)}</span>
            ${book.new_chapters > 0 ? `<span class="state-tag state-tag-warn">待更新 ${book.new_chapters} 章</span>` : ''}
            ${diagnose && diagnose.hasIssues ? `<span class="state-tag state-tag-warn">目录 ${diagnose.issues.length} 处异常</span>` : ''}
          </div>
          ${
            book.tags && book.tags.length
              ? `<div class="tag-row">${book.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div>`
              : ''
          }
        </div>
        <div class="book-head-actions">
          <a class="btn btn-primary" href="/reader.html?book=${encodeURIComponent(book.book_id)}&ch=${resumeIndex}">
            继续阅读
          </a>
          <button class="btn" id="btnRename" type="button">重命名</button>
          <button class="btn" id="btnExport" type="button">导出这一本</button>
          <button class="btn btn-danger" id="btnRemove" type="button">从书架移除</button>
        </div>
      </div>

      ${
        book.intro
          ? `<div class="panel"><h2 class="panel-title">简介</h2><p class="book-intro">${esc(book.intro)}</p></div>`
          : ''
      }

      <div class="panel">
        <h2 class="panel-title">来源信息</h2>
        <dl class="about-list">
          <dt>来源站点</dt><dd>${esc(book.source_site || '本机导入')}</dd>
          <dt>目录页</dt><dd class="mono">${esc(book.toc_url || '—')}</dd>
          <dt>首次抓取</dt><dd>${book.first_fetched_at ? esc(fmtDate(book.first_fetched_at)) : '—'}</dd>
          <dt>最后检查更新</dt><dd>${book.last_checked_at ? esc(fmtRelative(book.last_checked_at)) : '—'}</dd>
          <dt>加入时间</dt><dd>${esc(fmtDate(book.created_at))}</dd>
        </dl>
      </div>

      <div class="panel">
        <h2 class="panel-title">追更</h2>
        <div id="scheduleBox"><div class="loading">正在读取追更设置…</div></div>
      </div>

      <div class="panel">
        <div class="panel-head-row">
          <h2 class="panel-title">目录质量</h2>
          <div class="tool-actions">
            <button class="btn btn-sm" id="btnDiagnose" type="button">重新体检</button>
            <button class="btn btn-sm" id="btnDiff" type="button">更新对比</button>
            <button class="btn btn-sm" id="btnRechapterize" type="button">重新分章</button>
            <label class="check-inline"><input type="checkbox" id="onlyIssues" /> 只看异常</label>
          </div>
        </div>
        <div id="diagnoseResult"></div>
        <div id="diffResult"></div>
      </div>

      <div class="panel">
        <h2 class="panel-title">目录（${book.chapters.length} 章）</h2>
        <p class="panel-note">在某一章上点右键（或长按）可以改名、拆分、合并、重新抓取、导出、删除。</p>
        <div class="chapter-list" id="chapterList" role="list"></div>
      </div>
    </section>`;

  // -------------------------------------------------------------- 目录列表
  const list = new VirtualList(document.getElementById('chapterList'), {
    itemHeight: 42,
    renderItem: (chapter) => {
      const node = document.createElement('div');
      node.className = 'chapter-row';
      node.setAttribute('role', 'listitem');
      const issue = state.issueMap.get(chapter.index);
      const dotClass = issue
        ? issue.level === 'error'
          ? 'state-dot state-dot-error'
          : 'state-dot state-dot-warn'
        : 'state-dot';
      node.innerHTML = `
        <span class="chapter-index">${chapter.index}</span>
        <span class="chapter-name">${esc(chapter.title)}</span>
        ${issue ? `<span class="chapter-issue">${esc(ISSUE_LABEL[issue.type] || '')}</span>` : ''}
        <span class="chapter-count">${chapter.char_count} 字</span>
        <span class="${dotClass}"></span>
        <button class="chapter-more" type="button" title="更多操作">⋯</button>`;

      node.addEventListener('click', (event) => {
        if (event.target.closest('.chapter-more')) return;
        window.location.href = `/reader.html?book=${encodeURIComponent(state.bookId)}&ch=${chapter.index}`;
      });
      node.querySelector('.chapter-more').addEventListener('click', (event) => {
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        openChapterMenu(chapter, rect.left - 150, rect.bottom + 4, () => render(params));
      });
      node.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        openChapterMenu(chapter, event.clientX, event.clientY, () => render(params));
      });
      return node;
    },
  });
  state.list = list;
  list.setItems(state.chapters);
  if (state.chapters.length) {
    const at = Math.max(0, state.chapters.findIndex((c) => c.index === resumeIndex));
    list.setActive(at, { scrollIntoView: true });
  }
  state.list = list;

  const reload = () => render(params);

  // -------------------------------------------------------------- 追更
  await renderScheduleSection(document.getElementById('scheduleBox'), book, reload);

  // -------------------------------------------------------------- 目录质量
  const diagnoseContainer = document.getElementById('diagnoseResult');
  if (diagnose) {
    // 先用已有的体检结果直接渲染，避免进页面又等一下
    state.diagnose = diagnose;
    await renderDiagnose(diagnoseContainer, reload);
  } else {
    await renderDiagnose(diagnoseContainer, reload);
  }

  document.getElementById('btnDiagnose').onclick = () => renderDiagnose(diagnoseContainer, reload);
  document.getElementById('btnDiff').onclick = () => renderDiff(document.getElementById('diffResult'));
  document.getElementById('btnRechapterize').onclick = () => openRechapterizeDialog(reload);
  document.getElementById('onlyIssues').onchange = (event) => {
    state.onlyIssues = event.target.checked;
    list.setItems(state.onlyIssues ? filterIssues(state.chapters) : state.chapters);
  };

  // -------------------------------------------------------------- 头部动作
  document.getElementById('btnRename').onclick = async () => {
    const title = await promptDialog({ title: '重命名', label: '新的书名', value: book.title });
    if (!title) return;
    try {
      await api.patch(`/api/books/${book.book_id}`, { title });
      toast('书名已改好。', 'ok');
      reload();
    } catch (err) {
      toastError(err);
    }
  };

  document.getElementById('btnExport').onclick = () => {
    const link = document.createElement('a');
    link.href = `/api/books/${encodeURIComponent(book.book_id)}/export?format=txt`;
    link.download = `${book.title}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  document.getElementById('btnRemove').onclick = async () => {
    const ok = await confirmDialog({
      title: `把《${book.title}》从书架移除？`,
      message: '移除后书架上看不到这本书了。',
      detail: '正文文件不会删掉，会先放到 data/.trash 回收站里，将来还能找回。',
      confirmText: '移除',
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`/api/books/${encodeURIComponent(book.book_id)}?mode=trash`);
      toast('已从书架移除，正文放进了回收站。', 'ok');
      router.go('/shelf');
    } catch (err) {
      toastError(err);
    }
  };
}

export { state as bookState };
