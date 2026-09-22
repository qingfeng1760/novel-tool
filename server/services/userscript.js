'use strict';
/**
 * userscript.js —— 模块 3「浏览器抓取脚本」在服务端的对应实现。
 *
 * 脚本那一侧要"快、不打断"，所以服务端这侧的原则是：
 *   - 一次请求就把活儿干完（resolve 判断归属、capture 直接入库），不让脚本来回问；
 *   - 归属识别不靠"记住上次"，而是每次按 URL 域名 + 书名相似度现算，
 *     这样脚本换页面、重启浏览器都不会失去判断能力；
 *   - 重复章节一律以**内容哈希**为准（PRD 明确要求），不靠标题猜；
 *   - 内容进来同样要过清洗（去掉站点推广行），并把剔除记录回报给脚本。
 *
 * 关于"追加到第几章"：
 *   PRD 的话术是"将追加到《XXX》的第 N 章"。但真实场景里用户往往在补某一章，
 *   如果无脑追加到末尾，一本 100 章的书里补第 5 章就会变成第 101 章。
 *   所以这里的规则是：
 *     1. 内容哈希已存在 → 直接跳过（重复章节）；
 *     2. 章节标题能解析出序号，且那个位置正好是空的（缺失/失败）→ 就填那个位置；
 *     3. 标题与已有章节完全一致 → 覆盖那一章；
 *     4. 以上都不是 → 追加到末尾。
 *   四条规则都不会产生重复章节，也都能给出"会落到第几章"的明确答复。
 */

const { ApiError } = require('../lib/errors');
const { chapterState } = require('../schema/models');
const { contentHash } = require('./store');

/** 书名相似度阈值：低于它就当成另一本书 */
const TITLE_SIMILARITY_THRESHOLD = 0.6;

