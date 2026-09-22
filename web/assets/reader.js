/**
 * reader.js —— 阅读器（PRD 模块 5、6）。
 *
 * 这是"主战场"，所以把几个硬要求单独说明一下：
 *
 * 1. **按需加载，禁止整本渲染**（模块 5 硬指标）
 *    滚动模式下只保留「上一章 / 当前章 / 下一章」三块 DOM；滚动进入下一章时，
 *    补上再下一章、并卸掉最上面那一章（同时补偿 scrollTop，视觉上不跳）。
 *    前后各一章的正文会被预取进缓存，所以翻章不会有等待感。
 *
 * 2. **进度记忆（章号 + 章内偏移），节流 ≤ 每 2 秒一次**
 *    每次上报都同时写 char_offset 和 chapter_ratio：前者管"精确回位"，
 *    后者管"章内容变了以后还能按比例找回来"（PRD 流程 D）。
 *
 * 3. **切模式要停在原位置**
 *    切换前先记下 char_offset，重排之后再按偏移滚回去。
 */

import { api } from './api.js';
import {
  confirmDialog,
  esc,
  fmtDuration,
  fmtRelative,
  openOverlay,
  promptDialog,
  toast,
  toastError,
} from './ui.js';
import { VirtualList } from './virtual-list.js';

/** 进度上报的最小间隔（PRD：节流写入 ≤ 每 2 秒一次） */
const PROGRESS_THROTTLE_MS = 2000;
/** 阅读时长上报间隔 */
const SESSION_INTERVAL_MS = 60 * 1000;

const els = {};
const state = {
  bookId: '',
  book: null,
  toc: [],
  total: 0,
  settings: null,
  currentIndex: 1,
  /** 章正文缓存：index -> chapter payload */
  cache: new Map(),
  /** 当前渲染出来的章节块（滚动模式最多 3 块） */
  rendered: [],
  tocList: null,
  markTab: 'bookmarks',
  bookmarks: [],
  notes: [],
  /** 进度节流 */
  lastReportAt: 0,
  reportTimer: null,
  /** 程序性滚动期间不要上报进度，否则会把"正在恢复位置"当成用户操作记下来 */
  suppress: false,
  sessionMark: Date.now(),
  sessionTimer: null,
  pendingSelection: null,
  noteHighlights: new Map(),
};

const THEME_ORDER = ['day', 'night', 'eye'];
const THEME_LABEL = { day: '日间', night: '夜间', eye: '护眼' };

// ------------------------------------------------------------------ 工具

function qs(name) {
  return new URLSearchParams(location.search).get(name);
}

function $(id) {
  return document.getElementById(id);
}

/** 把正文切成段落，并记下每段在章节里的字符起点，供"章内偏移"换算 */
function buildBlocks(content) {
  const container = document.createElement('div');
  const blocks = [];
  let charStart = 0;
  for (const raw of String(content || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      charStart += line.length + 1;
      continue;
    }
    const p = document.createElement('p');
    p.textContent = line;
    container.appendChild(p);
    blocks.push({ el: p, start: charStart, len: line.length });
    charStart += line.length + 1;
  }
  if (!blocks.length) {
    const p = document.createElement('p');
    p.textContent = '（这一章没有正文内容）';
    container.appendChild(p);
    blocks.push({ el: p, start: 0, len: 0 });
  }
  return { container, blocks };
}

/**
 * 把一段文字里出现的搜索词标出来。
 * 只在单个文本节点内部替换，不去跨节点改写 —— 跨节点操作会破坏段落结构，
 * 后面算"章内偏移"就不准了。
 * @returns {number} 标出了多少处
 */
function highlightKeywordInElement(el, keyword) {
  if (!keyword) return 0;
  const needle = keyword.toLowerCase();
  let marked = 0;

  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  for (const node of textNodes) {
    const text = node.nodeValue || '';
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    let at = lower.indexOf(needle);
    while (at !== -1) {
      if (at > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, at)));
      const mark = document.createElement('mark');
      mark.className = 'search-hit';
      mark.textContent = text.slice(at, at + keyword.length);
      fragment.appendChild(mark);
      marked++;
      cursor = at + keyword.length;
      at = lower.indexOf(needle, cursor);
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
  }
  return marked;
}

// ------------------------------------------------------------------ 排版设置

function applySettings(settings) {
  state.settings = settings;
  const root = document.documentElement.style;
  root.setProperty('--reader-font-size', `${settings.fontSize}px`);
  root.setProperty('--reader-line-height', String(settings.lineHeight));
  root.setProperty('--reader-content-width', `${settings.contentWidth}px`);
  root.setProperty('--reader-indent', `${settings.indent}em`);

  document.body.dataset.theme = settings.theme;
  document.body.dataset.font = settings.fontFamily;
  document.body.dataset.mode = settings.mode;

  // 控件回显
  if (els.setFontSize) {
    els.setFontSize.value = String(settings.fontSize);
    els.outFontSize.textContent = settings.fontSize + ' px';
    els.setLineHeight.value = String(settings.lineHeight);
    els.outLineHeight.textContent = Number(settings.lineHeight).toFixed(2);
    els.setWidth.value = String(settings.contentWidth);
    els.outWidth.textContent = settings.contentWidth + ' px';
    els.setIndent.value = String(settings.indent);
    els.outIndent.textContent = settings.indent + ' 字';
    els.setFontFamily.value = settings.fontFamily;
  }
  for (const button of document.querySelectorAll('#themeSeg button')) {
    button.classList.toggle('is-on', button.dataset.theme === settings.theme);
  }
  for (const button of document.querySelectorAll('#modeSeg button')) {
    button.classList.toggle('is-on', button.dataset.mode === settings.mode);
  }
}

