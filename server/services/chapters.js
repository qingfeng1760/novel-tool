'use strict';
/**
 * chapters.js —— 章节目录的质量管理（PRD 模块 4）。
 *
 * 承担四件事：
 *   1. 目录体检：把序号跳跃 / 标题重复 / 空章节 / 缺失章挑出来，让用户一眼看到哪几章有问题；
 *   2. 更新对比：和上一次检查时的目录快照比，得出"新增 N 章 / 修订 M 章 / 无变化"；
 *   3. 重新分章：导入的 TXT 分章不理想时按规则重跑（先预览再确认）；
 *   4. 手工调章：拆章 / 合并 / 改标题 / 删章。
 *
 * 为什么重新分章要"先把正文拼回去再重新切"：
 *   一本已经入库的书只剩下"每一章的正文"，原始 TXT 已经不在了。
 *   所以做法是：把「标题 + 正文」按顺序拼回一份完整文本，再用新规则切一遍。
 *   这样即使用户改了好几次规则，也不会越切越碎。
 */

const { ApiError, Errors } = require('../lib/errors');
const { chapterState, normChapter, nowIso } = require('../schema/models');
const { contentHash } = require('./store');

/** 目录快照文件：每次抓取/检查更新后写一份，用来做"更新对比" */
const SNAPSHOT_FILE = 'toc-snapshot.json';

/** 中文数字 → 阿拉伯数字（体检时判断"序号跳跃"要用） */
const CN_DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const CN_UNITS = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

/** 把标题里的数字抽出来（支持「第12章」「第十二章」「第 3 回」） */
function extractChapterNumber(title) {
  const hit = /第\s*([0-9０-９零〇一二三四五六七八九十百千万两]{1,12})\s*[章回节卷篇集]/.exec(String(title || ''));
  if (!hit) {
    const simple = /^\s*(\d{1,5})\s*[.．、:：]/.exec(String(title || ''));
    if (simple) return Number(simple[1]);
    const chapter = /Chapter\s*(\d{1,5})/i.exec(String(title || ''));
    return chapter ? Number(chapter[1]) : null;
  }

  const raw = hit[1];
  if (/^[0-9０-９]+$/.test(raw)) {
    return Number(raw.replace(/[０-９]/g, (ch) => String(ch.charCodeAt(0) - 0xff10)));
  }

  // 中文数字：逐字累加，够用于"第几百章"这种量级
  let total = 0;
  let section = 0;
  let last = 0;
  for (const ch of raw) {
    if (CN_DIGITS[ch] !== undefined) {
      last = CN_DIGITS[ch];
      section = section * 10 + last; // 「十二」这种十位在前的写法
    } else if (CN_UNITS[ch]) {
      const unit = CN_UNITS[ch];
      if (section === 0) section = 1;
      total += section * unit;
      section = 0;
    }
  }
  total += section;
  return total || null;
}