module.exports = function createUserscriptService(ctx) {
  const { library, cleaner, chapters, search } = ctx;

  function hostOf(url) {
    try {
      return new URL(url).host;
    } catch (err) {
      return '';
    }
  }

  function normalizeTitle(title) {
    return String(title || '')
      .replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[·・:：\-_—.,，。！!？?、'"“”‘’《》<>]/g, '')
      .toLowerCase();
  }

  /** 书名是不是同一本 */
  function sameTitle(a, b) {
    const na = normalizeTitle(a);
    const nb = normalizeTitle(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    if (na.includes(nb) || nb.includes(na)) {
      // 短名字被包含时要求长度不能差太多，避免"剑"匹配到"剑来"
      return Math.min(na.length, nb.length) >= 2;
    }
    if (search && typeof search.titleSkeleton === 'function') {
      const sa = search.titleSkeleton(a);
      const sb = search.titleSkeleton(b);
      if (sa && sb && (sa === sb || (sa.includes(sb) && sb.length >= 2) || (sb.includes(sa) && sa.length >= 2))) {
        return true;
      }
      // 二元组相似度
      const bigrams = (text) => {
        const set = new Set();
        for (let i = 0; i < text.length - 1; i++) set.add(text.slice(i, i + 2));
        return set;
      };
      const A = bigrams(sa);
      const B = bigrams(sb);
      if (A.size && B.size) {
        let inter = 0;
        for (const item of A) if (B.has(item)) inter++;
        const score = inter / (A.size + B.size - inter);
        if (score >= TITLE_SIMILARITY_THRESHOLD) return true;
      }
    }
    return false;
  }

  /**
   * 识别这一页属于哪本书。
   * @param {{url:string, title:string, author?:string, book_id?:string}} payload
   */
  function resolve(payload = {}) {
    const url = String(payload.url || '').trim();
    const pageTitle = String(payload.title || '').trim();
    const author = String(payload.author || '').trim();
    const host = hostOf(url);

    // 脚本可以显式指定书（"存到已有书"那条路）
    if (payload.book_id) {
      const book = library.get(payload.book_id);
      if (book) {
        return {
          matched: true,
          via: 'explicit',
          book: summarize(book),
          next_index: book.total_chapters + 1,
          message: `将追加到《${book.title}》的第 ${book.total_chapters + 1} 章。`,
        };
      }
    }

    const candidates = library.list();

    // 1. 同站点 + 书名相似：最可靠
    const sameSite = candidates.find((b) => b.source_site && host && b.source_site === host && sameTitle(b.title, pageTitle));
    if (sameSite) {
      return {
        matched: true,
        via: 'same-site',
        book: summarize(sameSite),
        next_index: sameSite.total_chapters + 1,
        message: `将追加到《${sameSite.title}》的第 ${sameSite.total_chapters + 1} 章。`,
      };
    }

    // 2. 只看书名相似：用户可能从另一个站点也在看同一本
    const sameName = candidates.find((b) => sameTitle(b.title, pageTitle));
    if (sameName) {
      return {
        matched: true,
        via: 'same-title',
        confidence: 'medium',
        book: summarize(sameName),
        next_index: sameName.total_chapters + 1,
        message: `看起来是书架上的《${sameName.title}》（来源站点不同），将追加到第 ${sameName.total_chapters + 1} 章。`,
      };
    }

    // 3. 新书
    return {
      matched: false,
      is_new: true,
      suggested: {
        title: pageTitle || host || '未命名',
        author,
        source_site: host || 'web',
        source_kind: 'userscript',
        toc_url: url,
      },
      next_index: 1,
      message: `书架上还没有《${pageTitle || '这本书'}》，保存后会新建一本。`,
      same_site_books: candidates
        .filter((b) => b.source_site === host)
        .slice(0, 10)
        .map((b) => ({ book_id: b.book_id, title: b.title, total_chapters: b.total_chapters })),
    };
  }

  function summarize(book) {
    return {
      book_id: book.book_id,
      title: book.title,
      author: book.author,
      total_chapters: book.total_chapters,
      source_site: book.source_site,
    };
  }

  /** 决定这一章应该落到第几号位置，以及是不是重复 */
  function planChapter(book, payload, hash) {
    const title = String(payload.chapter_title || payload.title || '').trim();
    const existingIndex = book.chapters.findIndex((ch) => ch.content_hash && ch.content_hash === hash);

    if (existingIndex !== -1) {
      return {
        action: 'skip',
        index: existingIndex + 1,
        reason: 'duplicate',
        message: `这一章的内容已经在书里了（第 ${existingIndex + 1} 章），跳过不重复保存。`,
      };
    }

    if (title) {
      const number = chapters.extractChapterNumber(title);
      if (number && number >= 1 && number <= book.chapters.length) {
        const target = book.chapters[number - 1];
        // 那个位置正好是空的（还没抓到 / 抓失败了）就填进去
        if (chapterState(target) !== '成功') {
          return {
            action: 'fill',
            index: number,
            message: `第 ${number} 章原来是空的，这一章会补进去。`,
          };
        }
      }
      const byTitle = book.chapters.findIndex((ch) => ch.title && ch.title === title);
      if (byTitle !== -1) {
        return {
          action: 'replace',
          index: byTitle + 1,
          message: `书里已经有同名章节「${title}」，会用这次的内容替换它。`,
        };
      }
    }

    return {
      action: 'append',
      index: book.chapters.length + 1,
      message: `会作为第 ${book.chapters.length + 1} 章追加进去。`,
    };
  }

  /**
   * 保存一章。
   * @param {{url:string,title:string,author?:string,book_id?:string,chapter_title?:string,
   *          content:string,content_hash?:string,clean?:Object}} payload
   */
  function capture(payload = {}) {
    const content = String(payload.content == null ? '' : payload.content);
    if (!content.trim()) {
      throw new ApiError('EMPTY_CONTENT', '这一章没有内容可以保存。', '请确认页面上有正文再点保存。', 400);
    }

    // 脚本提交的内容同样过一遍清洗（默认去掉站点推广行，这是抓取路径的一致性要求）
    const cleanResult = cleaner.clean(content, payload.clean || { adLines: true, blankLines: true });
    const finalText = cleanResult.text.trim();
    const hash = contentHash(finalText);

    // 先定位归属
    const resolved = resolve({ url: payload.url, title: payload.title, author: payload.author, book_id: payload.book_id });

    let bookId = resolved.matched ? resolved.book.book_id : '';
    let created = false;
    if (!bookId) {
      const created_result = library.create({
        title: resolved.suggested.title,
        author: resolved.suggested.author,
        source_site: resolved.suggested.source_site,
        toc_url: resolved.suggested.toc_url,
        source_kind: 'userscript',
        status: '在读',
      });
      bookId = created_result.book.book_id;
      created = created_result.created;
    }

    const book = library.get(bookId);
    const plan = planChapter(book, payload, hash);

    if (plan.action === 'skip') {
      return {
        saved: false,
        skipped: true,
        reason: plan.reason,
        book: summarize(library.get(bookId)),
        chapter_index: plan.index,
        message: plan.message,
      };
    }

    const chapterTitle = String(payload.chapter_title || payload.title || `第 ${plan.index} 章`).trim();
    const chapter = library.writeChapter(bookId, plan.index, finalText, {
      title: chapterTitle,
      origin: 'userscript',
    });

    // 用户手动存进来的章节，默认认为是"在读"
    const after = library.get(bookId);
    if (after.status === '未读') library.patch(bookId, { status: '在读' });
    if (ctx.search && typeof ctx.search.indexBook === 'function') {
      try {
        ctx.search.indexBook(bookId);
      } catch (err) {
        /* 索引只是加速器 */
      }
    }

    return {
      saved: true,
      skipped: false,
      action: plan.action,
      book: summarize(library.get(bookId)),
      chapter: {
        index: chapter.index,
        title: chapter.title,
        char_count: chapter.char_count,
        content_hash: chapter.content_hash,
      },
      chapter_index: chapter.index,
      book_created: created,
      removed: cleanResult.removals.slice(0, 20),
      removed_count: cleanResult.removals.length,
      message: `已存到《${library.get(bookId).title}》第 ${chapter.index} 章。`,
    };
  }

  /**
   * 批量保存（脚本上的「抓整本」）。
   * @param {{url:string,title:string,author?:string,book_id?:string,chapters:Array}} payload
   */
  function batch(payload = {}) {
    const list = Array.isArray(payload.chapters) ? payload.chapters : [];
    if (!list.length) {
      throw new ApiError('EMPTY_BATCH', '这次没有要保存的章节。', '请确认页面上有正文再点抓整本。', 400);
    }

    const results = [];
    let savedCount = 0;
    let skippedCount = 0;
    let failedCount = 0;
    let bookId = payload.book_id || '';

    for (const item of list.slice(0, 500)) {
      try {
        const result = capture({
          ...item,
          url: item.url || payload.url,
          title: item.title || payload.title,
          author: item.author || payload.author,
          book_id: bookId || undefined,
        });
        if (result.book) bookId = result.book.book_id;
        if (result.saved) savedCount++;
        else skippedCount++;
        results.push({ ok: true, chapter_title: item.chapter_title || item.title, ...result });
      } catch (err) {
        failedCount++;
        results.push({
          ok: false,
          chapter_title: item.chapter_title || item.title,
          message: err && err.message ? err.message : '这一章没能保存',
          code: err && err.code ? err.code : 'CAPTURE_FAILED',
        });
      }
    }

    return {
      book_id: bookId || null,
      book: bookId ? summarize(library.get(bookId)) : null,
      total: results.length,
      saved: savedCount,
      skipped: skippedCount,
      failed: failedCount,
      results,
      message: `保存 ${savedCount} 章，跳过重复 ${skippedCount} 章${failedCount ? `，失败 ${failedCount} 章` : ''}。`,
    };
  }

  /**
   * 补交暂存内容。
   * 脚本在服务没启动时会把内容存在浏览器里，服务恢复后一次性交上来。
   * 这里逐条处理并如实回报每一条的结果，脚本据此决定清掉哪些、保留哪些重试。
   */
  function flush(payload = {}) {
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (!items.length) {
      return { total: 0, saved: 0, skipped: 0, failed: 0, results: [], message: '暂存队列是空的，没有要补交的内容。' };
    }

    const results = [];
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    for (let i = 0; i < items.slice(0, 500).length; i++) {
      const item = items[i];
      try {
        const result = capture(item);
        if (result.saved) saved++;
        else skipped++;
        results.push({
          ok: true,
          /** 带上原队列下标，脚本据此精确清掉已补交的条目（不靠标题比，避免重名搞混） */
          queue_index: i,
          queued_at: item.queued_at || null,
          chapter_title: item.chapter_title || item.title,
          message: result.message,
          book_id: result.book ? result.book.book_id : null,
          chapter_index: result.chapter_index,
        });
      } catch (err) {
        failed++;
        results.push({
          ok: false,
          queue_index: i,
          queued_at: item.queued_at || null,
          chapter_title: item.chapter_title || item.title,
          message: err && err.message ? err.message : '这一条没能补交',
          code: err && err.code ? err.code : 'FLUSH_FAILED',
        });
      }
    }

    return {
      total: results.length,
      saved,
      skipped,
      failed,
      results,
      message: `补交了 ${saved} 章，跳过重复 ${skipped} 章${failed ? `，还有 ${failed} 章没成功` : ''}。`,
    };
  }

  return {
    TITLE_SIMILARITY_THRESHOLD,
    normalizeTitle,
    sameTitle,
    summarize,
    planChapter,
    resolve,
    capture,
    batch,
    flush,
  };
};

module.exports.TITLE_SIMILARITY_THRESHOLD = TITLE_SIMILARITY_THRESHOLD;