/** 改一项排版设置：立刻生效 + 全局保存（换书不用重设） */
async function updateSettings(patch, options = {}) {
  applySettings({ ...state.settings, ...patch });
  if (options.rerender) {
    // 版心/字体变化会影响换行，重新算一遍当前段落高度即可（浏览器会自动重排）
  }
  try {
    const saved = await api.put('/api/settings/reader', patch);
    state.settings = saved;
  } catch (err) {
    toastError(err);
  }
}

// ------------------------------------------------------------------ 章节窗口

async function fetchChapter(index) {
  if (state.cache.has(index)) return state.cache.get(index);
  const payload = await api.get(
    `/api/reader/${encodeURIComponent(state.bookId)}/chapters/${index}`
  );
  state.cache.set(index, payload);
  return payload;
}

/** 建一个章节块（标题 + 正文 + 章末分隔） */
function createUnit(payload) {
  const unit = { index: payload.index, title: payload.title, blocks: [], el: null };
  const root = document.createElement('section');
  root.className = 'chapter-unit';
  root.dataset.index = String(payload.index);

  const heading = document.createElement('h2');
  heading.className = 'chapter-heading';
  heading.textContent = payload.title;
  root.appendChild(heading);

  const { container, blocks } = buildBlocks(payload.missing ? '' : payload.content);
  unit.blocks = blocks;
  while (container.firstChild) root.appendChild(container.firstChild);

  if (payload.missing) {
    const warn = document.createElement('p');
    warn.className = 'chapter-end';
    warn.textContent = payload.note || '这一章的正文不在了。';
    root.appendChild(warn);
  }

  const end = document.createElement('p');
  end.className = 'chapter-end';
  end.textContent = payload.next ? '— 本章结束 —' : '— 全书完 —';
  root.appendChild(end);

  // 从检索页跳过来时带 q 参数：把这一章里所有命中的词标出来
  unit.hitCount = 0;
  if (state.keyword) {
    for (const block of blocks) {
      unit.hitCount += highlightKeywordInElement(block.el, state.keyword);
    }
  }

  unit.el = root;
  return unit;
}

/** 滚到当前章的第一处命中（从检索页跳进来时用） */
function scrollToFirstHit(unit) {
  if (!unit || !state.keyword) return false;
  const mark = unit.el.querySelector('mark.search-hit');
  if (!mark) return false;
  const scroller = els.scroller;
  const scrollerRect = scroller.getBoundingClientRect();
  const rect = mark.getBoundingClientRect();
  if (state.settings.mode === 'page') {
    scroller.scrollLeft += rect.left - scrollerRect.left;
  } else {
    scroller.scrollTop += rect.top - scrollerRect.top - 80;
  }
  return true;
}

/** 插到正确位置；如果插在视口上方，补偿 scrollTop，避免视觉跳动 */
function insertUnit(unit) {
  const scroller = els.scroller;
  const next = state.rendered.find((u) => u.index > unit.index);
  const beforeTop = next ? next.el.getBoundingClientRect().top : null;

  if (next) els.content.insertBefore(unit.el, next.el);
  else els.content.appendChild(unit.el);

  state.rendered.push(unit);
  state.rendered.sort((a, b) => a.index - b.index);

  if (beforeTop !== null) {
    const afterTop = next.el.getBoundingClientRect().top;
    scroller.scrollTop += afterTop - beforeTop;
  }
}

function removeUnit(unit) {
  const scroller = els.scroller;
  const rect = unit.el.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const above = rect.bottom <= scrollerRect.top;
  const height = rect.height;
  unit.el.remove();
  state.rendered = state.rendered.filter((u) => u !== unit);
  if (above) scroller.scrollTop -= height;
}

/**
 * 维护渲染窗口。
 * 滚动模式：上一章 / 当前章 / 下一章（PRD 明确要求"当前章及前后各一章"）。
 * 翻页模式：只保留当前章 —— 多列横排下跨章连排会让"翻到第几页"变得没法算。
 */
async function ensureWindow(aroundIndex) {
  const wants =
    state.settings.mode === 'page'
      ? [aroundIndex]
      : [aroundIndex - 1, aroundIndex, aroundIndex + 1].filter((i) => i >= 1 && i <= state.total);

  for (const unit of [...state.rendered]) {
    if (!wants.includes(unit.index)) removeUnit(unit);
  }

  for (const index of wants) {
    if (state.rendered.some((u) => u.index === index)) continue;
    // eslint-disable-next-line no-await-in-loop
    const payload = await fetchChapter(index);
    insertUnit(createUnit(payload));
  }

  // 预取前后各一章的正文，翻章时不用等网络
  if (state.settings.mode === 'scroll') {
    for (const index of [aroundIndex - 2, aroundIndex + 2]) {
      if (index >= 1 && index <= state.total && !state.cache.has(index)) {
        fetchChapter(index).catch(() => {});
      }
    }
  }
}