module.exports = function createChaptersService(ctx) {
  const io = ctx.storage;
  const { library } = ctx;

  function snapshotPath(bookId) {
    return `${library.bookDir(bookId)}/${SNAPSHOT_FILE}`;
  }

  // ---------------------------------------------------------------- 列表

  /** 章节清单（带状态与字数），供详情页展示 */
  function list(bookId) {
    const book = library.require(bookId);
    return {
      book_id: book.book_id,
      title: book.title,
      total: book.chapters.length,
      chapters: book.chapters.map((ch) => ({
        index: ch.index,
        title: ch.title,
        char_count: ch.char_count,
        is_ok: ch.is_ok,
        fetched_at: ch.fetched_at,
        state: chapterState(ch),
        origin: ch.origin,
      })),
    };
  }

  function read(bookId, index) {
    const book = library.require(bookId);
    const meta = book.chapters[Number(index) - 1];
    if (!meta) throw Errors.chapterNotFound(index);
    const content = library.readChapterText(bookId, index);
    return { ...meta, state: chapterState(meta), content: content === null ? null : content, missing_file: content === null };
  }

  // ---------------------------------------------------------------- 目录体检

  /**
   * 目录体检。
   * 四类问题都要能定位到具体哪一章，界面上才好做"只看异常"。
   */
  function diagnose(bookId) {
    const book = library.require(bookId);
    const issues = [];

    const titleMap = new Map();
    let previousNumber = null;
    let previousIndexAtNumber = null;

    book.chapters.forEach((chapter, i) => {
      const position = i + 1;

      // 1. 章节空了
      if (!chapter.char_count) {
        issues.push({
          type: 'empty',
          level: 'error',
          chapter_index: position,
          title: chapter.title,
          message: `第 ${position} 章是空的，没有正文。`,
          hint: '可以删除这一章，或者有来源页的话对它单独重新抓取。',
        });
      }
      // 2. 抓取失败 / 缺失
      else if (!chapter.is_ok) {
        const state = chapterState(chapter);
        issues.push({
          type: state === '失败' ? 'failed' : 'missing',
          level: 'error',
          chapter_index: position,
          title: chapter.title,
          message: `第 ${position} 章${state === '失败' ? '抓取失败' : '还没有抓到正文'}。`,
          hint: '可以在抓取控制台里只重试这一章。',
        });
      }

      // 3. 标题重复
      const key = String(chapter.title).trim();
      if (key) {
        if (titleMap.has(key)) {
          issues.push({
            type: 'duplicate',
            level: 'warn',
            chapter_index: position,
            title: chapter.title,
            message: `第 ${position} 章的标题和第 ${titleMap.get(key)} 章一样。`,
            hint: '如果是同一章重复入库，可以删掉其中一章；如果只是标题太像，可以手工改掉标题。',
          });
        } else {
          titleMap.set(key, position);
        }
      }

      // 4. 序号跳跃（标题里的数字和实际顺序对不上）
      const number = extractChapterNumber(chapter.title);
      if (number !== null) {
        if (previousNumber !== null && number !== previousNumber + 1) {
          issues.push({
            type: 'jump',
            level: 'warn',
            chapter_index: position,
            title: chapter.title,
            message: `标题里的序号是 ${number}，上一章是 ${previousNumber}，中间对不上。`,
            hint: '可能是漏抓了中间几章，也可能是标题本身写错了。可以在抓取报告里核对一下。',
          });
        }
        previousNumber = number;
        previousIndexAtNumber = position;
      }
    });

    const summary = {
      total: book.chapters.length,
      jump: issues.filter((i) => i.type === 'jump').length,
      duplicate: issues.filter((i) => i.type === 'duplicate').length,
      empty: issues.filter((i) => i.type === 'empty').length,
      failed: issues.filter((i) => i.type === 'failed').length,
      missing: issues.filter((i) => i.type === 'missing').length,
    };
    void previousIndexAtNumber;

    return {
      book_id: book.book_id,
      summary,
      issues,
      hasIssues: issues.length > 0,
      /** 体检结论一句话，界面直接显示 */
      verdict: issues.length
        ? `发现 ${issues.length} 处需要留意的地方。`
        : '目录看起来很干净，没有发现异常。',
    };
  }

  // ---------------------------------------------------------------- 更新对比

  function writeSnapshot(bookId) {
    const book = library.require(bookId);
    const payload = {
      takenAt: nowIso(),
      chapters: book.chapters.map((ch) => ({
        index: ch.index,
        title: ch.title,
        content_hash: ch.content_hash,
        char_count: ch.char_count,
      })),
    };
    io.writeJson(snapshotPath(bookId), payload);
    return payload;
  }

  function readSnapshot(bookId) {
    return io.readJson(snapshotPath(bookId), null);
  }

  /**
   * 更新对比（PRD 模块 4）。
   * 新增 = 现有章里比快照多出来的尾巴；修订 = 同一序号但内容哈希变了。
   */
  function diff(bookId) {
    const book = library.require(bookId);
    const snapshot = readSnapshot(bookId);

    if (!snapshot || !Array.isArray(snapshot.chapters)) {
      return {
        book_id: book.book_id,
        takenAt: null,
        hasSnapshot: false,
        added: [],
        revised: [],
        removed: [],
        unchanged: book.chapters.length,
        summary: '还没有上次检查的记录，暂时没法对比。抓取或做一次更新检查之后就能对比了。',
      };
    }

    const oldByIndex = new Map(snapshot.chapters.map((ch) => [ch.index, ch]));
    const added = [];
    const revised = [];
    const unchangedIndexes = new Set();

    for (const chapter of book.chapters) {
      const before = oldByIndex.get(chapter.index);
      if (!before) {
        added.push({ index: chapter.index, title: chapter.title, char_count: chapter.char_count });
        continue;
      }
      if (before.content_hash && chapter.content_hash && before.content_hash !== chapter.content_hash) {
        revised.push({
          index: chapter.index,
          title: chapter.title,
          title_before: before.title,
          title_changed: before.title !== chapter.title,
          char_count_before: before.char_count,
          char_count: chapter.char_count,
        });
      } else {
        unchangedIndexes.add(chapter.index);
      }
    }

    const removed = snapshot.chapters
      .filter((ch) => !book.chapters.some((c) => c.index === ch.index))
      .map((ch) => ({ index: ch.index, title: ch.title }));

    const parts = [];
    parts.push(added.length ? `新增 ${added.length} 章` : '');
    parts.push(revised.length ? `修订 ${revised.length} 章` : '');
    parts.push(removed.length ? `少了 ${removed.length} 章` : '');
    const summary = parts.filter(Boolean).length
      ? parts.filter(Boolean).join(' / ')
      : '和上次检查相比没有变化';

    return {
      book_id: book.book_id,
      takenAt: snapshot.takenAt,
      hasSnapshot: true,
      added,
      revised,
      removed,
      unchanged: unchangedIndexes.size,
      summary,
    };
  }

  // ---------------------------------------------------------------- 重新分章

  /** 把已入库的章节拼回一份完整文本（标题 + 正文），供重新分章使用 */
  function rebuildSourceText(bookId) {
    const book = library.require(bookId);
    const parts = [];
    for (const chapter of book.chapters) {
      const content = library.readChapterText(bookId, chapter.index);
      // 把原章节标题也写回去，这样"按标题切"的规则依然能认出边界
      parts.push(chapter.title);
      if (content) parts.push(content);
    }
    return parts.join('\n\n');
  }

  /**
   * 重新分章。
   * preview: true 时只回报结果，不动数据 —— PRD 要求"先预览再确认"。
   */
  function rechapterize(bookId, options = {}) {
    const book = library.require(bookId);
    const text = rebuildSourceText(bookId);
    const result = ctx.chapterize.chapterize(text, {
      ruleId: options.rule_id || options.ruleId,
      pattern: options.pattern,
      flags: options.flags,
      maxLineLength: options.max_line_length,
    });

    const preview = {
      book_id: book.book_id,
      before: book.chapters.length,
      after: result.chapters.length,
      matched: result.matched,
      rule: result.rule,
      /** 只给前若干条明细，避免大书把响应撑爆 */
      chapters: result.chapters.slice(0, options.limit || 80).map((ch) => ({
        index: ch.index,
        title: ch.title,
        char_count: ch.char_count,
        preview: ch.content.slice(0, 60),
      })),
      applied: false,
    };

    if (!options.confirm) {
      preview.hint =
        result.matched === 0
          ? '按这个规则一章都没认出来，先别应用，换一套规则再试试。'
          : `将把现在的 ${preview.before} 章重排成 ${preview.after} 章。确认无误再应用。`;
      return preview;
    }

    // 应用：整本重写。写之前先把旧目录留一份快照，出问题还能看出原来是什么样
    writeSnapshot(bookId);
    library.writeChapters(
      bookId,
      result.chapters.map((ch) => ({
        index: ch.index,
        title: ch.title,
        content: ch.content,
        is_ok: true,
        origin: 'manual',
      })),
      { origin: 'manual' }
    );

    return { ...preview, applied: true, hint: `已经按新规则重排成 ${result.chapters.length} 章。` };
  }

  // ---------------------------------------------------------------- 手工调章

  /** 把从 from 到最后一章的正文读进内存（后续平移序号时要用） */
  function readTail(bookId, from) {
    const book = library.require(bookId);
    const out = [];
    for (let i = from; i <= book.chapters.length; i++) {
      out.push({
        index: i,
        title: book.chapters[i - 1].title,
        content: library.readChapterText(bookId, i) || '',
      });
    }
    return out;
  }

  /** 拆章：把某一章从指定字符偏移处切成两章 */
  function split(bookId, index, options = {}) {
    const book = library.require(bookId);
    const position = Math.trunc(Number(index));
    const chapter = book.chapters[position - 1];
    if (!chapter) throw Errors.chapterNotFound(index);

    const content = library.readChapterText(bookId, position) || '';
    let at = Number(options.at_offset);
    if (!Number.isFinite(at) || at <= 0) {
      // 没给位置就按正文中点切，并尽量落在换行处，免得把一句话劈成两半
      const middle = Math.floor(content.length / 2);
      const newline = content.indexOf('\n', middle);
      at = newline === -1 ? middle : newline + 1;
    }
    if (at <= 0 || at >= content.length) {
      throw new ApiError(
        'SPLIT_POSITION_INVALID',
        '这个拆分位置在这一章的内容之外。',
        `这一章一共 ${content.length} 个字符，请把位置放在 1 到 ${content.length - 1} 之间。`,
        400
      );
    }

    const firstPart = content.slice(0, at).replace(/\n+$/, '');
    const secondPart = content.slice(at).replace(/^\n+/, '');
    const secondTitle = String(options.title || '').trim() || `${chapter.title}（下）`;

    const tail = readTail(bookId, position + 1); // 后面几章的正文先拿出来，序号要往后挪一位
    const newTail = [
      { title: chapter.title, content: firstPart, origin: 'manual' },
      { title: secondTitle, content: secondPart, origin: 'manual' },
      ...tail.map((item) => ({ title: item.title, content: item.content, origin: 'manual' })),
    ];

    const saved = library.rewriteFrom(bookId, position, newTail);
    return {
      book_id: bookId,
      total: saved.chapters.length,
      split_into: [position, position + 1],
      message: `已经把第 ${position} 章拆成两章：第 ${position} 章和第 ${position + 1} 章。`,
    };
  }

  /** 合并：把从 index 开始的 count 章并成一章 */
  function merge(bookId, index, options = {}) {
    const book = library.require(bookId);
    const position = Math.trunc(Number(index));
    const count = Math.max(2, Math.trunc(Number(options.count) || 2));
    if (!book.chapters[position - 1]) throw Errors.chapterNotFound(index);
    if (position - 1 + count > book.chapters.length) {
      throw new ApiError(
        'MERGE_OUT_OF_RANGE',
        '要合并的章节数超出了这本书的末尾。',
        `从第 ${position} 章起一共只剩 ${book.chapters.length - position + 1} 章。`,
        400
      );
    }

    const targets = [];
    for (let i = position; i < position + count; i++) {
      targets.push({
        title: book.chapters[i - 1].title,
        content: library.readChapterText(bookId, i) || '',
      });
    }

    // 合并后的正文里保留原来每一章的标题，用户回头还能看出内容来自哪儿
    const parts = [];
    for (const target of targets) {
      parts.push(`【${target.title}】`);
      if (target.content) parts.push(target.content);
    }
    const mergedTitle =
      String(options.title || '').trim() || `${targets[0].title} ～ ${targets[targets.length - 1].title}`;
    const mergedContent = parts.join('\n\n');

    const tail = readTail(bookId, position + count);
    const newTail = [
      { title: mergedTitle, content: mergedContent, origin: 'manual' },
      ...tail.map((item) => ({ title: item.title, content: item.content, origin: 'manual' })),
    ];

    const saved = library.rewriteFrom(bookId, position, newTail);
    return {
      book_id: bookId,
      total: saved.chapters.length,
      title: mergedTitle,
      message: `已经把第 ${position} 到 ${position + count - 1} 章合并成一章。`,
    };
  }

  function rename(bookId, index, title) {
    const book = library.require(bookId);
    const position = Number(index);
    if (!book.chapters[position - 1]) throw Errors.chapterNotFound(index);
    const next = String(title == null ? '' : title).trim();
    if (!next) {
      throw new ApiError('TITLE_REQUIRED', '章节标题不能改成空的。', '请填写一个标题。', 400);
    }
    return library.writeChapter(bookId, position, library.readChapterText(bookId, position) || '', {
      title: next,
      origin: book.chapters[position - 1].origin || 'manual',
    });
  }

  function removeChapter(bookId, index) {
    library.require(bookId);
    const before = library.get(bookId).chapters.length;
    library.deleteChapter(bookId, index);
    return { book_id: bookId, total: before - 1, message: `第 ${index} 章已删除，后面的章节序号已经往前补上。` };
  }

  /** 单章重新抓取（真正的抓取由 S7 的 fetcher 提供；这里负责入口与兜底说明） */
  async function refetch(bookId, index) {
    const book = library.require(bookId);
    const position = Number(index);
    if (!book.chapters[position - 1]) throw Errors.chapterNotFound(index);

    if (!book.toc_url) {
      throw new ApiError(
        'NO_SOURCE',
        '这本书是导入进来的，没有来源页，没法重新抓取。',
        '可以重新导入一次原始文件，或者在详情页手工调整这一章。',
        400
      );
    }
    if (!ctx.fetcher || typeof ctx.fetcher.refetchChapter !== 'function') {
      throw new ApiError(
        'FETCH_NOT_READY',
        '抓取功能还没有准备好。',
        '请稍后再试，或者先用手工调章处理这一章。',
        501
      );
    }
    return ctx.fetcher.refetchChapter(bookId, position);
  }

  /** 单章导出 */
  function exportChapter(bookId, index) {
    const book = library.require(bookId);
    const chapter = book.chapters[Number(index) - 1];
    if (!chapter) throw Errors.chapterNotFound(index);
    const content = library.readChapterText(bookId, index);
    const text = `${chapter.title}\n\n${content == null ? '' : content}\n`;
    const safeTitle = String(chapter.title).replace(/[\\/:*?"<>|]/g, '_');
    return { filename: `${book.title} - ${safeTitle}.txt`, text };
  }

  /** 内容哈希（供追更判断"这一章内容有没有变"） */
  function hashOf(text) {
    return contentHash(text);
  }

  /** 把一章规范化（供手工调章后的清单整理） */
  function normalizeChapter(chapter, index) {
    return normChapter(chapter, index);
  }

  return {
    SNAPSHOT_FILE,
    extractChapterNumber,
    list,
    read,
    diagnose,
    writeSnapshot,
    readSnapshot,
    diff,
    rebuildSourceText,
    rechapterize,
    split,
    merge,
    rename,
    removeChapter,
    refetch,
    exportChapter,
    hashOf,
    normalizeChapter,
  };
};

module.exports.extractChapterNumber = extractChapterNumber;
module.exports.SNAPSHOT_FILE = SNAPSHOT_FILE;
