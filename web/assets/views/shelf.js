/**
 * views/shelf.js —— 书架首页（模块 1 / PRD §3、§6 首页显示规则）。
 *
 * 首页从上到下严格按这个顺序，不多塞任何东西：
 *   1. 「继续阅读」大卡片（没有阅读记录时整张隐藏）
 *   2. 分堆切换（在读 / 追更中 / 已读完 / 全部）+ 右上角「加书」
 *   3. 封面墙（书名、作者、细进度条、更新角标）
 *   4. 底部一行轻量数据概览
 *
 * 首页明确不显示抓取日志、接口状态、技术参数、版本信息 —— 这些都在设置页。
 */

import { api } from '../api.js';
import { router } from '../router.js';
import { confirmDialog, esc, fmtDate, fmtDuration, fmtRelative, promptDialog, toast, toastError } from '../ui.js';
import { emptyGuideHtml, openAddBookDialog, wireEmptyGuide } from './addbook.js';

/** 当前分堆：会话内记住，回到书架时保持用户刚看的那一堆 */
let currentPile = '在读';
/** 书名即时搜索的关键词（本地匹配，输入即过滤） */
let keyword = '';

/** 记住最近一次拿到的数据，过滤时不用重新请求 */
let lastData = null;

function goAddBook(choice) {
  router.go(choice.hash);
}

/** 书架卡片上那一小块封面：没有真实封面时用书名首字，比放一张灰色占位图好认 */
function coverInitial(title) {
  const text = String(title || '').trim();
  return text ? text[0] : '书';
}

function renderBookCard(book) {
  const percent = Math.round((book.progress_percent || 0) * 100);
  const totalChapters = Number(book.total_chapters) || 0;
  const badge = book.update_badge
    ? `<span class="book-badge" title="追更检查发现了新章节">+${book.update_badge} 章</span>`
    : '';
  const tip =
    percent > 0
      ? `已读 ${percent}% · 共 ${totalChapters} 章`
      : `还没开始读 · 共 ${totalChapters} 章`;

  return `
    <article class="book-card" data-id="${esc(book.book_id)}" tabindex="0" role="button"
             aria-label="打开《${esc(book.title)}》">
      <div class="book-cover">
        <span class="book-initial">${esc(coverInitial(book.title))}</span>
        ${badge}
        <span class="book-progress"><i style="width:${percent}%"></i></span>
        <span class="book-tip">${esc(tip)}</span>
      </div>
      <div class="book-title" title="${esc(book.title)}">${esc(book.title)}</div>
      <div class="book-author">${esc(book.author || '')}</div>
    </article>`;
}

function renderContinueCard(cont) {
  if (!cont) return '';
  const percent = Math.round((cont.percent || 0) * 100);
  return `
    <a class="continue-card" href="#/book/${esc(cont.book.book_id)}" data-continue="${esc(cont.book.book_id)}">
      <div class="continue-main">
        <div class="continue-label">继续阅读</div>
        <div class="continue-title">${esc(cont.book.title)}</div>
        <div class="continue-position">读到 ${esc(cont.label)}</div>
        <div class="continue-bar"><i style="width:${percent}%"></i></div>
        <div class="continue-meta">
          <span>已读 ${percent}%</span>
          <span>上次阅读 ${esc(fmtRelative(cont.last_read_at))}</span>
        </div>
      </div>
      <div class="continue-go">回到原位置 →</div>
    </a>`;
}

function renderStats(stats) {
  return `
    <footer class="shelf-stats">
      <span>共 ${stats.bookCount} 本书</span>
      <span class="dot">·</span>
      <span>总阅读时长 ${esc(fmtDuration(stats.totalMs))}</span>
      <span class="dot">·</span>
      <span>本周读了 ${esc(fmtDuration(stats.weekMs))}</span>
    </footer>`;
}

/**
 * 追更通知条（模块 2：发现新章节出角标和通知，但**不自动下载**）。
 * 通知只在这里提示一句，点进去是详情页；真正下载由用户点「更新」触发。
 */
function renderNotifications(notifications) {
  if (!notifications || !notifications.length) return '';
  return `
    <div class="notice-bar" id="noticeBar">
      <div class="notice-list">
        ${notifications
          .slice(0, 3)
          .map(
            (item) => `<a class="notice-item" href="#/book/${esc(item.book_id)}">
              ${esc(item.message || `《${item.book_title}》有更新`)}
              <span class="notice-note">（只提示，没有自动下载）</span>
            </a>`
          )
          .join('')}
        ${notifications.length > 3 ? `<span class="notice-more">还有 ${notifications.length - 3} 条…</span>` : ''}
      </div>
      <button class="btn btn-sm btn-ghost" id="btnNoticeRead" type="button">知道了</button>
    </div>`;
}