// ------------------------------------------------------------------ 位置读写

/** 取当前"正在读"的位置：章节序号 + 章内字符偏移 + 章内比例 */
function readPosition() {
  const scroller = els.scroller;
  const scrollerRect = scroller.getBoundingClientRect();
  let best = null;
  let bestUnit = null;
  let bestScore = Infinity;

  for (const unit of state.rendered) {
    for (const block of unit.blocks) {
      const rect = block.el.getBoundingClientRect();
      if (rect.bottom <= scrollerRect.top + 2) continue; // 已经滚过去了
      if (rect.right <= scrollerRect.left + 2) continue; // 翻页模式下已经翻过
      if (rect.left >= scrollerRect.right) continue; // 太靠右
      // 排序键：先看横向位置（翻页模式是页序），再看纵向位置
      const score = Math.round(rect.left) * 1e6 + Math.round(rect.top);
      if (score < bestScore) {
        bestScore = score;
        best = block;
        bestUnit = unit;
      }
    }
  }

  if (!best || !bestUnit) {
    return { chapterIndex: state.currentIndex, offset: 0, ratio: 0 };
  }

  const rect = best.el.getBoundingClientRect();
  const dy = Math.max(0, scrollerRect.top - rect.top);
  const within = rect.height > 0 ? Math.min(1, dy / rect.height) : 0;
  const offset = Math.min(best.len, Math.round(best.start + within * best.len));
  const ratio = bestUnit.blocks.length
    ? Math.min(1, offset / Math.max(1, bestUnit.blocks[bestUnit.blocks.length - 1].start + bestUnit.blocks[bestUnit.blocks.length - 1].len))
    : 0;

  return { chapterIndex: bestUnit.index, offset, ratio };
}

/** 滚到章内某个字符偏移处（偏差不超过一段） */
function scrollToOffset(unit, offset) {
  if (!unit || !unit.blocks.length) return;
  let target = unit.blocks[unit.blocks.length - 1];
  for (const block of unit.blocks) {
    if (offset >= block.start && offset < block.start + Math.max(1, block.len)) {
      target = block;
      break;
    }
  }
  const scroller = els.scroller;
  const scrollerRect = scroller.getBoundingClientRect();
  const rect = target.el.getBoundingClientRect();
  const within = target.len > 0 ? Math.min(1, Math.max(0, (offset - target.start) / target.len)) : 0;

  if (state.settings.mode === 'page') {
    scroller.scrollLeft += rect.left - scrollerRect.left;
  } else {
    scroller.scrollTop += rect.top - scrollerRect.top + within * rect.height - 8;
  }
}

// ------------------------------------------------------------------ 进度上报

function scheduleProgress(immediate = false) {
  if (state.suppress) return;
  const now = Date.now();
  const elapsed = now - state.lastReportAt;

  if (immediate || elapsed >= PROGRESS_THROTTLE_MS) {
    flushProgress();
    return;
  }
  if (state.reportTimer) return;
  // 尾部补一次：保证停下来之后最终位置一定会被记下来
  state.reportTimer = setTimeout(() => {
    state.reportTimer = null;
    flushProgress();
  }, PROGRESS_THROTTLE_MS - elapsed);
}

function currentPayload(position) {
  const pos = position || readPosition();
  const percent = state.total > 0 ? Math.min(1, (pos.chapterIndex - 1 + pos.ratio) / state.total) : 0;
  return {
    book_id: state.bookId,
    chapter_index: pos.chapterIndex,
    char_offset: pos.offset,
    chapter_ratio: pos.ratio,
    percent,
  };
}

function flushProgress() {
  if (state.suppress || !state.bookId) return;
  const payload = currentPayload();
  state.lastReportAt = Date.now();
  api.post('/api/reading/progress', payload).catch(() => {
    /* 进度没写上去不算致命，下一次滚动还会再报 */
  });
  state.currentIndex = payload.chapter_index;
  updateStatus(payload);
}

/** 关页面前把最后的位置钉死（keepalive 保证请求真的发得出去） */
function flushProgressBeacon() {
  if (!state.bookId) return;
  const payload = currentPayload();
  try {
    fetch('/api/reading/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (err) {
    /* 关页面前尽力而为 */
  }
}

function reportSession(force = false) {
  const now = Date.now();
  const ms = now - state.sessionMark;
  if (!state.bookId || ms < 3000) {
    if (force) state.sessionMark = now;
    return;
  }
  state.sessionMark = now;
  try {
    fetch('/api/reading/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        book_id: state.bookId,
        started_at: new Date(now - ms).toISOString(),
        ended_at: new Date(now).toISOString(),
        duration_ms: ms,
      }),
      keepalive: true,
    });
  } catch (err) {
    /* 时长统计丢一小段没关系 */
  }
}

