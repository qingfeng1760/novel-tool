'use strict';
/**
 * reading.js —— 进度 / 书签 / 笔记 / 跳章历史 / 阅读时长的落盘。
 *
 * 文件划分（PRD §6.1）：
 *   data/reading/progress.json    所有书的阅读进度（按 book_id 存成映射，读一本不用扫全表）
 *   data/reading/bookmarks.json
 *   data/reading/notes.json
 *   data/reading/history.json     跳章历史栈，用于"返回上一处"
 *   data/reading/sessions.json    阅读会话明细（模块 6 要求按书/按天统计时长）
 *
 * 为什么 sessions 存明细而不是直接存聚合值：
 *   聚合可以随时从明细重算，明细一旦被覆盖就再也算不回来了。用户换电脑时的进度迁移也一样，
 *   带着明细走才能在另一台机器上看到同样的"按天读了多久"。
 */

const { ApiError, Errors } = require('../lib/errors');
const {
  normProgress,
  normBookmark,
  normNote,
  normHistoryEntry,
  normSession,
  nowIso,
  versioning,
} = require('../schema/models');
const { SCHEMA_VERSION } = require('../lib/constants');

const FILES = {
  progress: 'reading/progress.json',
  bookmarks: 'reading/bookmarks.json',
  notes: 'reading/notes.json',
  history: 'reading/history.json',
  sessions: 'reading/sessions.json',
};

/** 跳章历史最多留多少条，避免常年累积把文件撑大 */
const HISTORY_LIMIT = 500;
/** 阅读会话最多留多少条（每条一次打开阅读器的记录，5000 条足够统计多年） */
const SESSION_LIMIT = 5000;

