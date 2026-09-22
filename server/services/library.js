'use strict';
/**
 * library.js —— 书库仓储（Book / Chapter 的落盘与读取）。
 *
 * 落盘结构（PRD §6.1）：
 *   data/library.json               书库索引（所有书的元数据摘要）
 *   data/books/<book_id>/book.json  单本元数据 + 完整章节清单 + 来源信息
 *   data/books/<book_id>/chapters/0001.txt   每章一个文件，UTF-8 无 BOM
 *
 * 为什么索引和全量分开放：
 *   书架要一次列出所有书，如果每本都去读一遍 book.json，几百本书就是几百次磁盘 IO；
 *   而 book.json 里的章节清单在 3000 章时能有几百 KB，塞进索引会让索引膨胀到没法用。
 *   所以 library.json 只存摘要，详情页才去读单本。
 */

const path = require('path');
const { makeBookId, contentHash } = require('./store');
const {
  normBook,
  assertValidBook,
  bookSummary,
  normChapter,
  nowIso,
  versioning,
} = require('../schema/models');
const { SCHEMA_VERSION } = require('../lib/constants');
const { ApiError, Errors } = require('../lib/errors');

/** 索引文件里的固定字段（版本与预留同步字段） */
const INDEX_META = versioning({}, null);

/** 章节文件名：0001.txt（4 位补零；超过 9999 章时自然变 5 位，不截断） */
function chapterFileName(index) {
  return String(Math.max(1, Math.trunc(Number(index) || 1))).padStart(4, '0') + '.txt';
}