function updateStatus(payload) {
  if (!els.readerStatus) return;
  const percent = Math.round((payload.percent || 0) * 1000) / 10;
  els.readerStatus.textContent = `第 ${payload.chapter_index} / ${state.total} 章 · 全书 ${percent}%`;
  if (els.readerProgressMini) {
    els.readerProgressMini.textContent = `${payload.chapter_index}/${state.total}`;
  }
}

// ------------------------------------------------------------------ 章节跳转

async function gotoChapter(index, options = {}) {
  const target = Math.max(1, Math.min(state.total, Math.round(index)));
  state.suppress = true;
  try {
    await ensureWindow(target);
    const unit = state.rendered.find((u) => u.index === target);
    if (unit) scrollToOffset(unit, options.offset || 0);
    state.currentIndex = target;
    els.content.querySelectorAll('.chapter-unit').forEach((el) => {
      el.classList.toggle('is-current', Number(el.dataset.index) === target);
    });
    if (state.tocList) {
      const at = state.toc.findIndex((c) => c.index === target);
      if (at >= 0) state.tocList.setActive(at, { scrollIntoView: true });
    }
    if (options.pushHistory !== false) pushHistory(target, options.offset || 0);
  } finally {
    // 让程序性滚动的事件先跑完，再打开上报开关
    setTimeout(() => {
      state.suppress = false;
      scheduleProgress(true);
    }, 60);
  }
}

async function pushHistory(index, offset) {
  try {
    await api.post('/api/reading/history', {
      book_id: state.bookId,
      chapter_index: index,
      char_offset: offset || 0,
      chapter_title: (state.toc.find((c) => c.index === index) || {}).title || '',
    });
  } catch (err) {
    /* 历史是辅助功能，失败不打断阅读 */
  }
}

// ------------------------------------------------------------------ 书签 / 笔记

async function addBookmark() {
  try {
    const pos = readPosition();
    const result = await api.post('/api/bookmarks', {
      book_id: state.bookId,
      chapter_index: pos.chapterIndex,
      char_offset: pos.offset,
      chapter_ratio: pos.ratio,
      selected_text: '',
    });
    toast(result.message || '书签已加上。', 'ok');
    await loadMarks();
  } catch (err) {
    toastError(err);
  }
}

async function loadMarks() {
  try {
    const [bookmarks, notes] = await Promise.all([
      api.get(`/api/bookmarks?book_id=${encodeURIComponent(state.bookId)}`),
      api.get(`/api/notes?book_id=${encodeURIComponent(state.bookId)}`),
    ]);
    state.bookmarks = bookmarks.bookmarks;
    state.notes = notes.notes;
    if (state.markTab) paintMarks();
  } catch (err) {
    toastError(err);
  }
}

function chapterTitle(index) {
  const found = state.toc.find((c) => c.index === index);
  return found ? found.title : `第 ${index} 章`;
}

function paintMarks() {
  const body = els.markBody;
  if (!body) return;

  if (state.markTab === 'bookmarks') {
    if (!state.bookmarks.length) {
      body.innerHTML = '<div class="drawer-empty">还没有书签。读到想记住的地方按 B，或者在顶栏点「加书签」。</div>';
      return;
    }
    body.innerHTML = state.bookmarks
      .map(
        (b) => `
        <div class="mark-item" data-kind="bookmark" data-id="${esc(b.id)}" data-ch="${b.chapter_index}" data-off="${b.char_offset}">
          <div class="mark-item-head">
            <span>${esc(chapterTitle(b.chapter_index))}</span>
            <span>${esc(fmtRelative(b.created_at))}</span>
          </div>
          ${b.content ? `<p class="mark-item-note">${esc(b.content)}</p>` : ''}
          <div class="mark-item-actions">
            <button type="button" data-act="jump">跳回这里</button>
            <button type="button" data-act="edit">改备注</button>
            <button type="button" data-act="delete">删除</button>
          </div>
        </div>`
      )
      .join('');
    return;
  }

  if (state.markTab === 'notes') {
    if (!state.notes.length) {
      body.innerHTML = '<div class="drawer-empty">还没有笔记。选中正文中的一句话，点浮出来的「划线写备注」就能记下来。</div>';
      return;
    }
    body.innerHTML = state.notes
      .map(
        (n) => `
        <div class="mark-item" data-kind="note" data-id="${esc(n.id)}" data-ch="${n.chapter_index}" data-off="${n.char_offset}">
          <div class="mark-item-head">
            <span>${esc(chapterTitle(n.chapter_index))}</span>
            <span>${esc(fmtRelative(n.created_at))}</span>
          </div>
          ${n.selected_text ? `<p class="mark-item-quote">${esc(n.selected_text)}</p>` : ''}
          <p class="mark-item-note">${esc(n.content)}</p>
          <div class="mark-item-actions">
            <button type="button" data-act="jump">跳回这里</button>
            <button type="button" data-act="edit">改备注</button>
            <button type="button" data-act="delete">删除</button>
          </div>
        </div>`
      )
      .join('');
    return;
  }

  body.innerHTML = '<div class="loading">正在读取跳章历史…</div>';
  api
    .get(`/api/reading/history?book_id=${encodeURIComponent(state.bookId)}&limit=50`)
    .then((entries) => {
      if (!entries.length) {
        body.innerHTML = '<div class="drawer-empty">还没有跳章记录。用「返回上一处」按钮可以像浏览器后退一样跳回来。</div>';
        return;
      }
      body.innerHTML =
        `<div class="mark-item"><div class="mark-item-actions">
           <button type="button" id="btnHistoryBack">返回上一处</button>
         </div></div>` +
        entries
          .map(
            (e, i) => `
          <div class="mark-item" data-kind="history" data-ch="${e.chapter_index}" data-off="${e.char_offset}">
            <div class="mark-item-head"><span>第 ${i + 1} 近</span><span>${esc(fmtRelative(e.at))}</span></div>
            <p class="mark-item-note">${esc(e.chapter_title || chapterTitle(e.chapter_index))}</p>
            <div class="mark-item-actions"><button type="button" data-act="jump">跳到这里</button></div>
          </div>`
          )
          .join('');

      const backBtn = document.getElementById('btnHistoryBack');
      if (backBtn) {
        backBtn.onclick = async () => {
          try {
            const result = await api.post('/api/reading/history', { book_id: state.bookId, action: 'back' });
            if (!result.entry) {
              toast(result.message || '没有更早的记录了。', 'warn');
              return;
            }
            await gotoChapter(result.entry.chapter_index, { offset: result.entry.char_offset, pushHistory: false });
            toast('已经回到上一处。', 'ok');
          } catch (err) {
            toastError(err);
          }
        };
      }
    })
    .catch((err) => {
      body.innerHTML = `<div class="drawer-empty">${esc(err.message)}</div>`;
    });
}