/** 本地日期 YYYY-MM-DD（按天统计用本地时区，符合"我这一天读了多久"的直觉） */
function localDay(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 本周一 0 点（周一为一周开始，符合国内习惯） */
function startOfWeek(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const weekday = (d.getDay() + 6) % 7; // 周一 = 0
  d.setDate(d.getDate() - weekday);
  return d;
}

module.exports = function createReadingService(ctx) {
  const io = ctx.storage;

  // ---------------------------------------------------------------- 通用

  function readFile(rel, key) {
    const raw = io.readJson(rel, null);
    if (!raw || typeof raw !== 'object') return { ...versioning({}, null), [key]: key === 'progress' ? {} : [] };
    return raw;
  }

  function writeFile(rel, payload) {
    io.writeJson(rel, {
      ...payload,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      updatedAt: nowIso(),
    });
  }

  function makeId(prefix) {
    // 用 io 的 generateId，将来换成云适配器时 id 生成策略也能跟着换
    return io.generateId(prefix);
  }

  // ---------------------------------------------------------------- 进度

  function allProgress() {
    const data = readFile(FILES.progress, 'progress');
    return data.progress || {};
  }

  function getProgress(bookId) {
    return allProgress()[bookId] || null;
  }

  /**
   * 写进度。
   * 前端按 ≤2 秒节流上报（模块 5），所以这里必须是"快而稳"的：
   * 读全量映射、改一项、原子写回。几百本书的映射文件也只有几十 KB，够快。
   */
  function setProgress(input) {
    const progress = normProgress(input);
    if (!progress.book_id) {
      throw new ApiError('PROGRESS_NO_BOOK', '这次上报的进度没有带上书。', '请重新打开这本书再读。', 400);
    }
    const data = readFile(FILES.progress, 'progress');
    data.progress = data.progress || {};
    const previous = data.progress[progress.book_id];
    // updatedAt 每次都要刷新，云同步时靠它判断谁更新
    data.progress[progress.book_id] = { ...progress, updatedAt: nowIso() };
    writeFile(FILES.progress, data);
    return { progress: data.progress[progress.book_id], previous: previous || null };
  }

  function removeProgress(bookId) {
    const data = readFile(FILES.progress, 'progress');
    if (data.progress && data.progress[bookId]) {
      delete data.progress[bookId];
      writeFile(FILES.progress, data);
      return true;
    }
    return false;
  }

  /** 最近在读的书（首页「继续阅读」卡片用），按进度更新时间倒序 */
  function recentProgress(limit = 10) {
    return Object.values(allProgress())
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
      .slice(0, limit);
  }

  /**
   * 把保存的进度还原成"打开阅读器后应该停在哪儿"（PRD 流程 D）。
   *
   * 三级保真：
   *   1. 章号 + 章内字符偏移 —— 最准，正常情况都走这条；
   *   2. 章内比例 —— 章节内容长度变了（重分章/重新抓取）时，用比例换算新的偏移；
   *   3. 全书百分比 —— 章节总数变了、章号已经越界时，按比例落到合适的章。
   * 核心要求是"别回到开头"，所以任何一级都要给出比第 1 章更合理的位置。
   */
  function resolvePosition(bookId) {
    const book = ctx.library.get(bookId);
    const progress = getProgress(bookId);
    const total = book ? Number(book.total_chapters) || 0 : 0;

    if (!progress) {
      return { book_id: bookId, chapter_index: 1, char_offset: 0, mode: 'fresh', note: '还没有阅读记录，从第一章开始。' };
    }
    if (total <= 0) {
      return { book_id: bookId, chapter_index: 1, char_offset: 0, mode: 'empty', note: '这本书还没有章节。' };
    }

    let index = Math.min(Math.max(1, progress.chapter_index), total);
    let mode = index === progress.chapter_index ? 'exact' : 'clamped';
    let note = '';

    const chapter = book.chapters[index - 1];
    const length = chapter ? Number(chapter.char_count) || 0 : 0;
    let offset = progress.char_offset;

    if (progress.chapter_index > total) {
      // 章节总数变少了：按全书百分比重新定位，而不是粗暴地回到第一章
      const target = Math.max(1, Math.ceil(progress.percent * total));
      index = Math.min(total, target);
      mode = 'by-percent';
      note = '这本书的章节数变了，已按原来的阅读比例重新定位。';
      offset = 0;
    } else if (length > 0 && offset > length) {
      // 内容长度变了（重分章 / 重新抓取），按章内比例换算
      offset = Math.round(progress.chapter_ratio * length);
      mode = 'by-ratio';
      note = '这一章的内容长度变了，已按原来的章内比例重新定位。';
    } else if (offset === 0 && progress.chapter_ratio > 0 && length > 0) {
      // 没记偏移但记了比例：用比例
      offset = Math.round(progress.chapter_ratio * length);
      mode = 'by-ratio';
    }

    if (offset < 0) offset = 0;
    return {
      book_id: bookId,
      chapter_index: index,
      char_offset: offset,
      chapter_ratio: length > 0 ? Math.min(1, offset / length) : progress.chapter_ratio,
      percent: progress.percent,
      updated_at: progress.updated_at,
      mode,
      note,
    };
  }

  // ---------------------------------------------------------------- 书签

  function listBookmarks(filter = {}) {
    const data = readFile(FILES.bookmarks, 'bookmarks');
    let items = (data.bookmarks || []).map(normBookmark);
    if (filter.book_id) items = items.filter((b) => b.book_id === filter.book_id);
    if (filter.chapter_index !== undefined) {
      items = items.filter((b) => b.chapter_index === Number(filter.chapter_index));
    }
    return items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function addBookmark(input) {
    const bookmark = normBookmark({ ...input, id: input && input.id ? input.id : makeId('bm') });
    if (!bookmark.book_id) {
      throw new ApiError('BOOKMARK_NO_BOOK', '加书签时没带上书。', '请重新打开这本书再加书签。', 400);
    }
    const data = readFile(FILES.bookmarks, 'bookmarks');
    data.bookmarks = data.bookmarks || [];
    // 同一章同一位置重复点"加书签"不算新书签，避免列表里出现一串一模一样的
    const dup = data.bookmarks.find(
      (b) =>
        b.book_id === bookmark.book_id &&
        b.chapter_index === bookmark.chapter_index &&
        Math.abs((b.char_offset || 0) - bookmark.char_offset) <= 1 &&
        (b.selected_text || '') === bookmark.selected_text
    );
    if (dup) return { bookmark: normBookmark(dup), created: false };
    data.bookmarks.push(bookmark);
    writeFile(FILES.bookmarks, data);
    return { bookmark, created: true };
  }

  function patchBookmark(id, changes = {}) {
    const data = readFile(FILES.bookmarks, 'bookmarks');
    data.bookmarks = data.bookmarks || [];
    const at = data.bookmarks.findIndex((b) => b.id === id);
    if (at === -1) {
      throw new ApiError('BOOKMARK_NOT_FOUND', '没找到这个书签，它可能已经被删掉了。', '请刷新书签列表。', 404);
    }
    data.bookmarks[at] = normBookmark({ ...data.bookmarks[at], ...changes, id });
    writeFile(FILES.bookmarks, data);
    return data.bookmarks[at];
  }

  function deleteBookmark(id) {
    const data = readFile(FILES.bookmarks, 'bookmarks');
    data.bookmarks = data.bookmarks || [];
    const before = data.bookmarks.length;
    data.bookmarks = data.bookmarks.filter((b) => b.id !== id);
    if (data.bookmarks.length === before) {
      throw new ApiError('BOOKMARK_NOT_FOUND', '没找到这个书签，它可能已经被删掉了。', '请刷新书签列表。', 404);
    }
    writeFile(FILES.bookmarks, data);
    return true;
  }

  // ---------------------------------------------------------------- 笔记

  function listNotes(filter = {}) {
    const data = readFile(FILES.notes, 'notes');
    let items = (data.notes || []).map(normNote);
    if (filter.book_id) items = items.filter((n) => n.book_id === filter.book_id);
    if (filter.chapter_index !== undefined) {
      items = items.filter((n) => n.chapter_index === Number(filter.chapter_index));
    }
    return items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  }

  function getNote(id) {
    return listNotes().find((n) => n.id === id) || null;
  }

  function addNote(input) {
    const note = normNote({ ...input, id: input && input.id ? input.id : makeId('note') });
    if (!note.book_id) {
      throw new ApiError('NOTE_NO_BOOK', '写笔记时没带上书。', '请重新打开这本书再写笔记。', 400);
    }
    if (!note.selected_text && !note.content) {
      throw new ApiError('NOTE_EMPTY', '这条笔记是空的。', '请先选中一段正文，或写点备注内容。', 400);
    }
    const data = readFile(FILES.notes, 'notes');
    data.notes = data.notes || [];
    data.notes.push(note);
    writeFile(FILES.notes, data);
    return note;
  }

  function patchNote(id, changes = {}) {
    const data = readFile(FILES.notes, 'notes');
    data.notes = data.notes || [];
    const at = data.notes.findIndex((n) => n.id === id);
    if (at === -1) {
      throw new ApiError('NOTE_NOT_FOUND', '没找到这条笔记，它可能已经被删掉了。', '请刷新笔记列表。', 404);
    }
    data.notes[at] = normNote({ ...data.notes[at], ...changes, id, created_at: data.notes[at].created_at });
    writeFile(FILES.notes, data);
    return data.notes[at];
  }

  function deleteNote(id) {
    const data = readFile(FILES.notes, 'notes');
    data.notes = data.notes || [];
    const before = data.notes.length;
    data.notes = data.notes.filter((n) => n.id !== id);
    if (data.notes.length === before) {
      throw new ApiError('NOTE_NOT_FOUND', '没找到这条笔记，它可能已经被删掉了。', '请刷新笔记列表。', 404);
    }
    writeFile(FILES.notes, data);
    return true;
  }

  // ---------------------------------------------------------------- 跳章历史

  function readHistory() {
    const raw = io.readJson(FILES.history, null);
    if (!raw || typeof raw !== 'object') return { entries: [], cursor: {} };
    return {
      entries: Array.isArray(raw.entries) ? raw.entries.map(normHistoryEntry) : [],
      cursor: raw.cursor && typeof raw.cursor === 'object' ? raw.cursor : {},
    };
  }

  /**
   * 记录一次跳章。
   * 与栈顶位置相同就不重复记（用户在同一章里小幅滚动不该塞满历史）。
   * 记录新位置会把"后退游标"归零 —— 相当于浏览器的"新开一页"，再点后退就是回到刚才那页。
   */
  function pushHistory(input) {
    const entry = normHistoryEntry(input);
    const data = readHistory();
    const head = data.entries[0];
    const isSame =
      head &&
      head.book_id === entry.book_id &&
      head.chapter_index === entry.chapter_index &&
      Math.abs(head.char_offset - entry.char_offset) < 40;
    if (!isSame) {
      data.entries.unshift(entry);
      if (data.entries.length > HISTORY_LIMIT) data.entries.length = HISTORY_LIMIT;
      data.cursor[entry.book_id] = 0;
      writeFile(FILES.history, data);
    }
    return { entry, skipped: Boolean(isSame) };
  }

  function listHistory(filter = {}) {
    let entries = readHistory().entries;
    if (filter.book_id) entries = entries.filter((e) => e.book_id === filter.book_id);
    return entries.slice(0, filter.limit || 50);
  }

  /**
   * "返回上一处"。
   * cursor 记录这本书已经后退到第几条，连续点后退会一路往回走，而不是在两处之间反复横跳。
   */
  function historyBack(bookId) {
    if (!bookId) {
      throw new ApiError('HISTORY_NO_BOOK', '不知道要回到哪本书。', '请先从阅读器里打开这本书。', 400);
    }
    const data = readHistory();
    const start = Number(data.cursor[bookId] || 0) + 1;
    for (let i = start; i < data.entries.length; i++) {
      if (data.entries[i].book_id === bookId) {
        data.cursor[bookId] = i;
        writeFile(FILES.history, data);
        return { entry: data.entries[i], cursor: i };
      }
    }
    return { entry: null, cursor: data.cursor[bookId] || 0 };
  }

  // ---------------------------------------------------------------- 阅读时长

  function readSessions() {
    const raw = io.readJson(FILES.sessions, null);
    if (!raw || !Array.isArray(raw.sessions)) return [];
    return raw.sessions.map(normSession);
  }

  function recordSession(input) {
    const session = normSession({ ...input, day: input.day || localDay(input.started_at || new Date()) });
    if (!session.book_id) {
      throw new ApiError('SESSION_NO_BOOK', '这次阅读时长没有带上书。', '请重新打开这本书再读。', 400);
    }
    const sessions = readSessions();
    sessions.unshift(session);
    if (sessions.length > SESSION_LIMIT) sessions.length = SESSION_LIMIT;
    writeFile(FILES.sessions, { sessions });
    return session;
  }

  /**
   * 时长统计。
   * @param {{book_id?:string, from?:string, to?:string}} filter from/to 为 YYYY-MM-DD
   */
  function stats(filter = {}) {
    let sessions = readSessions();
    if (filter.book_id) sessions = sessions.filter((s) => s.book_id === filter.book_id);
    if (filter.from) sessions = sessions.filter((s) => s.day >= filter.from);
    if (filter.to) sessions = sessions.filter((s) => s.day <= filter.to);

    let totalMs = 0;
    const byDay = new Map();
    const byBook = new Map();
    for (const s of sessions) {
      totalMs += s.duration_ms;
      byDay.set(s.day, (byDay.get(s.day) || 0) + s.duration_ms);
      byBook.set(s.book_id, (byBook.get(s.book_id) || 0) + s.duration_ms);
    }

    return {
      totalMs,
      sessionCount: sessions.length,
      byDay: [...byDay.entries()]
        .map(([day, ms]) => ({ day, ms }))
        .sort((a, b) => b.day.localeCompare(a.day)),
      byBook: [...byBook.entries()]
        .map(([book_id, ms]) => ({ book_id, ms }))
        .sort((a, b) => b.ms - a.ms),
    };
  }

  /** 本周阅读时长（首页底部概览要显示"本周读了多久"） */
  function weekMs(now = new Date()) {
    const from = localDay(startOfWeek(now));
    const to = localDay(now);
    return stats({ from, to }).totalMs;
  }

  /** 整库时长概览：总时长 + 按书 + 本周 */
  function overview() {
    const all = stats();
    return { totalMs: all.totalMs, weekMs: weekMs(), byBook: all.byBook };
  }

  // ---------------------------------------------------------------- 入库同步

  /**
   * 阅读行为要反向影响书架（PRD §5.1）：
   *   进度更新 → 书的 last_read_at / read_chapters / status 跟着变，
   *   首页的「继续阅读」卡片、封面进度条、分堆归属都靠这个。
   * 抽成一个函数，避免每处调用都自己算一遍导致口径不一致。
   */
  function syncBookFromProgress(bookId) {
    const book = ctx.library.get(bookId);
    if (!book) return null;
    const progress = getProgress(bookId);
    if (!progress) return book;

    const readChapters = Math.max(book.read_chapters, progress.chapter_index);
    let status = book.status;
    if (book.total_chapters > 0 && readChapters >= book.total_chapters) status = '已读完';
    else if (status === '未读' || status === '已读完') status = '在读';

    return ctx.library.patch(bookId, {
      last_read_at: progress.updated_at,
      read_chapters: readChapters,
      status,
    });
  }

  return {
    FILES,
    HISTORY_LIMIT,
    localDay,
    startOfWeek,

    allProgress,
    getProgress,
    setProgress,
    removeProgress,
    recentProgress,
    resolvePosition,

    listBookmarks,
    addBookmark,
    patchBookmark,
    deleteBookmark,

    listNotes,
    getNote,
    addNote,
    patchNote,
    deleteNote,

    pushHistory,
    listHistory,
    historyBack,

    readSessions,
    recordSession,
    stats,
    weekMs,
    overview,
    syncBookFromProgress,
  };
};

module.exports.localDay = localDay;
module.exports.startOfWeek = startOfWeek;
module.exports.FILES = FILES;
