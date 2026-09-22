'use strict';
/**
 * search.js —— 全文检索与重名书合并（PRD 模块 8）。
 *
 * 索引结构（为什么不是一个整块 fulltext.json）：
 *   PRD §6.1 里写的是单个 `index/fulltext.json`。这里拆成：
 *     index/fulltext.json      索引元信息（构建时间、收录了哪些书）
 *     index/books/<id>.json    每本书一个分片，存这本书各章的规范化正文
 *   原因是：单文件方案下，每导入或每抓完一本书都要把整个索引重写一遍，
 *   大库时就是上百 MB 的磁盘写；分片方案只重写那一本书，导入完立刻可用。
 *   索引整体坏掉也不要紧 —— 一键重建即可（PRD 明确"损坏可重建"）。
 *
 * 中文检索的做法：
 *   不做分词（小说里人名/生造词太多，分词器切不准反而误判），
 *   直接做子串匹配，并把命中位置前后的文字作为片段返回。
 *   代价是索引里存了正文的一份副本，好处是命中稳定、片段的上下文一定准确。
 */

const path = require('path');
const { ApiError, Errors } = require('../lib/errors');
const { SCHEMA_VERSION } = require('../lib/constants');
const { nowIso } = require('../schema/models');

/** 索引元信息文件（保留 PRD 里约定的这个名字） */
const META_FILE = 'index/fulltext.json';
/** 每本书一个分片的目录 */
const SHARD_DIR = 'index/books';

/** 单个片段前后各取多少字 */
const SNIPPET_PAD = 34;
/** 每个章节最多返回几个片段（够用户判断就行，不必把所有命中都吐出来） */
const SNIPPETS_PER_CHAPTER = 3;

/** 规范化正文：去掉多余空白，便于"跨换行也能搜到" */
function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/** 书名的"骨架"：去掉标点、空格、括号里的内容，用来判断重名 */
function titleSkeleton(title) {
  return String(title || '')
    .replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・:：\-_—.,，。！!？?、'"“”‘’《》<>]/g, '')
    .toLowerCase();
}

/** 字符二元组集合，用来算相似度（中文没空格，二元组是最稳的近似） */
function bigrams(text) {
  const set = new Set();
  const value = String(text || '');
  for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
  if (value.length === 1) set.add(value);
  return set;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter++;
  return inter / (a.size + b.size - inter);
}