async function handleMarkAction(event) {
  const button = event.target.closest('button[data-act]');
  const item = event.target.closest('.mark-item');
  if (!item || !button) return;
  const kind = item.dataset.kind;
  const id = item.dataset.id;
  const chapter = Number(item.dataset.ch);
  const offset = Number(item.dataset.off);
  const act = button.dataset.act;

  try {
    if (act === 'jump') {
      await gotoChapter(chapter, { offset });
      toast('已跳到标记的位置。', 'ok');
      return;
    }
    if (act === 'edit') {
      const current = kind === 'bookmark' ? state.bookmarks : state.notes;
      const found = current.find((x) => x.id === id);
      const content = await promptDialog({
        title: kind === 'bookmark' ? '书签备注' : '笔记内容',
        label: '写点什么',
        value: (found && found.content) || '',
        confirmText: '保存',
      });
      if (content === null) return;
      if (kind === 'bookmark') await api.patch(`/api/bookmarks/${id}`, { content });
      else await api.patch(`/api/notes/${id}`, { content });
      await loadMarks();
      toast('已保存。', 'ok');
      return;
    }
    if (act === 'delete') {
      const ok = await confirmDialog({
        title: kind === 'bookmark' ? '删除这个书签？' : '删除这条笔记？',
        message: '删掉之后就找不回来了。',
        confirmText: '删除',
        danger: true,
      });
      if (!ok) return;
      if (kind === 'bookmark') await api.del(`/api/bookmarks/${id}`);
      else await api.del(`/api/notes/${id}`);
      await loadMarks();
      toast('已删除。', 'ok');
    }
  } catch (err) {
    toastError(err);
  }
}

/** 选中正文 → 悬浮小工具 */
function wireSelection() {
  const tools = els.selectionTools;
  const scroller = els.scroller;

  const hide = () => {
    tools.hidden = true;
    state.pendingSelection = null;
  };

  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      hide();
      return;
    }
    const range = selection.getRangeAt(0);
    if (!els.content.contains(range.commonAncestorContainer)) {
      hide();
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      hide();
      return;
    }
    state.pendingSelection = { range: range.cloneRange(), text };
    const rect = range.getBoundingClientRect();
    tools.hidden = false;
    const top = Math.max(60, rect.top - 48);
    tools.style.left = `${Math.min(rect.left, window.innerWidth - 240)}px`;
    tools.style.top = `${top}px`;
  });

  scroller.addEventListener('scroll', () => {
    if (!tools.hidden) hide();
  });
}

/** 在单段内加视觉标记；跨段选中只存笔记不做高亮（避免把 DOM 拆坏） */
function highlightSelection(range, noteId) {
  try {
    if (range.startContainer !== range.endContainer) return false;
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return false;
    const span = document.createElement('mark');
    span.className = 'note-mark';
    span.dataset.noteId = noteId;
    range.surroundContents(span);
    return true;
  } catch (err) {
    return false;
  }
}

async function makeNoteFromSelection() {
  const pending = state.pendingSelection;
  if (!pending) return;
  try {
    const content = await promptDialog({
      title: '写条备注',
      label: `摘录：${pending.text.slice(0, 40)}${pending.text.length > 40 ? '…' : ''}`,
      value: '',
      confirmText: '保存笔记',
    });
    if (!content) return;

    const unit = state.rendered.find((u) => u.el.contains(pending.range.startContainer));
    const chapterIndex = unit ? unit.index : state.currentIndex;
    let offset = 0;
    if (unit) {
      const block = unit.blocks.find((b) => b.el.contains(pending.range.startContainer));
      if (block) offset = block.start;
    }

    const note = await api.post('/api/notes', {
      book_id: state.bookId,
      chapter_index: chapterIndex,
      char_offset: offset,
      selected_text: pending.text,
      content,
    });
    highlightSelection(pending.range, note.id);
    await loadMarks();
    toast('笔记已保存。', 'ok');
  } catch (err) {
    toastError(err);
  } finally {
    state.pendingSelection = null;
    els.selectionTools.hidden = true;
  }
}

