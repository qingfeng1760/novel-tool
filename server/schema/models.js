'use strict';
/**
 * models.js —— 核心数据模型（PRD §6.3 的唯一落地点）。
 *
 * 为什么要有这么一层：
 * PRD 做事方式第 1 条要求"先把数据模型定下来再动手写界面，模型定错后面全是返工"。
 * 所以所有实体都由这里的 norm* 函数产出，字段名、类型、默认值、枚举只有这一处定义。
 * 路由、服务、测试都从这里取，不会出现"某处写了 novelId、另一处写 book_id"的情况。
 *
 * 关于 updatedAt 与 updated_at 同时存在：
 *   - `updated_at` / `created_at` 是 PRD §6.3 给每个实体定义的**业务时间**；
 *   - `updatedAt` 是 PRD §7 要求"所有实体都带"的**同步与迁移字段**。
 *   它们在同一次写入里一起刷新，永不背离。将来接云同步时只读 updatedAt 做冲突判断。
 */

const {
  SCHEMA_VERSION,
  SYNC_STATE_LOCAL,
  DEFAULT_OWNER_ID,
  BOOK_STATUS,
  FETCH_STATUS,
} = require('../lib/constants');
const { ApiError } = require('../lib/errors');

const BOOK_STATUS_VALUES = Object.values(BOOK_STATUS);
const FETCH_STATUS_VALUES = Object.values(FETCH_STATUS);

/** 书籍内容是从哪条路进来的（模块 1/2/3/7 三条路 + 未知） */
const SOURCE_KINDS = ['local', 'web', 'userscript'];

/** 追更检查频率（PRD 模块 2：每天 / 每 3 天 / 每周 / 手动） */
const CHECK_MODES = ['manual', 'daily', 'every3days', 'weekly'];

/** 频率 → 间隔天数。'manual' 不排期 */
const CHECK_MODE_DAYS = {
  manual: null,
  daily: 1,
  every3days: 3,
  weekly: 7,
};

const CHECK_MODE_LABEL = {
  manual: '手动',
  daily: '每天',
  every3days: '每 3 天',
  weekly: '每周',
};

/** 章节的三种状态（PRD 模块 4：成功 / 失败 / 缺失） */
const CHAPTER_STATE = {
  OK: '成功',
  FAILED: '失败',
  MISSING: '缺失',
};

function nowIso() {
  return new Date().toISOString();
}

// ------------------------------------------------------------------ 取值助手

function asString(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function asTrimmed(value, fallback = '') {
  return asString(value, fallback).trim();
}

function asInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(n);
}

function asNonNegativeInt(value, fallback = 0) {
  const n = asInt(value, fallback);
  return n < 0 ? 0 : n;
}

function asBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === '1' || value === 1) return true;
  if (value === 'false' || value === '0' || value === 0) return false;
  return Boolean(value);
}

function asIsoOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function asStringArray(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    const text = asTrimmed(item);
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function asEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function clampRatio(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

/**
 * PRD §7 要求的同步与迁移字段。所有实体都带这四个，无一例外。
 */
function versioning(input = {}, timestamp) {
  return {
    updatedAt: asIsoOrNull(input.updatedAt) || timestamp || nowIso(),
    schemaVersion: SCHEMA_VERSION,
    syncState: SYNC_STATE_LOCAL,
    owner_id: asTrimmed(input.owner_id, DEFAULT_OWNER_ID) || DEFAULT_OWNER_ID,
  };
}

// ------------------------------------------------------------------ Book

/**
 * 规范化一本书。宽容地补默认值，不抛错（读旧数据时不希望因为缺字段就崩）。
 * 需要严格校验时用 assertValidBook。
 */
function normBook(input = {}) {
  const created = asIsoOrNull(input.created_at) || nowIso();
  const book = {
    book_id: asTrimmed(input.book_id),
    title: asTrimmed(input.title),
    author: asTrimmed(input.author),
    /** 封面：v1 不做图片模式，这里只存一个标识（可空） */
    cover: input.cover ? asTrimmed(input.cover) : null,
    source_site: asTrimmed(input.source_site, 'local') || 'local',
    toc_url: input.toc_url ? asTrimmed(input.toc_url) : null,
    intro: asString(input.intro),
    tags: asStringArray(input.tags),

    created_at: created,
    last_read_at: asIsoOrNull(input.last_read_at),

    /** 来源信息（模块 4 详情页要展示来源站点 / 目录页 / 首次抓取 / 最后检查） */
    first_fetched_at: asIsoOrNull(input.first_fetched_at),
    last_checked_at: asIsoOrNull(input.last_checked_at),
    last_updated_at: asIsoOrNull(input.last_updated_at),
    source_kind: asEnum(asTrimmed(input.source_kind), SOURCE_KINDS, 'local'),

    total_chapters: asNonNegativeInt(input.total_chapters),
    read_chapters: asNonNegativeInt(input.read_chapters),
    /** 追更检查发现的待更新章节数（模块 2/9：只出角标，不自动下载） */
    new_chapters: asNonNegativeInt(input.new_chapters),
    /** 追更频率与下次检查时间（只对有目录页的书有意义） */
    check_mode: asEnum(asTrimmed(input.check_mode), CHECK_MODES, 'manual'),
    next_check_at: asIsoOrNull(input.next_check_at),

    status: asEnum(input.status, BOOK_STATUS_VALUES, BOOK_STATUS.UNREAD),
    fetch_status: asEnum(input.fetch_status, FETCH_STATUS_VALUES, FETCH_STATUS.NONE),

    // 章节清单只存在于 books/<id>/book.json；写进 library.json 的摘要会去掉它
    chapters: Array.isArray(input.chapters) ? input.chapters.map(normChapter) : [],

    ...versioning(input, asIsoOrNull(input.updatedAt) || created),
  };

  // 已读章节数不能超过总章节数，否则书架的进度条会超过 100%
  if (book.read_chapters > book.total_chapters) book.read_chapters = book.total_chapters;
  return book;
}

/** 校验一本书是否具备落盘条件；返回问题列表（空数组 = 通过） */
function validateBook(book) {
  const problems = [];
  if (!book || typeof book !== 'object') return ['书的数据不是对象'];
  if (!book.book_id) problems.push('缺少 book_id（书编号）');
  else if (!/^[0-9a-zA-Z_-]+$/.test(book.book_id)) {
    problems.push('book_id 只能包含字母、数字、下划线和短横线');
  }
  if (!book.title) problems.push('缺少书名');
  if (!BOOK_STATUS_VALUES.includes(book.status)) {
    problems.push(`状态只能是：${BOOK_STATUS_VALUES.join(' / ')}`);
  }
  if (!FETCH_STATUS_VALUES.includes(book.fetch_status)) {
    problems.push(`抓取状态只能是：${FETCH_STATUS_VALUES.join(' / ')}`);
  }
  if (typeof book.total_chapters !== 'number' || book.total_chapters < 0) {
    problems.push('总章节数必须是非负数字');
  }
  if (book.read_chapters > book.total_chapters) problems.push('已读章节数不能大于总章节数');
  if (book.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`数据格式版本应为 ${SCHEMA_VERSION}，实际是 ${book.schemaVersion}`);
  }
  if (book.syncState !== SYNC_STATE_LOCAL) {
    problems.push(`syncState 在 v1 里必须是 local，实际是 ${book.syncState}`);
  }
  return problems;
}

function assertValidBook(book) {
  const problems = validateBook(book);
  if (problems.length) {
    throw new ApiError(
      'BOOK_INVALID',
      `这本书的数据不完整：${problems[0]}。`,
      '请检查书名是否填写完整后重试。',
      400
    );
  }
  return book;
}

/** 书在 library.json 里的索引摘要（不含章节清单，避免索引文件膨胀） */
function bookSummary(book) {
  const { chapters, ...rest } = book;
  return { ...rest, chapter_count: Array.isArray(chapters) ? chapters.length : 0 };
}

// ------------------------------------------------------------------ Chapter

/**
 * 规范化一章。index 从 1 开始（PRD §6.3）。
 */
function normChapter(input = {}, indexFallback) {
  const index = asInt(input.index, asInt(indexFallback, 0));
  const fetchedAt = asIsoOrNull(input.fetched_at);
  return {
    index,
    title: asTrimmed(input.title) || (index > 0 ? `第 ${index} 章` : '未命名章节'),
    char_count: asNonNegativeInt(input.char_count),
    is_ok: asBool(input.is_ok, false),
    fetched_at: fetchedAt,
    content_hash: asTrimmed(input.content_hash),
    // 导入来源的章节没有"抓取"概念，用它区分开，详情页显示才不会误导
    origin: asEnum(asTrimmed(input.origin), ['fetch', 'import', 'userscript', 'manual'], 'manual'),
    ...versioning(input, fetchedAt),
  };
}

/** 章节状态（模块 4 要求区分 成功 / 失败 / 缺失） */
function chapterState(chapter) {
  if (!chapter) return CHAPTER_STATE.MISSING;
  if (chapter.is_ok) return CHAPTER_STATE.OK;
  return chapter.fetched_at ? CHAPTER_STATE.FAILED : CHAPTER_STATE.MISSING;
}

// ------------------------------------------------------------------ Progress

/**
 * 阅读进度。
 *
 * 为什么除 char_offset 之外还要存 chapter_ratio：
 * PRD §6.3 要求"章节总数变化时按「章节序号 + 章内比例」重定位，不要回到开头"。
 * 只有 char_offset 的话，章长变了就无法换算章内位置，所以必须同时记下比例。
 */
function normProgress(input = {}) {
  const stamp = asIsoOrNull(input.updated_at) || asIsoOrNull(input.updatedAt) || nowIso();
  return {
    book_id: asTrimmed(input.book_id),
    chapter_index: Math.max(1, asInt(input.chapter_index, 1)),
    char_offset: asNonNegativeInt(input.char_offset),
    chapter_ratio: clampRatio(input.chapter_ratio, 0),
    percent: clampRatio(input.percent, 0),
    updated_at: stamp,
    ...versioning(input, stamp),
  };
}

// ------------------------------------------------------------------ Bookmark / Note

function normBookmark(input = {}) {
  const created = asIsoOrNull(input.created_at) || nowIso();
  return {
    id: asTrimmed(input.id),
    book_id: asTrimmed(input.book_id),
    chapter_index: Math.max(1, asInt(input.chapter_index, 1)),
    char_offset: asNonNegativeInt(input.char_offset),
    chapter_ratio: clampRatio(input.chapter_ratio, 0),
    selected_text: asString(input.selected_text),
    /** 书签的备注可以为空（PRD §6.3） */
    content: asString(input.content),
    created_at: created,
    ...versioning(input, created),
  };
}

function normNote(input = {}) {
  const created = asIsoOrNull(input.created_at) || nowIso();
  return {
    id: asTrimmed(input.id),
    book_id: asTrimmed(input.book_id),
    chapter_index: Math.max(1, asInt(input.chapter_index, 1)),
    char_offset: asNonNegativeInt(input.char_offset),
    chapter_ratio: clampRatio(input.chapter_ratio, 0),
    /** 摘录的原文 */
    selected_text: asString(input.selected_text),
    /** 用户写的备注 */
    content: asString(input.content),
    created_at: created,
    ...versioning(input, created),
  };
}

// ------------------------------------------------------------------ History

/** 跳章历史的一条记录，用于"返回上一处" */
function normHistoryEntry(input = {}) {
  const at = asIsoOrNull(input.at) || nowIso();
  return {
    book_id: asTrimmed(input.book_id),
    chapter_index: Math.max(1, asInt(input.chapter_index, 1)),
    char_offset: asNonNegativeInt(input.char_offset),
    chapter_title: asTrimmed(input.chapter_title),
    at,
    ...versioning(input, at),
  };
}

// ------------------------------------------------------------------ 阅读时长

/**
 * 一次阅读会话（模块 6：按书、按天累计阅读时长）。
 *
 * 说明：PRD §6.1 的数据目录清单里没有列出这个文件，但模块 6 明确要求"阅读时长统计：
 * 按书、按天累计"。这里落在 reading/sessions.json —— 存原始会话而不是聚合值，
 * 因为聚合可以随时重算，原始记录丢了就算不回来了。
 */
function normSession(input = {}) {
  const startedAt = asIsoOrNull(input.started_at) || nowIso();
  return {
    book_id: asTrimmed(input.book_id),
    started_at: startedAt,
    ended_at: asIsoOrNull(input.ended_at) || startedAt,
    duration_ms: asNonNegativeInt(input.duration_ms),
    /** 本地日期 YYYY-MM-DD，按天统计时直接分组，避免每次都做时区换算 */
    day: asTrimmed(input.day) || startedAt.slice(0, 10),
    ...versioning(input, startedAt),
  };
}

// ------------------------------------------------------------------ 统一校验入口

const NORMALIZERS = {
  book: normBook,
  chapter: normChapter,
  progress: normProgress,
  bookmark: normBookmark,
  note: normNote,
  history: normHistoryEntry,
  session: normSession,
};

function normalize(type, input) {
  const fn = NORMALIZERS[type];
  if (!fn) throw new Error(`没有这个数据模型：${type}`);
  return fn(input);
}

module.exports = {
  SCHEMA_VERSION,
  BOOK_STATUS,
  BOOK_STATUS_VALUES,
  FETCH_STATUS,
  FETCH_STATUS_VALUES,
  SOURCE_KINDS,
  CHECK_MODES,
  CHECK_MODE_DAYS,
  CHECK_MODE_LABEL,
  CHAPTER_STATE,
  nowIso,
  versioning,
  normBook,
  validateBook,
  assertValidBook,
  bookSummary,
  normChapter,
  chapterState,
  normProgress,
  normBookmark,
  normNote,
  normHistoryEntry,
  normSession,
  normalize,
  // 供测试和上层复用的取值助手
  asString,
  asTrimmed,
  asInt,
  asNonNegativeInt,
  asBool,
  asIsoOrNull,
  asStringArray,
  clampRatio,
};
