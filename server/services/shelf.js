'use strict';
/**
 * shelf.js —— 书架首页需要的组合数据（PRD 模块 1 / §3 首页显示规则）。
 *
 * 为什么单独一个服务：
 * 首页要的是"书 + 进度 + 时长"三份数据的组合视图，而 library 只管书、reading 只管阅读行为。
 * 组合逻辑集中在这里，路由层就只剩"读参数、返回结果"，
 * 也保证了「继续阅读」卡片、封面进度条、分堆归属这几处用的是同一套口径。
 *
 * 首页从上到下的顺序（PRD §6 明确版）：
 *   1. 继续阅读大卡片（没有阅读记录时隐藏）
 *   2. 分堆切换 + 加书按钮
 *   3. 封面墙
 *   4. 底部数据概览
 */

const { BOOK_STATUS } = require('../lib/constants');

/** 分堆定义。顺序就是界面上标签的先后顺序 */
const PILE_ORDER = [
  { id: '在读', label: '在读' },
  { id: '追更中', label: '追更中' },
  { id: '已读完', label: '已读完' },
  { id: '全部', label: '全部' },
];

/** 当前时间戳（排序用） */
function timeOf(iso) {
  const t = iso ? new Date(iso).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

module.exports = function createShelfService(ctx) {
  const { library, reading } = ctx;

  /** 排序键：优先最后阅读时间，没读过就用最后修改时间；都是倒序 */
  function sortKey(book) {
    return timeOf(book.last_read_at) || timeOf(book.updatedAt) || timeOf(book.created_at);
  }

  function sortBooks(books) {
    return [...books].sort((a, b) => {
      const diff = sortKey(b) - sortKey(a);
      if (diff !== 0) return diff;
      return String(a.book_id).localeCompare(String(b.book_id));
    });
  }

  /**
   * 给一本书补上前端要用的展示数据。
   * 进度百分比与章节数都要在这里算好，免得每个界面各算一遍算错。
   */
  function decorate(book, progressMap) {
    const progress = (progressMap || reading.allProgress())[book.book_id] || null;
    const total = Number(book.total_chapters) || 0;
    const read = Number(book.read_chapters) || 0;

    // 进度百分比：优先用真实阅读位置（更准），没有阅读记录时退回"已读章数/总章数"
    let percent = 0;
    if (progress) {
      percent = progress.percent;
      if (total > 0) {
        const byChapter = (progress.chapter_index - 1 + progress.chapter_ratio) / total;
        percent = Math.max(percent, Math.min(1, byChapter));
      }
    } else if (total > 0) {
      percent = Math.min(1, read / total);
    }

    return {
      ...book,
      progress: progress
        ? {
            chapter_index: progress.chapter_index,
            char_offset: progress.char_offset,
            chapter_ratio: progress.chapter_ratio,
            percent: progress.percent,
            updated_at: progress.updated_at,
          }
        : null,
      progress_percent: Math.round(percent * 1000) / 1000,
      /** 更新角标：追更检查发现的待更新章节数（只出角标，不自动下载） */
      update_badge: Number(book.new_chapters) > 0 ? Number(book.new_chapters) : 0,
    };
  }

  /** 全部书 + 进度，按最后阅读时间倒序 */
  function decoratedList() {
    const progressMap = reading.allProgress();
    return sortBooks(library.list()).map((book) => decorate(book, progressMap));
  }

  /**
   * 分堆数据（PRD §3：在读 / 追更中（有新章节）/ 已读完 / 全部）。
   * 「追更中」除了状态本身，待更新章节数 > 0 的书也归进来 ——
   * 那正是用户最需要看到的那一堆。
   */
  function pile() {
    const all = decoratedList();
    const piles = {
      在读: all.filter((b) => b.status === BOOK_STATUS.READING),
      追更中: all.filter((b) => b.status === BOOK_STATUS.FOLLOWING || b.update_badge > 0),
      已读完: all.filter((b) => b.status === BOOK_STATUS.FINISHED),
      全部: all,
    };
    return {
      piles,
      order: PILE_ORDER.map((p) => p.id),
      labels: PILE_ORDER.reduce((acc, p) => ({ ...acc, [p.id]: p.label }), {}),
      counts: Object.fromEntries(Object.entries(piles).map(([k, v]) => [k, v.length])),
    };
  }

  /**
   * 「继续阅读」大卡片的数据（PRD §3）。
   * 没有阅读记录时返回 null —— 界面据此把整张卡片隐藏掉。
   */
  function continueReading() {
    const candidates = decoratedList().filter((b) => b.progress);
    if (!candidates.length) return null;
    const book = candidates[0]; // decoratedList 已按最后阅读时间倒序
    const detail = library.get(book.book_id);
    const chapter = detail && detail.chapters[book.progress.chapter_index - 1];

    return {
      book,
      progress: book.progress,
      chapter_index: book.progress.chapter_index,
      chapter_title: chapter ? chapter.title : '',
      /** 上次读到「第 N 章 · 章节名」，界面上直接用 */
      label: chapter
        ? `第 ${book.progress.chapter_index} 章 · ${chapter.title}`
        : `第 ${book.progress.chapter_index} 章`,
      last_read_at: book.last_read_at || book.progress.updated_at,
      percent: book.progress_percent,
      reader_url: `/reader.html?book=${encodeURIComponent(book.book_id)}&ch=${book.progress.chapter_index}`,
    };
  }

  /** 底部轻量数据概览：共 N 本书、总阅读时长、本周读了多久 */
  function stats() {
    const base = library.stats();
    const overview = reading.overview();
    return {
      ...base,
      totalMs: overview.totalMs,
      weekMs: overview.weekMs,
      /** 有阅读记录的书数量，用于判断要不要隐藏继续阅读卡片 */
      readingCount: library.list().filter((b) => b.last_read_at).length,
    };
  }

  /**
   * 多条件筛选（PRD 模块 8：状态 / 标签 / 来源站点 / 作者，可叠加）。
   * 这里放在书架服务里，模块 8 的检索页直接复用同一份实现。
   */
  function filter(options = {}) {
    let books = decoratedList();
    const { status, tag, site, author, q } = options;

    if (status) books = books.filter((b) => b.status === status);
    if (tag) books = books.filter((b) => (b.tags || []).includes(tag));
    if (site) books = books.filter((b) => b.source_site === site);
    if (author) books = books.filter((b) => b.author === author);
    if (q) {
      const keyword = String(q).trim().toLowerCase();
      books = books.filter(
        (b) =>
          String(b.title).toLowerCase().includes(keyword) ||
          String(b.author || '').toLowerCase().includes(keyword)
      );
    }
    return books;
  }

  /** 筛选项可选值（PRD 模块 8 的 /api/filter/options 复用） */
  function filterOptions() {
    const books = library.list();
    const tags = new Set();
    const sites = new Set();
    const authors = new Set();
    const statuses = new Set();
    for (const book of books) {
      (book.tags || []).forEach((t) => tags.add(t));
      if (book.source_site) sites.add(book.source_site);
      if (book.author) authors.add(book.author);
      if (book.status) statuses.add(book.status);
    }
    return {
      status: PILE_ORDER.filter((p) => p.id !== '全部').map((p) => p.id),
      statuses: [...statuses],
      tags: [...tags].sort(),
      sites: [...sites].sort(),
      authors: [...authors].sort(),
    };
  }

  return {
    PILE_ORDER,
    sortBooks,
    decorate,
    decoratedList,
    pile,
    continueReading,
    stats,
    filter,
    filterOptions,
  };
};

module.exports.PILE_ORDER = PILE_ORDER;