// ------------------------------------------------------------------ 目录抽屉

function buildToc() {
  state.tocList = new VirtualList(els.tocList, {
    itemHeight: 44,
    renderItem: (chapter, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'toc-row';
      row.innerHTML = `<span class="toc-index">${chapter.index}</span>
        <span class="toc-title">${esc(chapter.title)}</span>`;
      row.onclick = () => {
        els.tocDrawer.hidden = true;
        gotoChapter(chapter.index, { pushHistory: true });
      };
      row.dataset.tocIndex = String(i);
      return row;
    },
  });
  state.tocList.setItems(state.toc);
  const at = state.toc.findIndex((c) => c.index === state.currentIndex);
  if (at >= 0) state.tocList.setActive(at, { scrollIntoView: true });
}

function wireTocSearch() {
  els.tocSearch.oninput = () => {
    const keyword = els.tocSearch.value.trim().toLowerCase();
    if (!keyword) {
      state.tocList.setItems(state.toc);
      return;
    }
    const filtered = state.toc.filter((c) => String(c.title).toLowerCase().includes(keyword));
    state.tocList.setItems(filtered.length ? filtered : state.toc);
  };
  els.tocSearch.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    // 输入的是纯数字就直接按章节号跳（PRD：支持按章节号定位）
    const index = Number(els.tocSearch.value.trim());
    if (Number.isFinite(index) && index >= 1 && index <= state.total) {
      els.tocDrawer.hidden = true;
      gotoChapter(index);
    }
  };
}

// ------------------------------------------------------------------ 翻页

/**
 * 翻一页（左右翻页模式）。
 * 因为列宽 = 滚动区宽 - 间隙、列间距 = 间隙，所以一页的步长正好等于滚动区宽。
 */
async function turnPage(direction) {
  const scroller = els.scroller;
  const step = scroller.clientWidth;
  const before = scroller.scrollLeft;
  scroller.scrollLeft = before + direction * step;

  // 到本章末尾还往后翻 → 进下一章；在最开头往前翻 → 回上一章
  const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - 4;
  const atStart = scroller.scrollLeft <= 2;
  if (direction > 0 && atEnd) {
    if (state.currentIndex < state.total) {
      await gotoChapter(state.currentIndex + 1, { offset: 0 });
    } else {
      scroller.scrollLeft = before;
      toast('已经是最后一章了。', 'info');
    }
    return;
  }
  if (direction < 0 && atStart) {
    if (state.currentIndex > 1) {
      // 回上一章时落到末尾，衔接上"往回翻"的直觉
      const prev = state.currentIndex - 1;
      await gotoChapter(prev, { offset: Number.MAX_SAFE_INTEGER });
    } else {
      scroller.scrollLeft = before;
      toast('已经是第一章了。', 'info');
    }
    return;
  }
  scheduleProgress();
}

// ------------------------------------------------------------------ 快捷键

function cycleTheme() {
  const at = THEME_ORDER.indexOf(state.settings.theme);
  const next = THEME_ORDER[(at + 1) % THEME_ORDER.length];
  updateSettings({ theme: next });
  toast(`主题：${THEME_LABEL[next]}`, 'info', 1600);
}

async function toggleFocus() {
  const on = document.body.dataset.focus === 'on';
  document.body.dataset.focus = on ? 'off' : 'on';
  // 沉浸状态下顺手进系统全屏，阅读区能更大
  try {
    if (!on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
    else if (on && document.fullscreenElement) await document.exitFullscreen();
  } catch (err) {
    /* 用户可能禁用了全屏，忽略即可 */
  }
}

function wireShortcuts() {
  document.addEventListener('keydown', async (event) => {
    const tag = (event.target && event.target.tagName) || '';
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
    if (event.metaKey || event.ctrlKey) return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        gotoChapter(state.currentIndex - 1, { offset: 0 });
        return;
      case 'ArrowRight':
        event.preventDefault();
        gotoChapter(state.currentIndex + 1, { offset: 0 });
        return;
      case ' ':
      case 'PageDown':
        event.preventDefault();
        if (state.settings.mode === 'page') turnPage(1);
        else els.scroller.scrollTop += els.scroller.clientHeight * 0.9;
        return;
      case 'PageUp':
        event.preventDefault();
        if (state.settings.mode === 'page') turnPage(-1);
        else els.scroller.scrollTop -= els.scroller.clientHeight * 0.9;
        return;
      case 't':
      case 'T':
        cycleTheme();
        return;
      case '+':
      case '=':
        updateSettings({ fontSize: Math.min(40, state.settings.fontSize + 1) });
        return;
      case '-':
      case '_':
        updateSettings({ fontSize: Math.max(12, state.settings.fontSize - 1) });
        return;
      case 'f':
      case 'F':
        toggleFocus();
        return;
      case 'b':
      case 'B':
        addBookmark();
        return;
      case 'c':
      case 'C':
        els.tocDrawer.hidden = !els.tocDrawer.hidden;
        return;
      case 'Escape':
        if (els.tocDrawer.hidden === false) els.tocDrawer.hidden = true;
        else if (els.markDrawer.hidden === false) els.markDrawer.hidden = true;
        else if (document.body.dataset.focus === 'on') toggleFocus();
        return;
      default:
        return;
    }
  });
}

