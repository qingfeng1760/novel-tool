/**
 * views/search.js —— 全文检索与筛选页（模块 8）。
 *
 * 页面有三块：
 *   1. 找内容：输入关键词，全库或全书内搜索，结果是「书名 · 章节 · 命中次数」+ 前后文片段；
 *      点一条直接跳到阅读器的那个位置并高亮（带 q 参数）。
 *   2. 筛书：按状态 / 标签 / 来源站点 / 作者叠加筛选。
 *   3. 重名书：检测书名 + 作者高度相似的书，可选择合并（保留章节多的那份）。
 */

import { api, qs } from '../api.js';
import { router } from '../router.js';
import { confirmDialog, esc, toast, toastError } from '../ui.js';

const state = {
  q: '',
  scope: 'library',
  bookId: '',
  results: null,
  filter: { status: '', tag: '', site: '', author: '' },
  options: null,
  filtered: null,
  duplicates: null,
  tab: 'content',
};

/** 把片段里命中的关键词标出来 */
function snippetHtml(snippet, keyword) {
  const text = String(snippet.text || '');
  const at = Number(snippet.offset_in_snippet) || 0;
  const before = text.slice(0, at);
  const hit = text.slice(at, at + keyword.length);
  const after = text.slice(at + keyword.length);
  return (
    `${snippet.prefix_trimmed ? '…' : ''}${esc(before)}<mark class="hit">${esc(hit)}</mark>${esc(after)}${
      snippet.suffix_trimmed ? '…' : ''
    }`
  );
}

function readerHref(bookId, chapterIndex, keyword) {
  return `/reader.html?book=${encodeURIComponent(bookId)}&ch=${chapterIndex}&q=${encodeURIComponent(keyword)}`;
}

function renderResults() {
  const container = document.getElementById('searchResults');
  if (!container) return;

  if (!state.results) {
    container.innerHTML = '<div class="search-empty">在上面输入一个词，就能在整库的书里找到它出现的每一处。</div>';
    return;
  }

  const { results, totalHits, matchedBooks, hint, q } = state.results;
  if (!results.length) {
    container.innerHTML = `<div class="search-empty">${esc(hint)}</div>`;
    return;
  }

  container.innerHTML = `
    <p class="search-summary">找到 <strong>${totalHits}</strong> 处命中，分布在 <strong>${matchedBooks}</strong> 本书里。</p>
    ${results
      .map(
        (book) => `
      <section class="search-book">
        <header class="search-book-head">
          <a class="search-book-title" href="#/book/${esc(book.book_id)}">${esc(book.title)}</a>
          ${book.author ? `<span class="search-book-author">${esc(book.author)}</span>` : ''}
          <span class="search-book-count">${book.chapterCount} 章命中 / 共 ${book.hitCount} 处</span>
        </header>
        <ul class="search-hits">
          ${book.chapters
            .map(
              (chapter) => `
            <li>
              <a class="hit-chapter" href="${readerHref(book.book_id, chapter.chapter_index, q)}">
                ${esc(chapter.chapter_title)}
                <span class="hit-count">命中 ${chapter.count} 次</span>
              </a>
              ${chapter.snippets
                .map(
                  (snippet) =>
                    `<a class="hit-snippet" href="${readerHref(book.book_id, chapter.chapter_index, q)}">${snippetHtml(
                      snippet,
                      q
                    )}</a>`
                )
                .join('')}
            </li>`
            )
            .join('')}
        </ul>
      </section>`
      )
      .join('')}`;
}

function renderFilterOptions() {
  const options = state.options;
  if (!options) return;
  const select = (id, label, values) => `
    <label class="field">
      <span>${label}</span>
      <select id="${id}">
        <option value="">全部</option>
        ${values.map((v) => `<option value="${esc(v)}">${esc(v)}</option>`).join('')}
      </select>
    </label>`;

  document.getElementById('filterRow').innerHTML = `
    ${select('filterStatus', '状态', options.status)}
    ${select('filterTag', '标签', options.tags)}
    ${select('filterSite', '来源站点', options.sites)}
    ${select('filterAuthor', '作者', options.authors)}
    <button class="btn" id="btnFilterApply" type="button">筛选</button>
    <button class="btn btn-ghost" id="btnFilterClear" type="button">清空</button>`;

  for (const key of ['status', 'tag', 'site', 'author']) {
    const el = document.getElementById('filter' + key[0].toUpperCase() + key.slice(1));
    el.value = state.filter[key] || '';
    el.onchange = () => {
      state.filter[key] = el.value;
    };
  }
  document.getElementById('btnFilterApply').onclick = () => runFilter();
  document.getElementById('btnFilterClear').onclick = () => {
    state.filter = { status: '', tag: '', site: '', author: '' };
    runFilter();
  };
}