/** 按关键词过滤当前堆的书（本地匹配，输入即过滤） */
function filterBooks(books, kw) {
  const text = String(kw || '').trim().toLowerCase();
  if (!text) return books;
  return books.filter(
    (b) =>
      String(b.title).toLowerCase().includes(text) || String(b.author || '').toLowerCase().includes(text)
  );
}

/** 单本的右键 / 长按菜单 */
function openBookMenu(book, x, y, reload) {
  const existing = document.querySelector('.context-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.style.left = Math.min(x, window.innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - 220) + 'px';
  menu.innerHTML = `
    <button type="button" data-act="open">打开</button>
    <button type="button" data-act="rename">重命名</button>
    <button type="button" data-act="tags">加标签</button>
    <button type="button" data-act="export">导出这一本</button>
    <hr />
    <button type="button" data-act="remove" class="danger">从书架移除</button>`;
  document.body.appendChild(menu);

  const closeMenu = () => {
    menu.remove();
    document.removeEventListener('mousedown', onOutside, true);
  };
  const onOutside = (event) => {
    if (!menu.contains(event.target)) closeMenu();
  };
  document.addEventListener('mousedown', onOutside, true);

  menu.addEventListener('click', async (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    const act = button.dataset.act;
    closeMenu();

    try {
      if (act === 'open') {
        router.go(`/book/${book.book_id}`);
        return;
      }
      if (act === 'rename') {
        const title = await promptDialog({
          title: '重命名',
          label: '新的书名',
          value: book.title,
          confirmText: '保存',
        });
        if (!title) return;
        await api.patch(`/api/books/${book.book_id}`, { title });
        toast('书名已改好。', 'ok');
        reload();
        return;
      }
      if (act === 'tags') {
        const input = await promptDialog({
          title: '加标签',
          label: '标签用逗号隔开，例如：仙侠, 玄幻',
          value: (book.tags || []).join(', '),
          confirmText: '保存',
        });
        if (input === null) return;
        const tags = input
          .split(/[,，、]/)
          .map((t) => t.trim())
          .filter(Boolean);
        await api.patch(`/api/books/${book.book_id}`, { tags });
        toast('标签已保存。', 'ok');
        reload();
        return;
      }
      if (act === 'export') {
        // 用浏览器原生下载：走本地服务的导出接口，文件名由服务端按 RFC 5987 编码
        const link = document.createElement('a');
        link.href = `/api/books/${encodeURIComponent(book.book_id)}/export?format=txt`;
        link.download = `${book.title}.txt`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        return;
      }
      if (act === 'remove') {
        const ok = await confirmDialog({
          title: `把《${book.title}》从书架移除？`,
          message: '移除后书架上看不到这本书了。',
          detail: '正文文件不会删掉，会先放到 data/.trash 回收站里，将来还能找回。',
          confirmText: '移除',
          danger: true,
        });
        if (!ok) return;
        await api.del(`/api/books/${encodeURIComponent(book.book_id)}?mode=trash`);
        toast('已从书架移除，正文放进了回收站。', 'ok');
        reload();
      }
    } catch (err) {
      toastError(err);
    }
  });
}

export async function render() {
  const view = document.getElementById('view');
  view.innerHTML = '<div class="loading">正在打开书架…</div>';

  let data;
  let cont;
  let stats;
  let notices = { notifications: [], unreadCount: 0 };
  try {
    [data, cont, stats] = await Promise.all([
      api.get('/api/library'),
      api.get('/api/library/continue'),
      api.get('/api/library/stats'),
    ]);
    // 追更通知是可选的：拿不到也不该让书架打不开
    notices = await api.get('/api/notifications?unread=true').catch(() => ({ notifications: [], unreadCount: 0 }));
  } catch (err) {
    view.innerHTML = `
      <div class="empty-state">
        <h2>书架打不开</h2>
        <p>${esc(err.message)}</p>
        ${err.hint ? `<p class="hint">${esc(err.hint)}</p>` : ''}
      </div>`;
    return;
  }

  lastData = { data, cont, stats };

  if (stats.bookCount === 0) {
    view.innerHTML = `<section class="shelf">${emptyGuideHtml()}</section>`;
    wireEmptyGuide(view, goAddBook);
    const addBtn = document.getElementById('btnAddBook');
    if (addBtn) addBtn.onclick = () => openAddBookDialog(goAddBook);
    return;
  }

  // 堆切换：默认停在「在读」，为空时自动落到「全部」，避免用户点进来看到一片空白
  const piles = data.piles;
  if (!piles[currentPile] || !piles[currentPile].length) {
    currentPile = piles['全部'] && piles['全部'].length ? '全部' : currentPile;
  }

  view.innerHTML = `
    <section class="shelf">
      ${renderContinueCard(cont)}
      <div class="shelf-toolbar">
        <div class="piles" role="tablist">
          ${data.order
            .map(
              (id) => `<button class="pile-tab ${id === currentPile ? 'is-active' : ''}" type="button"
                        role="tab" data-pile="${esc(id)}">${esc(data.labels[id])}
                        <span class="pile-count">${data.counts[id]}</span></button>`
            )
            .join('')}
        </div>
        <div class="shelf-toolbar-right">
          <span class="shelf-hint" id="shelfHint"></span>
        </div>
      </div>
      <div class="cover-wall" id="coverWall"></div>
      ${renderStats(stats)}
    </section>`;

  const wall = document.getElementById('coverWall');
  const hint = document.getElementById('shelfHint');

  const paint = () => {
    const books = filterBooks(piles[currentPile] || [], keyword);
    if (!books.length) {
      wall.innerHTML = `<div class="wall-empty">${
        keyword ? `没有书名包含「${esc(keyword)}」的书。` : '这一堆里还没有书。'
      }</div>`;
      hint.textContent = '';
      return;
    }
    wall.innerHTML = books.map(renderBookCard).join('');
    hint.textContent = keyword
      ? `筛出 ${books.length} 本`
      : `${piles[currentPile].length} 本 · 按最后阅读时间排序`;
  };

  const reload = () => render();
  paint();

  // 点封面 → 详情；右键 / 长按 → 单本菜单
  wall.addEventListener('click', (event) => {
    const card = event.target.closest('.book-card');
    if (card) router.go(`/book/${card.dataset.id}`);
  });
  wall.addEventListener('keydown', (event) => {
    const card = event.target.closest('.book-card');
    if (card && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      router.go(`/book/${card.dataset.id}`);
    }
  });
  wall.addEventListener('contextmenu', (event) => {
    const card = event.target.closest('.book-card');
    if (!card) return;
    event.preventDefault();
    const book = (piles[currentPile] || []).find((b) => b.book_id === card.dataset.id);
    if (book) openBookMenu(book, event.clientX, event.clientY, reload);
  });

  // 长按（触屏 / 触控板）：600 毫秒算长按
  let pressTimer = null;
  wall.addEventListener(
    'touchstart',
    (event) => {
      const card = event.target.closest('.book-card');
      if (!card) return;
      const touch = event.touches[0];
      pressTimer = setTimeout(() => {
        const book = (piles[currentPile] || []).find((b) => b.book_id === card.dataset.id);
        if (book) openBookMenu(book, touch.clientX, touch.clientY, reload);
      }, 600);
    },
    { passive: true }
  );
  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
  };
  wall.addEventListener('touchend', cancelPress);
  wall.addEventListener('touchmove', cancelPress);

  for (const tab of view.querySelectorAll('.pile-tab')) {
    tab.onclick = () => {
      currentPile = tab.dataset.pile;
      for (const other of view.querySelectorAll('.pile-tab')) {
        other.classList.toggle('is-active', other === tab);
      }
      paint();
    };
  }

  // 继续阅读卡片：整卡可点，同时给一个直达阅读器的链接
  const continueCard = view.querySelector('.continue-card');
  if (continueCard) {
    continueCard.onclick = (event) => {
      if (event.metaKey || event.ctrlKey) return; // 让用户能按住 Ctrl 新开标签页
      event.preventDefault();
      // 有阅读记录就直接进阅读器原位置（PRD：点一下直接回到那个位置）
      const url = cont.reader_url;
      window.location.href = url;
    };
  }

  const addBtn = document.getElementById('btnAddBook');
  if (addBtn) addBtn.onclick = () => openAddBookDialog(goAddBook);

  const readBtn = document.getElementById('btnNoticeRead');
  if (readBtn) {
    readBtn.onclick = async () => {
      try {
        await api.post('/api/notifications/read', {});
        const bar = document.getElementById('noticeBar');
        if (bar) bar.remove();
      } catch (err) {
        toastError(err);
      }
    };
  }

  // 顶栏搜索框的输入事件（本地匹配，输入即过滤）
  if (typeof window.__shelfFilterHandler === 'function') {
    window.removeEventListener('shelf:filter', window.__shelfFilterHandler);
  }
  window.__shelfFilterHandler = (event) => {
    keyword = event.detail || '';
    paint();
  };
  window.addEventListener('shelf:filter', window.__shelfFilterHandler);

  // 从别的页面点「加书」进来时直接弹层
  if (typeof window.__shelfAddHandler === 'function') {
    window.removeEventListener('addbook:open', window.__shelfAddHandler);
  }
  window.__shelfAddHandler = () => openAddBookDialog(goAddBook);
  window.addEventListener('addbook:open', window.__shelfAddHandler);

  // 把顶栏搜索框恢复到当前关键词，避免来回切换页面时搜索内容丢掉
  const quick = document.getElementById('quickSearch');
  if (quick && quick.value !== keyword) quick.value = keyword;

  // 提示一下上次见到的时间点，用户能确认看到的是最新数据
  void fmtDate(stats && stats.updatedAt);
}

export { currentPile, lastData };