// ------------------------------------------------------------------ 交互装配

function wireUi() {
  $('btnBackShelf').onclick = (event) => {
    event.preventDefault();
    // 回书架前把进度与时长钉死，避免"刚读的这一段没记上"
    flushProgressBeacon();
    reportSession(true);
    location.href = '/#/shelf';
  };

  $('btnToc').onclick = () => {
    els.tocDrawer.hidden = !els.tocDrawer.hidden;
  };
  $('btnTocClose').onclick = () => {
    els.tocDrawer.hidden = true;
  };
  $('btnBookmark').onclick = () => addBookmark();
  $('btnPanel').onclick = async () => {
    els.markDrawer.hidden = !els.markDrawer.hidden;
    if (!els.markDrawer.hidden) await loadMarks();
  };
  $('btnMarkClose').onclick = () => {
    els.markDrawer.hidden = true;
  };
  $('btnTypo').onclick = () => {
    els.typoBar.hidden = !els.typoBar.hidden;
  };
  $('btnFocus').onclick = () => toggleFocus();

  $('btnPrevChapter').onclick = () => gotoChapter(state.currentIndex - 1, { offset: 0 });
  $('btnNextChapter').onclick = () => gotoChapter(state.currentIndex + 1, { offset: 0 });
  $('btnTop').onclick = () => {
    if (state.settings.mode === 'page') els.scroller.scrollTo({ left: 0, behavior: 'smooth' });
    else els.scroller.scrollTo({ top: 0, behavior: 'smooth' });
    scheduleProgress(true);
  };
  $('btnBottom').onclick = () => {
    if (state.settings.mode === 'page') {
      els.scroller.scrollTo({ left: els.scroller.scrollWidth, behavior: 'smooth' });
    } else {
      els.scroller.scrollTo({ top: els.scroller.scrollHeight, behavior: 'smooth' });
    }
    scheduleProgress(true);
  };

  $('pagePrev').onclick = () => turnPage(-1);
  $('pageNext').onclick = () => turnPage(1);

  $('btnMakeNote').onclick = () => makeNoteFromSelection();
  $('btnCopySelection').onclick = async () => {
    const pending = state.pendingSelection;
    if (!pending) return;
    try {
      await navigator.clipboard.writeText(pending.text);
      toast('已经复制。', 'ok', 1500);
    } catch (err) {
      toast('浏览器不允许自动复制，请用 Ctrl+C。', 'warn');
    }
    els.selectionTools.hidden = true;
  };

  els.markBody.addEventListener('click', handleMarkAction);

  for (const button of document.querySelectorAll('#markSeg button')) {
    button.onclick = () => {
      state.markTab = button.dataset.tab;
      for (const other of document.querySelectorAll('#markSeg button')) {
        other.classList.toggle('is-on', other === button);
      }
      paintMarks();
    };
  }
  document.querySelector('#markSeg button[data-tab="bookmarks"]').classList.add('is-on');

  // 排版条
  els.setFontSize.oninput = () => {
    els.outFontSize.textContent = els.setFontSize.value + ' px';
  };
  els.setFontSize.onchange = () => updateSettings({ fontSize: Number(els.setFontSize.value) });
  els.setLineHeight.oninput = () => {
    els.outLineHeight.textContent = Number(els.setLineHeight.value).toFixed(2);
  };
  els.setLineHeight.onchange = () => updateSettings({ lineHeight: Number(els.setLineHeight.value) });
  els.setWidth.oninput = () => {
    els.outWidth.textContent = els.setWidth.value + ' px';
  };
  els.setWidth.onchange = () => updateSettings({ contentWidth: Number(els.setWidth.value) });
  els.setIndent.oninput = () => {
    els.outIndent.textContent = els.setIndent.value + ' 字';
  };
  els.setIndent.onchange = () => updateSettings({ indent: Number(els.setIndent.value) });
  els.setFontFamily.onchange = () => updateSettings({ fontFamily: els.setFontFamily.value });

  for (const button of document.querySelectorAll('#themeSeg button')) {
    button.onclick = () => updateSettings({ theme: button.dataset.theme });
  }
  for (const button of document.querySelectorAll('#modeSeg button')) {
    button.onclick = async () => {
      if (button.dataset.mode === state.settings.mode) return;
      // 切模式要停在原位置：先记偏移，重排之后再滚回去
      const pos = readPosition();
      await updateSettings({ mode: button.dataset.mode });
      state.rendered = [];
      els.content.innerHTML = '';
      state.suppress = true;
      await ensureWindow(pos.chapterIndex);
      const unit = state.rendered.find((u) => u.index === pos.chapterIndex);
      if (unit) scrollToOffset(unit, pos.offset);
      state.currentIndex = pos.chapterIndex;
      setTimeout(() => {
        state.suppress = false;
      }, 80);
      toast('已经切换阅读模式，位置保持在原处。', 'ok', 2000);
    };
  }

  // 滚动：驱动"章节窗口"的滑动与进度上报
  let scrollTick = null;
  els.scroller.addEventListener(
    'scroll',
    () => {
      scheduleProgress();
      if (scrollTick) return;
      scrollTick = setTimeout(async () => {
        scrollTick = null;
        const pos = readPosition();
        if (pos.chapterIndex !== state.currentIndex) {
          state.currentIndex = pos.chapterIndex;
          updateStatus(currentPayload(pos));
          await ensureWindow(pos.chapterIndex);
          if (state.tocList) {
            const at = state.toc.findIndex((c) => c.index === pos.chapterIndex);
            if (at >= 0) state.tocList.setActive(at, { scrollIntoView: true });
          }
          pushHistory(pos.chapterIndex, pos.offset);
        }
      }, 220);
    },
    { passive: true }
  );

  // 关闭页面前把进度与时长钉死
  window.addEventListener('beforeunload', () => {
    flushProgressBeacon();
    reportSession(true);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushProgressBeacon();
      reportSession(true);
    } else {
      state.sessionMark = Date.now();
    }
  });
  state.sessionTimer = setInterval(() => reportSession(false), SESSION_INTERVAL_MS);

  // 翻页模式用键盘方向键之外的翻页（点热区已经接好）
  wireShortcuts();
  wireSelection();
}