async function runFilter() {
  const container = document.getElementById('filterResults');
  container.innerHTML = '<div class="loading">正在筛选…</div>';
  try {
    const data = await api.get('/api/books' + qs(state.filter));
    state.filtered = data.books;
    if (!data.books.length) {
      container.innerHTML = '<div class="search-empty">没有符合条件的书。可以少选几个条件再试。</div>';
      return;
    }
    container.innerHTML = `
      <p class="search-summary">共筛出 <strong>${data.total}</strong> 本。</p>
      <div class="cover-wall">
        ${data.books
          .map(
            (book) => `
          <article class="book-card" data-id="${esc(book.book_id)}" tabindex="0" role="button">
            <div class="book-cover">
              <span class="book-initial">${esc(String(book.title).slice(0, 1))}</span>
              <span class="book-progress"><i style="width:${Math.round((book.progress_percent || 0) * 100)}%"></i></span>
            </div>
            <div class="book-title">${esc(book.title)}</div>
            <div class="book-author">${esc(book.author || '')}</div>
          </article>`
          )
          .join('')}
      </div>`;
    container.onclick = (event) => {
      const card = event.target.closest('.book-card');
      if (card) router.go(`/book/${card.dataset.id}`);
    };
  } catch (err) {
    container.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`;
  }
}

async function runDuplicates() {
  const container = document.getElementById('duplicatesResult');
  container.innerHTML = '<div class="loading">正在检查…</div>';
  try {
    const data = await api.get('/api/books/duplicates');
    state.duplicates = data;
    if (!data.groups.length) {
      container.innerHTML = '<div class="callout callout-ok"><p>没有发现重复的书。</p></div>';
      return;
    }
    container.innerHTML = `
      <div class="callout callout-warn"><p>${esc(data.message)}</p></div>
      ${data.groups
        .map(
          (group, i) => `
        <div class="dup-group" data-group="${i}">
          <p class="dup-reason">${esc(group.reason)}：</p>
          <ul class="dup-list">
            ${group.books
              .map(
                (book, j) => `<li class="${j === 0 ? 'is-keep' : ''}">
                  <span class="dup-title">${esc(book.title)}</span>
                  <span class="dup-meta">${esc(book.author || '作者未知')} · ${book.total_chapters} 章 ·
                    ${esc(book.source_site || '本机导入')}</span>
                  ${j === 0 ? '<span class="dup-tag">保留这份</span>' : ''}
                </li>`
              )
              .join('')}
          </ul>
          <button class="btn btn-sm" type="button" data-act="merge" data-keep="${esc(group.keep.book_id)}" data-drop="${group.others
            .map((b) => b.book_id)
            .join(',')}">合并这一组（保留章节多的）</button>
        </div>`
        )
        .join('')}`;

    container.onclick = async (event) => {
      const button = event.target.closest('button[data-act="merge"]');
      if (!button) return;
      const keepId = button.dataset.keep;
      const dropIds = button.dataset.drop.split(',').filter(Boolean);
      const ok = await confirmDialog({
        title: '合并这些重复的书？',
        message: `会保留章节最多的那一本，其余 ${dropIds.length} 本从书架移除。`,
        detail: '被移除的书其正文会放进 data/.trash 回收站，不会直接删掉。',
        confirmText: '合并',
      });
      if (!ok) return;
      try {
        for (const dropId of dropIds) {
          // eslint-disable-next-line no-await-in-loop
          await api.post('/api/books/merge', { keep_id: keepId, drop_id: dropId });
        }
        toast('已经合并完成。', 'ok');
        await runDuplicates();
        await runFilter();
      } catch (err) {
        toastError(err);
      }
    };
  } catch (err) {
    container.innerHTML = `<div class="search-empty">${esc(err.message)}</div>`;
  }
}

function wireTabs() {
  for (const button of document.querySelectorAll('#searchTabs button')) {
    button.onclick = () => {
      state.tab = button.dataset.tab;
      for (const other of document.querySelectorAll('#searchTabs button')) {
        other.classList.toggle('is-active', other === button);
      }
      for (const panel of document.querySelectorAll('[data-panel]')) {
        panel.hidden = panel.dataset.panel !== state.tab;
      }
    };
  }
}

async function runSearch(keyword) {
  if (!keyword) {
    state.results = null;
    renderResults();
    return;
  }
  const container = document.getElementById('searchResults');
  container.innerHTML = '<div class="loading">正在搜索…</div>';
  try {
    const data = await api.get(
      '/api/search' + qs({ q: keyword, scope: state.scope, book_id: state.scope === 'book' ? state.bookId : '' })
    );
    state.results = data;
    renderResults();
  } catch (err) {
    container.innerHTML = `<div class="search-empty">${esc(err.message)}${
      err.hint ? `<br /><span class="text-faint">${esc(err.hint)}</span>` : ''
    }</div>`;
  }
}

export async function render(params, query) {
  const view = document.getElementById('view');
  state.bookId = (query && query.book_id) || '';
  state.scope = (query && query.scope) === 'book' && state.bookId ? 'book' : 'library';

  let bookName = '';
  if (state.scope === 'book' && state.bookId) {
    try {
      const book = await api.get(`/api/books/${encodeURIComponent(state.bookId)}`);
      bookName = book.title;
    } catch (err) {
      state.scope = 'library';
    }
  }

  view.innerHTML = `
    <section class="search-page">
      <div class="page-head">
        <h1>检索</h1>
        <p class="page-sub">找内容，或者按条件筛书。</p>
      </div>

      <div class="panel">
        <div class="search-bar">
          <input type="search" id="searchInput" placeholder="输入要找的内容，回车开始搜索" value="${esc(state.q)}" />
          <div class="seg" id="scopeSeg">
            <button type="button" data-scope="library" class="${state.scope === 'library' ? 'is-on' : ''}">全库</button>
            <button type="button" data-scope="book" class="${state.scope === 'book' ? 'is-on' : ''}" ${
              state.bookId ? '' : 'disabled'
            }>只在《${esc(bookName || '当前书')}》里</button>
          </div>
          <button class="btn btn-primary" id="btnSearch" type="button">搜索</button>
        </div>
        <div class="seg seg-tabs" id="searchTabs">
          <button type="button" data-tab="content" class="is-active">找内容</button>
          <button type="button" data-tab="filter">筛书</button>
          <button type="button" data-tab="duplicates">重名书</button>
        </div>
      </div>

      <div data-panel="content">
        <div class="panel panel-grow"><div id="searchResults"></div></div>
      </div>

      <div data-panel="filter" hidden>
        <div class="panel">
          <div class="field-row" id="filterRow"></div>
        </div>
        <div class="panel panel-grow"><div id="filterResults"></div></div>
      </div>

      <div data-panel="duplicates" hidden>
        <div class="panel">
          <p class="panel-note">
            同样的书从不同站点导进来，书名常常差一个字或者带不同后缀。这里会找出"书名 + 作者高度相似"的书，
            合并时保留章节最多的那一份，其余的进回收站。
          </p>
          <div class="panel-actions">
            <button class="btn" id="btnCheckDuplicates" type="button">开始检查</button>
          </div>
        </div>
        <div class="panel panel-grow"><div id="duplicatesResult"></div></div>
      </div>
    </section>`;

  wireTabs();
  renderResults();

  const input = document.getElementById('searchInput');
  input.onkeydown = (event) => {
    if (event.key !== 'Enter') return;
    state.q = input.value.trim();
    runSearch(state.q);
  };
  document.getElementById('btnSearch').onclick = () => {
    state.q = input.value.trim();
    runSearch(state.q);
  };
  for (const button of document.querySelectorAll('#scopeSeg button')) {
    button.onclick = () => {
      if (button.disabled) return;
      state.scope = button.dataset.scope;
      for (const other of document.querySelectorAll('#scopeSeg button')) {
        other.classList.toggle('is-on', other === button);
      }
      if (state.q) runSearch(state.q);
    };
  }

  document.getElementById('btnCheckDuplicates').onclick = () => runDuplicates();

  // 从别处带着关键词进来（比如阅读器里选中一段点"全库搜这段"）
  if (query && query.q) {
    state.q = query.q;
    input.value = query.q;
    runSearch(state.q);
  }

  // 进页面先把筛选项和筛书结果准备好，用户切过去就能用
  try {
    state.options = await api.get('/api/filter/options');
    renderFilterOptions();
    await runFilter();
  } catch (err) {
    toastError(err);
  }
}

export { state as searchState };