module.exports = function createSearchService(ctx) {
  const io = ctx.storage;
  const { library } = ctx;

  function shardPath(bookId) {
    return path.posix.join(SHARD_DIR, `${bookId}.json`);
  }

  function readMeta() {
    const raw = io.readJson(META_FILE, null);
    if (!raw || typeof raw !== 'object') {
      return {
        schemaVersion: SCHEMA_VERSION,
        syncState: 'local',
        owner_id: 'local',
        shardDir: SHARD_DIR,
        books: [],
        builtAt: null,
        updatedAt: null,
      };
    }
    return {
      ...raw,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      books: Array.isArray(raw.books) ? raw.books : [],
      // 元信息与分片目录必须一致，否则说明有人手工改过
      shardDir: SHARD_DIR,
    };
  }

  function writeMeta(meta) {
    io.writeJson(META_FILE, { ...meta, updatedAt: nowIso() });
    return meta;
  }

  /** 给一本书建分片 */
  function indexBook(bookId) {
    const book = library.get(bookId);
    if (!book) {
      // 书已经被移除了：顺手把分片也清掉，免得索引里留下幽灵
      removeBook(bookId);
      return null;
    }

    const chapters = book.chapters.map((chapter) => {
      const content = library.readChapterText(bookId, chapter.index);
      return {
        index: chapter.index,
        title: chapter.title,
        char_count: chapter.char_count,
        content_hash: chapter.content_hash,
        text: normalizeText(content == null ? '' : content),
      };
    });

    const shard = {
      schemaVersion: SCHEMA_VERSION,
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      tags: book.tags,
      source_site: book.source_site,
      indexedAt: nowIso(),
      chapters,
    };
    io.writeJson(shardPath(bookId), shard);

    // 更新元信息里的书单
    const meta = readMeta();
    const entry = {
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      chapterCount: chapters.length,
      charCount: chapters.reduce((sum, c) => sum + (c.text ? c.text.length : 0), 0),
    };
    const at = meta.books.findIndex((b) => b.book_id === bookId);
    if (at === -1) meta.books.push(entry);
    else meta.books[at] = entry;
    if (!meta.builtAt) meta.builtAt = nowIso();
    writeMeta(meta);

    return shard;
  }

  function removeBook(bookId) {
    io.remove(shardPath(bookId));
    const meta = readMeta();
    const before = meta.books.length;
    meta.books = meta.books.filter((b) => b.book_id !== bookId);
    if (meta.books.length !== before) writeMeta(meta);
    return before !== meta.books.length;
  }

  /** 一键重建：把整个索引目录清掉重来 */
  function reindex() {
    const shards = io.listFiles(SHARD_DIR, (name) => name.endsWith('.json'));
    const books = library.list();
    for (const shard of shards) io.remove(shard);

    const meta = {
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      shardDir: SHARD_DIR,
      books: [],
      builtAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeMeta(meta);

    let indexed = 0;
    for (const book of books) {
      if (indexBook(book.book_id)) indexed++;
    }

    const after = readMeta();
    return {
      indexed,
      bookCount: after.books.length,
      charCount: after.books.reduce((sum, b) => sum + b.charCount, 0),
      message: `已经重建索引，收录了 ${after.books.length} 本书。`,
    };
  }

  /** 索引状态（设置页显示 / 判断要不要重建） */
  function status() {
    const meta = readMeta();
    const shards = io.listFiles(SHARD_DIR, (name) => name.endsWith('.json'));
    const bookCount = library.list().length;
    return {
      built: Boolean(meta.builtAt),
      builtAt: meta.builtAt,
      updatedAt: meta.updatedAt,
      /** 索引里收录的书 vs 书架上实际的书，数量不一致就说明索引该更新了 */
      indexedBooks: meta.books.length,
      shelfBooks: bookCount,
      stale: meta.books.length !== bookCount,
      missingShards: meta.books.filter((b) => !io.exists(shardPath(b.book_id))).map((b) => b.book_id),
      shardCount: shards.length,
      charCount: meta.books.reduce((sum, b) => sum + (b.charCount || 0), 0),
    };
  }

  /** 确保索引是可用的：分片缺了就补，索引没建过就建 */
  function ensureIndex() {
    const state = status();
    if (!state.built || state.stale || state.missingShards.length) {
      reindex();
      return true;
    }
    return false;
  }

  function readShard(bookId) {
    return io.readJson(shardPath(bookId), null);
  }

  /** 找出一段文本里所有命中位置（大小写不敏感） */
  function findMatches(text, keyword) {
    const haystack = String(text || '').toLowerCase();
    const needle = String(keyword || '').toLowerCase();
    const positions = [];
    if (!needle) return positions;
    let from = 0;
    while (positions.length < 200) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      positions.push(at);
      from = at + needle.length;
    }
    return positions;
  }

  function makeSnippet(text, at, keyword) {
    const start = Math.max(0, at - SNIPPET_PAD);
    const end = Math.min(text.length, at + keyword.length + SNIPPET_PAD);
    return {
      text: text.slice(start, end),
      /** 片段里关键词的起始位置，前端据此加粗 */
      offset_in_snippet: at - start,
      prefix_trimmed: start > 0,
      suffix_trimmed: end < text.length,
    };
  }

  /**
   * 搜索。
   * @param {{q:string, scope?:'book'|'library', book_id?:string, limit?:number, snippetPad?:number}} options
   */
  function search(options = {}) {
    const keyword = String(options.q == null ? '' : options.q).trim();
    if (!keyword) {
      throw new ApiError('EMPTY_QUERY', '还没有输入要找的内容。', '在搜索框里输入一个词再回车。', 400);
    }
    if (keyword.length < 1) {
      throw new ApiError('QUERY_TOO_SHORT', '搜索词太短了。', '请至少输入一个字。', 400);
    }

    const scope = options.scope === 'book' ? 'book' : 'library';
    if (scope === 'book' && !options.book_id) {
      throw new ApiError('NO_BOOK_FOR_SCOPE', '要搜全书的话得先说明是哪本书。', '请从书籍详情页进入搜索。', 400);
    }

    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100));
    const needle = keyword.toLowerCase();

    /** 要搜哪些书 */
    let targetIds;
    if (scope === 'book') {
      const book = library.get(options.book_id);
      if (!book) throw Errors.bookNotFound(options.book_id);
      targetIds = [book.book_id];
    } else {
      targetIds = library.list().map((b) => b.book_id);
    }

    const results = [];
    let totalHits = 0;
    let skippedBooks = 0;

    for (const bookId of targetIds) {
      if (results.length >= limit) break;
      let shard = readShard(bookId);
      if (!shard) {
        // 分片不在就现建一个，而不是让用户看到"搜不到"
        shard = indexBook(bookId);
        if (!shard) {
          skippedBooks++;
          continue;
        }
      }
      const item = collectFromShard(shard, needle, keyword);
      if (item) {
        results.push(item);
        totalHits += item.hitCount;
      }
    }

    return {
      q: keyword,
      scope,
      book_id: options.book_id || null,
      /** 一本书一条，每条里带命中的章节与片段 */
      results,
      totalHits,
      matchedBooks: results.length,
      truncated: results.length >= limit,
      skippedBooks,
      /** 什么都没搜到时的引导 */
      hint: results.length
        ? ''
        : '没有找到包含这个内容的章节。可以换个词试试，或者确认这本书已经导入完整。',
    };
  }

  /** 在一本书的分片里找命中 */
  function collectFromShard(shard, needle, keyword) {
    const chapters = [];
    let hitCount = 0;

    for (const chapter of shard.chapters || []) {
      const text = String(chapter.text || '');
      if (!text.toLowerCase().includes(needle)) continue;

      const positions = findMatches(text, keyword);
      if (!positions.length) continue;
      hitCount += positions.length;

      chapters.push({
        chapter_index: chapter.index,
        chapter_title: chapter.title,
        count: positions.length,
        snippets: positions.slice(0, SNIPPETS_PER_CHAPTER).map((pos) => makeSnippet(text, pos, keyword)),
      });
    }

    if (!chapters.length) return null;
    return {
      book_id: shard.book_id,
      title: shard.title,
      author: shard.author,
      hitCount,
      chapterCount: chapters.length,
      chapters,
    };
  }

  // ---------------------------------------------------------------- 重名书

  /**
   * 检测"书名 + 作者高度相似"的书（PRD 模块 8）。
   * 同样的书从不同站点导进来，书名常常差一个字或带不同的后缀，
   * 所以这里用"去噪后的骨架 + 二元组相似度"来判，而不是简单的字符串相等。
   */
  function duplicates() {
    const books = library.list().map((b) => ({
      book_id: b.book_id,
      title: b.title,
      author: b.author,
      source_site: b.source_site,
      total_chapters: b.total_chapters,
      tags: b.tags,
    }));

    const groups = [];
    const used = new Set();

    for (let i = 0; i < books.length; i++) {
      if (used.has(books[i].book_id)) continue;
      const group = [books[i]];
      const skeletonA = titleSkeleton(books[i].title);
      const bigramsA = bigrams(skeletonA);

      for (let j = i + 1; j < books.length; j++) {
        if (used.has(books[j].book_id)) continue;
        const other = books[j];
        const skeletonB = titleSkeleton(other.title);
        const sameTitle =
          skeletonA === skeletonB || jaccard(bigramsA, bigrams(skeletonB)) >= 0.75;
        if (!sameTitle) continue;

        // 作者对不上就要谨慎：同名不同作者的情况确实存在
        const authorA = String(books[i].author || '').trim();
        const authorB = String(other.author || '').trim();
        const authorOk = !authorA || !authorB || authorA === authorB;
        if (!authorOk) continue;

        group.push(other);
        used.add(other.book_id);
      }

      if (group.length > 1) {
        used.add(books[i].book_id);
        // 保留章节多的那一份
        const sorted = [...group].sort((a, b) => b.total_chapters - a.total_chapters);
        groups.push({
          key: sorted.map((b) => b.book_id).join('|'),
          keep: sorted[0],
          others: sorted.slice(1),
          books: sorted,
          reason:
            titleSkeleton(sorted[0].title) === titleSkeleton(sorted[1].title)
              ? '书名几乎一样'
              : '书名高度相似',
        });
      }
    }

    return {
      groups,
      total: groups.length,
      message: groups.length
        ? `发现 ${groups.length} 组可能重复的书。`
        : '没有发现重复的书。',
    };
  }

  /**
   * 合并重名书。
   * PRD 要求"保留章节较多的一份，另一份入 data/.trash/"。
   */
  function merge(options = {}) {
    const keepId = options.keep_id;
    const dropId = options.drop_id;
    if (!keepId || !dropId) {
      throw new ApiError('MERGE_NEEDS_TWO', '合并需要指明保留哪一本、去掉哪一本。', '请重新选择要合并的书。', 400);
    }
    if (keepId === dropId) {
      throw new ApiError('MERGE_SAME_BOOK', '不能把一本书和它自己合并。', '请选择两本不同的书。', 400);
    }

    const keep = library.get(keepId);
    const drop = library.get(dropId);
    if (!keep) throw Errors.bookNotFound(keepId);
    if (!drop) throw Errors.bookNotFound(dropId);

    // 章节少的那一本进回收站（即使调用方传反了也纠正过来，保证符合 PRD）
    const keepBook = keep.chapters.length >= drop.chapters.length ? keep : drop;
    const dropBook = keepBook.book_id === keep.book_id ? drop : keep;

    const result = library.remove(dropBook.book_id, { purge: false });
    removeBook(dropBook.book_id);
    indexBook(keepBook.book_id);

    return {
      kept: { book_id: keepBook.book_id, title: keepBook.title, total_chapters: keepBook.total_chapters },
      removed: { book_id: dropBook.book_id, title: dropBook.title, total_chapters: dropBook.total_chapters },
      trashed: result.trashed,
      message: `已保留《${keepBook.title}》（${keepBook.total_chapters} 章），《${dropBook.title}》已移入回收站。`,
    };
  }

  return {
    META_FILE,
    SHARD_DIR,
    titleSkeleton,
    normalizeText,
    shardPath,
    readMeta,
    indexBook,
    removeBook,
    reindex,
    status,
    ensureIndex,
    search,
    duplicates,
    merge,
  };
};

module.exports.titleSkeleton = titleSkeleton;
module.exports.bigrams = bigrams;
module.exports.jaccard = jaccard;
module.exports.META_FILE = META_FILE;
module.exports.SHARD_DIR = SHARD_DIR;