// ------------------------------------------------------------------ 启动

async function main() {
  els.scroller = $('readerScroller');
  els.content = $('readerContent');
  els.typoBar = $('typoBar');
  els.tocDrawer = $('tocDrawer');
  els.tocList = $('tocList');
  els.tocSearch = $('tocSearch');
  els.markDrawer = $('markDrawer');
  els.markBody = $('markBody');
  els.selectionTools = $('selectionTools');
  els.readerStatus = $('readerStatus');
  els.readerProgressMini = $('readerProgressMini');
  els.setFontSize = $('setFontSize');
  els.outFontSize = $('outFontSize');
  els.setLineHeight = $('setLineHeight');
  els.outLineHeight = $('outLineHeight');
  els.setWidth = $('setWidth');
  els.outWidth = $('outWidth');
  els.setIndent = $('setIndent');
  els.outIndent = $('outIndent');
  els.setFontFamily = $('setFontFamily');

  state.bookId = qs('book') || '';
  state.keyword = qs('q') || '';
  if (!state.bookId) {
    els.content.innerHTML =
      '<div class="drawer-empty">没有指定要读哪本书。<br /><br /><a class="btn" href="/">回到书架</a></div>';
    return;
  }

  let boot;
  try {
    boot = await api.get(`/api/reader/${encodeURIComponent(state.bookId)}/bootstrap`);
  } catch (err) {
    els.content.innerHTML = `<div class="drawer-empty">${esc(err.message)}${
      err.hint ? `<br /><br />${esc(err.hint)}` : ''
    }<br /><br /><a class="btn" href="/">回到书架</a></div>`;
    return;
  }

  state.book = boot.book;
  state.toc = boot.toc;
  state.total = boot.total_chapters || boot.toc.length;
  document.title = `阅读 · ${boot.book.title}`;
  $('readerBookTitle').textContent = boot.book.title;

  applySettings(boot.settings);
  buildToc();
  wireTocSearch();
  wireUi();

  // 入口章号：URL 里带 ch 就用它（详情页点章节进来就是这条路），
  // 否则用服务端算好的"上次读到哪儿"
  const fromUrl = Number(qs('ch'));
  const entry = Number.isFinite(fromUrl) && fromUrl >= 1 && fromUrl <= state.total ? fromUrl : boot.position.chapter_index;
  const entryOffset =
    Number.isFinite(fromUrl) && fromUrl === boot.position.chapter_index ? boot.position.char_offset : 0;

  if (boot.position.note && boot.position.mode !== 'fresh') {
    toast(boot.position.note, 'info', 4200);
  }

  await gotoChapter(entry, { offset: entryOffset, pushHistory: false });
  updateStatus(currentPayload({ chapterIndex: entry, offset: entryOffset, ratio: boot.position.chapter_ratio || 0 }));

  // 从检索页跳进来：直接停在第一处命中上，并说明本章命中多少处
  if (state.keyword) {
    const unit = state.rendered.find((u) => u.index === entry);
    setTimeout(() => {
      const hit = scrollToFirstHit(unit);
      if (hit) {
        toast(`搜索「${state.keyword}」：本章标出 ${unit.hitCount} 处。`, 'info', 3600);
      } else {
        toast(`这一章没有「${state.keyword}」，可以继续翻章找。`, 'warn', 3600);
      }
    }, 120);
  }

  // 首次进入就把位置记下来，这样"读到某处直接关浏览器"也不丢
  flushProgress();
}

main().catch((err) => {
  console.error(err);
  const content = document.getElementById('readerContent');
  if (content) {
    content.innerHTML = `<div class="drawer-empty">阅读器没能启动。<br /><br />${esc(
      err && err.message ? err.message : '未知问题'
    )}<br /><br /><a class="btn" href="/">回到书架</a></div>`;
  }
});