module.exports = function createLibraryService(ctx) {
  const io = ctx.storage;
  const INDEX_FILE = 'library.json';

  // ---------------------------------------------------------------- 索引

  function readIndex() {
    const raw = io.readJson(INDEX_FILE, null);
    if (!raw || typeof raw !== 'object') {
      return { ...INDEX_META, books: [] };
    }
    return {
      ...INDEX_META,
      ...raw,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      books: Array.isArray(raw.books) ? raw.books : [],
    };
  }

  function writeIndex(index) {
    const payload = {
      ...index,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      updatedAt: nowIso(),
    };
    io.writeJson(INDEX_FILE, payload);
    return payload;
  }

  /** 把一本书的摘要写进索引（存在就替换，不存在就追加） */
  function upsertIndexEntry(book) {
    const index = readIndex();
    const summary = bookSummary(book);
    const at = index.books.findIndex((b) => b.book_id === book.book_id);
    if (at === -1) index.books.push(summary);
    else index.books[at] = { ...index.books[at], ...summary };
    writeIndex(index);
    return summary;
  }

  function dropIndexEntry(bookId) {
    const index = readIndex();
    const before = index.books.length;
    index.books = index.books.filter((b) => b.book_id !== bookId);
    writeIndex(index);
    return before !== index.books.length;
  }

  // ---------------------------------------------------------------- 路径

  function bookDir(bookId) {
    return path.posix.join('books', bookId);
  }
  function bookFile(bookId) {
    return path.posix.join(bookDir(bookId), 'book.json');
  }
  function chapterFile(bookId, index) {
    return path.posix.join(bookDir(bookId), 'chapters', chapterFileName(index));
  }
  function rawDir(bookId) {
    return path.posix.join(bookDir(bookId), 'raw');
  }

  // ---------------------------------------------------------------- 读

  function list() {
    return readIndex().books;
  }

  function exists(bookId) {
    return io.exists(bookFile(bookId));
  }

  /** 读单本全量（含章节清单）；不存在返回 null */
  function get(bookId) {
    if (!bookId) return null;
    const raw = io.readJson(bookFile(bookId), null);
    if (!raw) return null;
    return normBook(raw);
  }

  /** 读单本，不存在就抛中文错误（给路由用） */
  function require_(bookId) {
    const book = get(bookId);
    if (!book) throw Errors.bookNotFound(bookId);
    return book;
  }

  function readChapterText(bookId, index) {
    return io.readText(chapterFile(bookId, index), null);
  }

  // ---------------------------------------------------------------- 写

  /**
   * 落盘一本书：先写 book.json，再更新索引。
   * 顺序很关键 —— 先写详情再写索引，万一中途断电，最多是"索引里少一本书"（可以 rebuildIndex 找回），
   * 反过来则会出现"索引里有书但详情文件不存在"，书架点进去直接报错。
   */
  function save(input) {
    const book = normBook(input);
    // 章节清单与总数保持自洽，避免两个字段打架
    if (Array.isArray(book.chapters)) book.total_chapters = book.chapters.length;
    if (book.read_chapters > book.total_chapters) book.read_chapters = book.total_chapters;
    book.updatedAt = nowIso();

    assertValidBook(book);
    io.ensureDir(path.posix.join(bookDir(book.book_id), 'chapters'));
    io.writeJson(bookFile(book.book_id), book);
    upsertIndexEntry(book);
    return book;
  }

  /**
   * 新建一本书。
   * 同一个来源站点 + 同一个书名 → 同一个 book_id（PRD §6.1：重复导入不产生两条）。
   * 已经存在时按 onExists 决定行为：
   *   'return' 直接返回已有的（默认，最安全）
   *   'merge'  把新信息合并进去（不覆盖已有的章节）
   *   'error'  报冲突，让调用方决定
   */
  function create(input = {}, options = {}) {
    const onExists = options.onExists || 'return';
    const title = String(input.title || '').trim();
    if (!title) {
      throw new ApiError('TITLE_REQUIRED', '请先给这本书起个名字。', '书名不能为空。', 400);
    }

    const sourceSite = String(input.source_site || input.site || 'local').trim() || 'local';
    const bookId = input.book_id || makeBookId(sourceSite, title);
    const existing = get(bookId);

    if (existing) {
      if (onExists === 'return') return { book: existing, created: false };
      if (onExists === 'error') {
        throw Errors.conflict(
          `书架上已经有《${existing.title}》了。`,
          '你可以直接打开它，或者换一个书名再导入。'
        );
      }
      const merged = normBook({
        ...existing,
        ...input,
        book_id: bookId,
        title: existing.title,
        // 章节以已有的为准，避免合并时把已读进度弄丢
        chapters: existing.chapters,
        created_at: existing.created_at,
      });
      return { book: save(merged), created: false };
    }

    const book = normBook({
      ...input,
      book_id: bookId,
      title,
      source_site: sourceSite,
      created_at: input.created_at || nowIso(),
    });
    return { book: save(book), created: true };
  }

  /** 只改元数据（重命名、改作者、加标签、改状态），不碰章节 */
  function patch(bookId, changes = {}) {
    const book = require_(bookId);
    const allowed = [
      'title',
      'author',
      'cover',
      'intro',
      'tags',
      'status',
      'fetch_status',
      'source_site',
      'toc_url',
      'last_read_at',
      'read_chapters',
      'new_chapters',
      'last_checked_at',
      'last_updated_at',
      'next_check_at',
      'check_mode',
      'first_fetched_at',
      'source_kind',
    ];
    const next = { ...book };
    for (const key of allowed) {
      if (changes[key] !== undefined) next[key] = changes[key];
    }
    return save(next);
  }

  /** 写入章节清单到 book.json（不动章节正文文件） */
  function setChapters(bookId, chapters) {
    const book = require_(bookId);
    book.chapters = chapters.map((ch, i) => normChapter(ch, i + 1));
    return save(book);
  }

  /**
   * 写一章正文，并顺手把这一章的元信息（字数 / 哈希 / 抓取时间 / 是否成功）更新掉。
   * 把它做成一个动作，是为了避免"写了正文忘了更新清单"这种不一致。
   */
  function writeChapter(bookId, index, text, options = {}) {
    const book = require_(bookId);
    const content = String(text == null ? '' : text);

    // 一律 UTF-8 无 BOM（PRD §6.1）
    io.writeText(chapterFile(bookId, index), content.charCodeAt(0) === 0xfeff ? content.slice(1) : content);

    const position = Math.max(1, Math.trunc(Number(index) || 1)) - 1;
    const existing = book.chapters[position] || {};
    const chapter = normChapter(
      {
        ...existing,
        index,
        title: options.title || existing.title,
        char_count: content.replace(/\s/g, '').length,
        is_ok: options.is_ok !== undefined ? options.is_ok : true,
        fetched_at: options.fetched_at || nowIso(),
        content_hash: contentHash(content),
        origin: options.origin || existing.origin || 'manual',
      },
      index
    );
    book.chapters[position] = chapter;
    book.chapters = book.chapters.map((ch, i) => normChapter(ch, i + 1));
    save(book);
    return chapter;
  }

  /**
   * 删除某一章。
   * 必须走 rewriteFrom：章节文件是按序号命名的，删掉中间一章之后，
   * 后面所有章的正文文件都要跟着往前挪一位，否则"第 2 章"会读到原来第 3 章的内容。
   */
  function deleteChapter(bookId, index) {
    const book = require_(bookId);
    const position = Math.max(1, Math.trunc(Number(index) || 1));
    if (!book.chapters[position - 1]) throw Errors.chapterNotFound(index);

    const tail = [];
    for (let i = position + 1; i <= book.chapters.length; i++) {
      tail.push({
        title: book.chapters[i - 1].title,
        content: readChapterText(bookId, i) || '',
        origin: book.chapters[i - 1].origin,
      });
    }
    return rewriteFrom(bookId, position, tail);
  }

  /** 整本分批写章节（导入/抓取落库用），返回写成功的数量 */
  function writeChapters(bookId, chapters, options = {}) {
    const book = require_(bookId);
    const written = [];
    // 批量写正文时默认关掉逐章 fsync：3000 章逐章落盘会慢好几倍，
    // 而这里的持久性由最后那一次 book.json 的原子写兜底（清单没写成功 = 这批章节不可见）。
    // 需要更强保证时传 durable:true 即可走回每章 fsync 的路径。
    const ioOptions = { sync: options.durable === true };
    chapters.forEach((item, i) => {
      const index = item.index || i + 1;
      const content = String(item.content == null ? '' : item.content);
      io.writeText(chapterFile(bookId, index), content, ioOptions);
      written.push(
        normChapter(
          {
            index,
            title: item.title,
            char_count: content.replace(/\s/g, '').length,
            is_ok: item.is_ok !== undefined ? item.is_ok : true,
            fetched_at: item.fetched_at || nowIso(),
            content_hash: item.content_hash || contentHash(content),
            origin: item.origin || options.origin || 'import',
          },
          index
        )
      );
    });
    book.chapters = written;
    save(book);
    return written.length;
  }

  /**
   * 从某一章开始，用新的一批章节整体替换掉后面的所有章节。
   *
   * 为什么需要它：
   * 章节正文文件是按序号命名的（0001.txt），所以"拆章 / 合并 / 删章"会让后面所有章的序号平移。
   * 如果一章一章地先读后写，很容易在平移过程中把还没读的内容覆盖掉。
   * 这里统一走"全部读进内存 → 按新序号写回 → 一次更新清单"，
   * 顺序上先写高序号再写低序号，怎么都不会踩到还没处理的文件。
   *
   * @param {string} bookId
   * @param {number} fromIndex 从第几章开始替换（从 1 起）
   * @param {Array<{title:string,content:string}>} newTail 新的"尾部"
   */
  function rewriteFrom(bookId, fromIndex, newTail) {
    const book = require_(bookId);
    const oldCount = book.chapters.length;
    const start = Math.max(1, Math.trunc(Number(fromIndex) || 1));
    const targetCount = start - 1 + newTail.length;

    // 新序号要比旧序号大时，先预读还没被覆盖的内容？不需要 —— newTail 里已经带齐了要保留的正文。
    // 从高到低写：即使新序号更小，也不会覆盖到还没写到的高位文件。
    for (let offset = newTail.length; offset >= 1; offset--) {
      const index = start + offset - 1;
      const item = newTail[offset - 1];
      const content = String(item.content == null ? '' : item.content);
      io.writeText(chapterFile(bookId, index), content, { sync: false });
    }

    // 清掉多出来的旧章文件（合并/删章时会变少）
    for (let i = targetCount + 1; i <= oldCount; i++) {
      io.remove(chapterFile(bookId, i));
    }

    const head = book.chapters.slice(0, start - 1);
    const tail = newTail.map((item, i) =>
      normChapter(
        {
          index: start + i,
          title: item.title,
          char_count: String(item.content || '').replace(/\s/g, '').length,
          is_ok: true,
          fetched_at: item.fetched_at || nowIso(),
          content_hash: item.content_hash || contentHash(item.content || ''),
          origin: item.origin || 'manual',
        },
        start + i
      )
    );
    book.chapters = head.concat(tail);
    return save(book);
  }

  /**
   * 批量写入器。
   *
   * 为什么需要它：
   * 抓取一整本（可能几千章）时，如果每写一章都把 book.json 读一遍再写一遍，
   * 光是 JSON 往返就把时间全吃掉了。批量写入器把 book 对象缓存在内存里，
   * 每章只写正文文件 + 改内存中的清单，隔一段时间（或结束时）才落一次 book.json。
   * 中途出问题也不怕：book.json 是最后才落盘的，没落盘的那部分章节不会被引用到。
   */
  function bulkWriter(bookId, options = {}) {
    const book = require_(bookId);
    let dirty = 0;
    let pendingRemoved = [];
    const flushEvery = Math.max(1, Number(options.flushEvery) || 20);

    function writeChapter(index, text, chapterOptions = {}) {
      const content = String(text == null ? '' : text);
      io.writeText(chapterFile(bookId, index), content, { sync: false });

      const position = Math.max(1, Math.trunc(Number(index) || 1)) - 1;
      const existing = book.chapters[position] || {};
      book.chapters[position] = normChapter(
        {
          ...existing,
          index,
          title: chapterOptions.title || existing.title,
          char_count: content.replace(/\s/g, '').length,
          is_ok: chapterOptions.is_ok !== undefined ? chapterOptions.is_ok : true,
          fetched_at: chapterOptions.fetched_at || nowIso(),
          content_hash: chapterOptions.content_hash || contentHash(content),
          origin: chapterOptions.origin || existing.origin || 'fetch',
        },
        index
      );
      dirty++;
      if (dirty >= flushEvery) flush();
      return book.chapters[position];
    }

    /** 只改章节元信息，不写正文（标记失败/缺失用） */
    function setChapterMeta(index, meta = {}) {
      const position = Math.max(1, Math.trunc(Number(index) || 1)) - 1;
      const existing = book.chapters[position] || {};
      book.chapters[position] = normChapter({ ...existing, ...meta, index }, index);
      dirty++;
      if (dirty >= flushEvery) flush();
      return book.chapters[position];
    }

    function removeChapterFile(index) {
      pendingRemoved.push(index);
    }

    function flush() {
      if (dirty === 0) return book;
      book.total_chapters = book.chapters.length;
      io.writeJson(bookFile(bookId), book);
      upsertIndexEntry(book);
      dirty = 0;
      return book;
    }

    /** 收尾：清掉多余文件、重排序号、落盘 */
    function close() {
      for (const index of pendingRemoved) io.remove(chapterFile(bookId, index));
      pendingRemoved = [];
      book.chapters = book.chapters.map((ch, i) => normChapter({ ...ch, index: i + 1 }, i + 1));
      book.total_chapters = book.chapters.length;
      dirty++;
      return flush();
    }

    return {
      get book() {
        return book;
      },
      writeChapter,
      setChapterMeta,
      removeChapterFile,
      flush,
      close,
    };
  }

  /**
   * 从书架移除。
   * PRD §3 明确："移除只删索引，正文文件移入 data/.trash/，不直接抹掉"。
   * 所以默认走 moveToTrash，只有显式传 purge 才真的删。
   */
  function remove(bookId, options = {}) {
    const book = get(bookId);
    if (!book) throw Errors.bookNotFound(bookId);

    dropIndexEntry(bookId);
    let trashed = null;
    if (options.purge) {
      io.removeDir(bookDir(bookId));
    } else {
      trashed = io.moveToTrash(bookDir(bookId), bookId + '__' + (book.title || '未命名'));
    }
    return { book_id: bookId, title: book.title, trashed };
  }

  // 索引损坏、或用户手工把 data/ 拷到新机器时，从每本书的 book.json 重新生成索引
  function rebuildIndex() {
    const dirs = io.listDir('books');
    const books = [];
    for (const name of dirs) {
      const book = get(name);
      if (book) books.push(bookSummary(book));
    }
    writeIndex({ books });
    return books.length;
  }

  /**
   * 导出单本为纯文本（模块 1 右键菜单「导出这一本」）。
   * 选 TXT 而不是专有格式：用户想拿去别的地方看、丢进别的阅读器都能直接用，
   * 这正是"把内容在我手里"的诉求。
   */
  function exportBookText(bookId) {
    const book = require_(bookId);
    const out = [];
    out.push(book.title);
    out.push('='.repeat(Math.min(40, Math.max(8, book.title.length * 2))));
    if (book.author) out.push(`作者：${book.author}`);
    if (book.source_site && book.source_site !== 'local') out.push(`来源：${book.source_site}`);
    if (book.intro) out.push('', '【简介】', book.intro.trim());
    out.push('');

    for (const chapter of book.chapters) {
      const content = readChapterText(bookId, chapter.index);
      out.push('');
      out.push(chapter.title);
      out.push('');
      out.push(content == null ? '（这一章没有内容）' : content.trim());
      out.push('');
    }

    const text = out
      .join('\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .replace(/^\n+/, '');
    return { filename: `${book.title}.txt`, text, book };
  }

  /**
   * 导出单本为 JSON。
   * 结构与整库备份里单本的格式保持一致（PRD §7：导出格式要与将来云端版本一致，
   * 保证未来能直接导入）。需要在别的机器/别的程序里处理这本书时用它。
   */
  function exportBookJson(bookId) {
    const book = require_(bookId);
    return {
      format: 'novel-tool-book',
      formatVersion: 1,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      exportedAt: nowIso(),
      book,
      chapters: book.chapters.map((chapter) => ({
        ...chapter,
        content: readChapterText(bookId, chapter.index) || '',
      })),
    };
  }

  /** 书库整体统计（模块 1 底部概览 + 模块 9 存储占用） */
  function stats() {    const books = list();
    let chapterSum = 0;
    let readSum = 0;
    let unread = 0;
    let reading = 0;
    let following = 0;
    let finished = 0;
    for (const book of books) {
      chapterSum += Number(book.total_chapters) || 0;
      readSum += Number(book.read_chapters) || 0;
      if (book.status === '未读') unread++;
      else if (book.status === '在读') reading++;
      else if (book.status === '追更中') following++;
      else if (book.status === '已读完') finished++;
    }
    return {
      bookCount: books.length,
      chapterCount: chapterSum,
      readChapterCount: readSum,
      byStatus: { 未读: unread, 在读: reading, 追更中: following, 已读完: finished },
    };
  }

  return {
    INDEX_FILE,
    chapterFileName,
    bookDir,
    bookFile,
    chapterFile,
    rawDir,

    readIndex,
    writeIndex,

    list,
    exists,
    get,
    require: require_,
    readChapterText,

    create,
    save,
    patch,
    setChapters,
    writeChapter,
    writeChapters,
    rewriteFrom,
    bulkWriter,
    deleteChapter,
    remove,
    rebuildIndex,
    stats,
    exportBookText,
    exportBookJson,
  };
};

module.exports.chapterFileName = chapterFileName;
