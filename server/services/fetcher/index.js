'use strict';
/**
 * fetcher/index.js —— 抓取器（SourceProvider 可替换）与抓取任务编排。
 *
 * SourceProvider 接口（PRD §7 预留项）：
 *   一个 provider 需要提供：
 *     id        标识
 *     label     给人看的名字
 *     canHandle(url)      能不能处理这个来源
 *     probe(url, options) 探测目录页结构
 *     extractChapter(url, probeResult, options) 抓单章正文
 *     previewChapters(probeResult, count, options) 试抓前 N 章
 *   v1 只实现 GenericWebProvider；将来要换官方 API，只要写一个新的 provider
 *   注册进来，上层的任务编排、进度、报告全都不用改。
 *
 * 抓取纪律（PRD §9）：
 *   - 创建任务前先过合规自检，不通过直接终止，且**不提供强制继续的选项**；
 *   - 每一章在真正抓之前再查一次 robots（走缓存，几乎不花时间）；
 *   - 同域并发 ≤2、间隔 ≥3 秒（本机地址放宽，见 domain-limiter 的说明）；
 *   - 失败重试走指数退避，连续 3 次仍失败就放弃这一章并在报告里说明，但不中断整个任务。
 */

const { ApiError } = require('../../lib/errors');
const compliance = require('../compliance');
const { DomainLimiter } = require('./domain-limiter');
const { fetchText, hostOf, resolveUrl } = require('./http-client');
const genericWeb = require('./providers/generic-web');

/** 可用的 provider 列表。将来加官方 API 就往这里追加 */
const PROVIDERS = [genericWeb];

/** 重试的退避基数 */
const RETRY_BASE_DELAY_MS = 800;

/** 每个任务最多记录多少条被剔除的片段（供用户抽查） */
const REMOVED_SAMPLE_LIMIT = 200;

function pickProvider(url) {
  const provider = PROVIDERS.find((p) => (typeof p.canHandle === 'function' ? p.canHandle(url) : true));
  if (!provider) {
    throw new ApiError(
      'NO_PROVIDER',
      '没有能处理这个地址的抓取方式。',
      '目前只支持普通的网页目录页。',
      400
    );
  }
  return provider;
}

module.exports = function createFetcherService(ctx) {
  const { library, tasks, settings } = ctx;

  /** 合规参数来自设置；改设置之后下次构造就会用新值 */
  const fetchSettings = settings.getFetch();
  const limiter = new DomainLimiter({
    concurrency: fetchSettings.concurrency,
    intervalMs: fetchSettings.domainIntervalMs,
  });

  /** 运行中的任务控制句柄：taskId -> {cancelled, paused, plan} */
  const runtimes = new Map();

  // ---------------------------------------------------------------- 合规 / 探测

  async function inspectCompliance(url, options = {}) {
    return compliance.inspect(url, options);
  }

  async function probe(url, options = {}) {
    const provider = pickProvider(url);
    const result = await provider.probe(url, { ...options, cleaner: ctx.cleaner });

    if (result.ok) {
      // 探测成功后把"这一本是什么书、目录页长什么样"记下来，供后续任务直接用
      result.provider = provider.id;
      result.providerLabel = provider.label;
    }
    return result;
  }

  async function previewChapters(probeResult, count = 3) {
    const provider = pickProvider(probeResult.url);
    return provider.previewChapters(probeResult, count, { cleaner: ctx.cleaner });
  }

  /**
   * 只读目录页（追更检查用）。
   * 比完整探测少抓一个章节页 —— 检查更新时不该为了看目录而多打一次对方站点。
   */
  async function probeTocOnly(url, options = {}) {
    const provider = pickProvider(url);
    if (typeof provider.probeToc !== "function") {
      // 换 provider 时如果没实现轻量路径，就退回完整探测，保证功能不断
      return provider.probe(url, options);
    }
    return provider.probeToc(url, options);
  }

  /** 把探测结果里"跟抓取有关"的部分挑出来（任务里要保存，别把整页候选都带进去） */
  function slimProbe(probeResult) {
    return {
      ok: probeResult.ok,
      provider: probeResult.provider,
      url: probeResult.url,
      finalUrl: probeResult.finalUrl,
      site: probeResult.site,
      book: probeResult.book,
      toc: {
        selector: probeResult.toc.selector,
        linkSelector: probeResult.toc.linkSelector,
        linkCount: probeResult.toc.linkCount,
      },
      content: { selector: probeResult.content.selector },
      chapterPagination: probeResult.chapterPagination,
      chapterLinks: probeResult.chapterLinks,
    };
  }

  // ---------------------------------------------------------------- 建书

  /**
   * 抓之前先把"空壳书"建出来：
   * 目录清单立刻可见（所有章标记为未抓），用户在抓取过程中就能看到整本书的全貌。
   * 这样做还有一个好处 —— 断点续抓时，同一本（同站点 + 同书名）会映射到同一个 book_id，
   * 已经抓好的章节文件还在，直接跳过即可。
   */
  function ensureBook(probeResult, options = {}) {
    const title = String(options.title || (probeResult.book && probeResult.book.title) || '').trim();
    if (!title) {
      throw new ApiError(
        'TITLE_REQUIRED',
        '没能从页面上认出书名。',
        '请手动填写书名后重试。',
        400
      );
    }
    const site = probeResult.site || hostOf(probeResult.url) || 'web';

    const { book, created } = library.create(
      {
        title,
        author: options.author || (probeResult.book && probeResult.book.author) || '',
        source_site: site,
        toc_url: probeResult.url,
        source_kind: 'web',
        fetch_status: '抓取中',
        status: '未读',
      },
      { onExists: 'return' }
    );

    const current = library.get(book.book_id);
    // 只在"还没有章节清单"或明确要求重建清单时写清单，避免把已抓好的章节冲掉
    if (!current.chapters.length || options.resetToc === true) {
      const links = probeResult.chapterLinks || [];
      library.setChapters(
        book.book_id,
        links.map((link, i) => ({
          index: i + 1,
          title: link.title,
          is_ok: false,
          origin: 'fetch',
        }))
      );
    }
    library.patch(book.book_id, {
      toc_url: probeResult.url,
      source_site: site,
      source_kind: 'web',
      fetch_status: '抓取中',
      first_fetched_at: current.first_fetched_at || new Date().toISOString(),
    });

    return { book: library.get(book.book_id), created };
  }

  // ---------------------------------------------------------------- 抓取任务

  /**
   * 创建整本抓取任务。
   * @param {{url:string, probe?:Object, title?:string, author?:string, concurrency?:number}} payload
   */
  async function startFetchTask(payload = {}) {
    const url = String(payload.url || '').trim();
    if (!url) {
      throw new ApiError('NO_URL', '还没有填目录页地址。', '请把小说目录页的网址粘进来。', 400);
    }

    // 关卡：合规自检（不通过直接终止，没有"强制继续"这条路）
    const check = payload.compliance || (await inspectCompliance(url));
    if (!check.allowed) {
      throw new ApiError('COMPLIANCE_REJECTED', check.message, check.hint, 403);
    }

    const provider = pickProvider(url);
    const probeResult = payload.probe && payload.probe.ok ? payload.probe : await provider.probe(url, {});
    if (!probeResult.ok) {
      throw new ApiError(
        'PROBE_FAILED',
        probeResult.message || '没认出这个页面的结构。',
        probeResult.hint || '请手动点选目录区后再试。',
        422
      );
    }

    const { book } = ensureBook(probeResult, payload);
    const links = probeResult.chapterLinks || [];

    const task = tasks.create({
      type: 'fetch',
      title: `抓取《${book.title}》`,
      total: links.length,
      payload: { url, book_id: book.book_id, provider: provider.id },
    });

    const runtime = {
      cancelled: false,
      paused: false,
      taskId: task.id,
      bookId: book.book_id,
      provider,
      probe: slimProbe(probeResult),
      links,
      failures: [],
      removed: [],
      removedCount: 0,
      paginationMerges: 0,
      skipped: 0,
    };
    runtimes.set(task.id, runtime);

    tasks.update(task.id, { status: 'running', message: '正在抓取…' });

    // 后台跑，立刻把 task_id 还给前端（PRD §4.0：长任务返回 task_id 轮询）
    runLoop(runtime).catch((err) => {
      tasks.fail(task.id, err);
    });

    return {
      task_id: task.id,
      book_id: book.book_id,
      book_title: book.title,
      total: links.length,
      site: probeResult.site,
      message: `已经开始抓取《${book.title}》，共 ${links.length} 章。`,
    };
  }

  /** 主循环 */
  async function runLoop(runtime) {
    const { taskId, bookId, links } = runtime;
    const bulk = library.bulkWriter(bookId, { flushEvery: 10 });
    const bookBefore = library.get(bookId);
    const startedAt = Date.now();

    try {
      for (let i = 0; i < links.length; i++) {
        // 取消
        if (runtime.cancelled) {
          bulk.close();
          tasks.update(taskId, { status: 'cancelled', message: '任务已取消，已经抓到的章节都保留着。' });
          finishRuntime(runtime, bookId);
          return;
        }
        // 暂停：原地等待，不消耗请求
        while (runtime.paused && !runtime.cancelled) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 200));
        }

        const index = i + 1;
        const link = links[i];

        // 断点续抓：这一章已经抓好了就跳过（重跑任务不重抓）
        const existing = bookBefore.chapters[i];
        if (!runtime.force && existing && existing.is_ok && existing.content_hash) {
          runtime.skipped++;
          tasks.bump(taskId, { done: 1 });
          continue;
        }

        try {
          // eslint-disable-next-line no-await-in-loop
          await fetchOneChapter(runtime, bulk, index, link);
          tasks.bump(taskId, { done: 1 });
        } catch (err) {
          tasks.bump(taskId, { failed: 1 });
          runtime.failures.push({
            index,
            title: link.title,
            url: link.url,
            reason: err.code || 'fetch_failed',
            message: err.message || '抓取失败',
            attempts: err.attempts || 1,
          });
          bulk.setChapterMeta(index, { is_ok: false, fetched_at: new Date().toISOString(), title: link.title });
        }

        tasks.update(taskId, { message: `已处理 ${index}/${links.length} 章` });
      }

      bulk.close();

      // 汇总抓取状态
      const finalBook = library.get(bookId);
      const failedCount = finalBook.chapters.filter((ch) => !ch.is_ok).length;
      library.patch(bookId, {
        fetch_status: failedCount === 0 ? '完成' : failedCount === finalBook.chapters.length ? '未抓' : '部分失败',
      });

      const report = buildReport(runtime, { startedAt, finishedAt: Date.now() });
      tasks.finish(taskId, {
        status: 'done',
        message: failedCount
          ? `抓取结束：成功 ${finalBook.chapters.length - failedCount} 章，失败 ${failedCount} 章。`
          : `抓取完成，共 ${finalBook.chapters.length} 章。`,
        report,
      });
      // 索引跟着更新
      if (ctx.search && typeof ctx.search.indexBook === 'function') {
        try {
          ctx.search.indexBook(bookId);
        } catch (err) {
          /* 索引只是加速器 */
        }
      }
      finishRuntime(runtime, bookId);
    } catch (err) {
      try {
        bulk.close();
      } catch (inner) {
        /* 收尾失败就让它失败 */
      }
      tasks.fail(taskId, err);
      finishRuntime(runtime, bookId);
    }
  }

  /** 抓一章（带指数退避重试） */
  async function fetchOneChapter(runtime, bulk, index, link) {
    const { taskId } = runtime;
    const retryMax = settings.getFetch().retryMax;
    let lastError = null;

    for (let attempt = 1; attempt <= retryMax; attempt++) {
      // 每一章都再过一次 robots（走缓存）
      // eslint-disable-next-line no-await-in-loop
      const robots = await compliance.isPathAllowed(link.url);
      if (!robots.allowed) {
        const err = new ApiError(
          'ROBOTS_DISALLOWED',
          `这一章被 robots.txt 禁止了${robots.ruleText ? `（${robots.ruleText}）` : ''}。`,
          '工具不会去抓它。',
          403
        );
        err.attempts = attempt;
        throw err;
      }

      try {
        const host = hostOf(link.url);
        // eslint-disable-next-line no-await-in-loop
        const extracted = await limiter.schedule(host, () =>
          runtime.provider.extractChapter(link.url, runtime.probe, { cleaner: ctx.cleaner })
        );

        if (!extracted.content || extracted.charCount < 10) {
          const err = new ApiError(
            'EMPTY_CONTENT',
            '抓到的是空内容（可能是页面结构变了，或者这一章是图片/付费内容）。',
            '可以在详情页对这一章单独重试。',
            422
          );
          err.attempts = attempt;
          throw err;
        }

        const title = link.title || extracted.title || `第 ${index} 章`;
        bulk.writeChapter(index, extracted.content, { title, origin: 'fetch' });

        runtime.paginationMerges += Math.max(0, extracted.pages - 1);
        for (const item of extracted.removed) {
          runtime.removedCount++;
          if (runtime.removed.length < REMOVED_SAMPLE_LIMIT) {
            runtime.removed.push({ index, reason: item.reason, snippet: item.snippet });
          }
        }
        void taskId;
        return extracted;
      } catch (err) {
        lastError = err;
        // robots 明确禁止是没有重试必要的
        if (err.code === 'ROBOTS_DISALLOWED' || err.code === 'COMPLIANCE_REJECTED') {
          err.attempts = attempt;
          throw err;
        }
        if (attempt < retryMax) {
          const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
          tasks.update(taskId, { message: `第 ${index} 章第 ${attempt} 次失败，${Math.round(delay / 1000)} 秒后重试…` });
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }

    const error = new ApiError(
      'RETRY_EXHAUSTED',
      `连续 ${retryMax} 次都没抓到：${lastError ? lastError.message : '原因不明'}。`,
      '已经跳过这一章，后面的章节会继续抓。可以在详情页对它单独重试。',
      502
    );
    error.code = lastError && lastError.code ? lastError.code : 'RETRY_EXHAUSTED';
    error.attempts = retryMax;
    throw error;
  }

  /** 任务收尾：把 runtime 留着（报告还要用），但从运行表里摘掉 */
  function finishRuntime(runtime, bookId) {
    runtime.finishedAt = Date.now();
    if (ctx.scheduler && typeof ctx.scheduler.refreshBook === 'function') {
      ctx.scheduler.refreshBook(bookId);
    }
  }

  function buildReport(runtime, timing = {}) {
    const reasonCount = new Map();
    for (const failure of runtime.failures) {
      reasonCount.set(failure.reason, (reasonCount.get(failure.reason) || 0) + 1);
    }
    const book = library.get(runtime.bookId);
    const total = runtime.links.length;
    const failed = runtime.failures.length;

    return {
      task_id: runtime.taskId,
      book_id: runtime.bookId,
      book_title: book ? book.title : '',
      total,
      success: total - failed - runtime.skipped,
      failed,
      skipped: runtime.skipped,
      /** 失败原因归类，界面上按类展示比逐条列更好读 */
      reasonSummary: [...reasonCount.entries()].map(([reason, count]) => ({
        reason,
        count,
        label: REASON_LABEL[reason] || '抓取失败',
      })),
      failures: runtime.failures,
      /** 剔除的疑似广告/导航文本，供用户抽查（PRD 模块 2） */
      removedCount: runtime.removedCount,
      removedSamples: runtime.removed,
      removedTruncated: runtime.removedCount > runtime.removed.length,
      /** 章内分页合并了多少次 */
      paginationMerges: runtime.paginationMerges,
      elapsedMs: (timing.finishedAt || Date.now()) - (timing.startedAt || Date.now()),
      limiter: limiter.snapshot(),
    };
  }

  const REASON_LABEL = {
    ROBOTS_DISALLOWED: 'robots.txt 禁止',
    EMPTY_CONTENT: '抓到的内容是空的',
    COMPLIANCE_REJECTED: '合规自检未通过',
    fetch_failed: '网络或页面异常',
    RETRY_EXHAUSTED: '连续重试都失败',
    HTTP_404: '页面不存在',
  };

  // ---------------------------------------------------------------- 控制

  function runtimeOf(taskId) {
    const runtime = runtimes.get(taskId);
    if (!runtime) {
      throw new ApiError(
        'TASK_NOT_RUNNING',
        '这个任务已经不在运行中了。',
        '如果它已经结束，可以在详情页看结果；也可以重新发起一次抓取。',
        409
      );
    }
    return runtime;
  }

  function pause(taskId) {
    const runtime = runtimeOf(taskId);
    const task = tasks.get(taskId);
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    runtime.paused = true;
    tasks.update(taskId, { status: 'paused', message: '已暂停。已经抓好的章节都保留着。' });
    return tasks.get(taskId);
  }

  function resume(taskId) {
    const runtime = runtimeOf(taskId);
    const task = tasks.get(taskId);
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    runtime.paused = false;
    tasks.update(taskId, { status: 'running', message: '继续抓取…' });
    return tasks.get(taskId);
  }

  /**
   * 取消。
   *
   * 注意这里**不立刻**把任务标成 cancelled：
   * 主循环还在跑，它需要先把已经抓到的章节落盘（bulk.close()）再收尾。
   * 如果这里抢先改状态，前端一看到 cancelled 就去读书架，
   * 会读到"还没 flush 的那一版"，让人觉得"取消把内容弄丢了"。
   * 所以只置标志位，由主循环自己把状态改成 cancelled。
   */
  function cancel(taskId) {
    const runtime = runtimeOf(taskId);
    const task = tasks.get(taskId);
    if (task && ['done', 'failed', 'cancelled'].includes(task.status)) {
      return task;
    }
    runtime.cancelled = true;
    return tasks.update(taskId, { status: 'running', message: '正在停止，正在把已经抓到的章节存盘…' });
  }

  /**
   * 重试。
   * @param {string} taskId
   * @param {{chapter_index?:number}} options 给了 chapter_index 就只重试那一章，否则重试全部失败章
   */
  async function retry(taskId, options = {}) {
    const runtime = runtimeOf(taskId);
    const task = tasks.get(taskId);
    if (task && (task.status === 'running' || task.status === 'paused')) {
      throw new ApiError(
        'TASK_BUSY',
        '这个任务还在跑，先等它跑完再重试。',
        '可以先把任务暂停或取消，再单独重试失败的章节。',
        409
      );
    }

    const index = Number(options.chapter_index);
    const targets = Number.isFinite(index) && index >= 1
      ? runtime.links.filter((_, i) => i + 1 === index)
      : runtime.failures.map((f) => runtime.links[f.index - 1]).filter(Boolean);

    if (!targets.length) {
      return { retried: 0, message: '没有需要重试的章节。' };
    }

    const bulk = library.bulkWriter(runtime.bookId, { flushEvery: 5 });
    const before = runtime.failures.length;
    const stillFailing = [];

    for (const link of targets) {
      const linkIndex = runtime.links.indexOf(link) + 1;
      runtime.failures = runtime.failures.filter((f) => f.index !== linkIndex);
      try {
        // eslint-disable-next-line no-await-in-loop
        await fetchOneChapter(runtime, bulk, linkIndex, link);
      } catch (err) {
        stillFailing.push({
          index: linkIndex,
          title: link.title,
          url: link.url,
          reason: err.code || 'fetch_failed',
          message: err.message,
          attempts: err.attempts || 1,
        });
      }
    }

    bulk.close();
    runtime.failures = runtime.failures.filter((f) => !targets.some((t) => t.url === f.url)).concat(stillFailing);

    const finalBook = library.get(runtime.bookId);
    const failedCount = finalBook.chapters.filter((ch) => !ch.is_ok).length;
    library.patch(runtime.bookId, {
      fetch_status: failedCount === 0 ? '完成' : failedCount === finalBook.chapters.length ? '未抓' : '部分失败',
    });

    tasks.update(taskId, {
      message: `重试了 ${targets.length} 章，其中 ${stillFailing.length} 章仍然失败。`,
      report: buildReport(runtime, {}),
    });
    if (ctx.search && typeof ctx.search.indexBook === 'function') {
      try {
        ctx.search.indexBook(runtime.bookId);
      } catch (err) {
        /* 忽略 */
      }
    }

    void before;
    return {
      retried: targets.length,
      failed: stillFailing.length,
      failures: stillFailing,
      message: stillFailing.length
        ? `重试了 ${targets.length} 章，还有 ${stillFailing.length} 章没成功。`
        : `重试了 ${targets.length} 章，现在都成功了。`,
    };
  }

  /** 单章重新抓取（模块 4 的「单章重抓」走这里） */
  async function refetchChapter(bookId, index) {
    const book = library.require(bookId);
    if (!book.toc_url) {
      throw new ApiError(
        'NO_SOURCE',
        '这本书没有记录目录页地址，没法重新抓取。',
        '可以重新导入一次原始文件，或者手工调整这一章。',
        400
      );
    }
    const chapter = book.chapters[Number(index) - 1];
    if (!chapter) {
      throw new ApiError('CHAPTER_NOT_FOUND', `这本书里没有第 ${index} 章。`, '请刷新目录后再试。', 404);
    }

    const probeResult = await probe(book.toc_url, {});
    if (!probeResult.ok) {
      throw new ApiError(
        'PROBE_FAILED',
        '重新读取目录页失败，没能认出结构。',
        '可以稍后再试；也可以手动把正文粘贴进来。',
        422
      );
    }

    const link = (probeResult.chapterLinks || [])[Number(index) - 1];
    if (!link) {
      throw new ApiError(
        'CHAPTER_LINK_MISSING',
        `目录页上找不到第 ${index} 章。`,
        '这本书的目录可能变了，可以去详情页做一次「更新对比」看看。',
        404
      );
    }

    const robots = await compliance.isPathAllowed(link.url);
    if (!robots.allowed) {
      throw new ApiError('COMPLIANCE_REJECTED', '这一章被 robots.txt 禁止抓取。', '工具不会去抓它。', 403);
    }

    const extracted = await limiter.schedule(hostOf(link.url), () =>
      pickProvider(link.url).extractChapter(link.url, slimProbe(probeResult), { cleaner: ctx.cleaner })
    );

    if (!extracted.content || extracted.charCount < 10) {
      throw new ApiError('EMPTY_CONTENT', '这一章抓到的是空内容。', '可能是页面结构变了，可以稍后再试。', 422);
    }

    library.writeChapter(bookId, index, extracted.content, {
      title: chapter.title || link.title,
      origin: 'fetch',
    });
    if (ctx.search && typeof ctx.search.indexBook === 'function') {
      try {
        ctx.search.indexBook(bookId);
      } catch (err) {
        /* 忽略 */
      }
    }

    return {
      index: Number(index),
      title: chapter.title,
      charCount: extracted.charCount,
      pages: extracted.pages,
      removed: extracted.removed,
      message: `第 ${index} 章已经重新抓取，共 ${extracted.charCount} 字。`,
    };
  }

  /** 主动取回一个页面（探测候选区、手动点选用） */
  async function fetchPage(url, options = {}) {
    const page = await limiter.schedule(hostOf(url), () => fetchText(url, options));
    return page;
  }

  /**
   * 列出页面里的"候选目录区 / 候选正文区"，供用户手动点选。
   * PRD 模块 2 要求"探测失败时给出可自助修复的引导（让我在页面上手动点选目录区和正文区）"，
   * 这个接口就是那个引导的数据源：把真实页面里的区块连同样例一起摆出来，
   * 用户点哪一块就用哪一块，而不是让他去猜 CSS 选择器。
   */
  async function candidates(url, options = {}) {
    const cheerio = require('cheerio');
    const provider = pickProvider(url);
    const page = await fetchPage(url);
    const $ = cheerio.load(page.text);
    const tocCandidates = provider.findTocCandidates($);

    const toc = tocCandidates.slice(0, 10).map((c) => ({
      selector: c.selector,
      kind: 'toc',
      linkCount: c.links.length,
      sample: c.links.slice(0, 4).map((l) => l.title),
    }));

    // 正文候选要看章节页，所以先挑一个章节链接
    const explicitChapter = options.chapter_url ? String(options.chapter_url) : '';
    const firstLink = tocCandidates.length && tocCandidates[0].links.length ? tocCandidates[0].links[0] : null;
    const chapterUrl = explicitChapter || (firstLink ? resolveUrl(page.finalUrl || url, firstLink.href) : '');

    let content = [];
    let chapterTitle = '';
    if (chapterUrl) {
      const chapterPage = await fetchPage(chapterUrl, { referer: url });
      const $chapter = cheerio.load(chapterPage.text);
      chapterTitle = $chapter('title').first().text().trim();
      content = provider
        .findContentCandidates($chapter)
        .slice(0, 10)
        .map((c) => ({
          selector: c.selector,
          kind: 'content',
          charCount: c.length,
          sample: c.text.slice(0, 120),
        }));
    }

    return {
      url,
      chapter_url: chapterUrl,
      chapter_title: chapterTitle,
      page_title: $('title').first().text().trim(),
      encoding: page.encoding,
      toc,
      content,
      note: toc.length
        ? '点一条候选就用它作为目录区／正文区，然后重新探测。'
        : '这个页面上没有找到像目录区的区块，请确认地址是目录页而不是正文页。',
    };
  }

  return {
    PROVIDERS,
    limiter,
    inspectCompliance,
    probe,
    probeTocOnly,
    previewChapters,
    ensureBook,
    startFetchTask,
    pause,
    resume,
    cancel,
    retry,
    refetchChapter,
    fetchPage,
    candidates,
    buildReport,
    slimProbe,
    getReport: (taskId) => {
      const task = tasks.get(taskId);
      const runtime = runtimes.get(taskId);
      if (runtime) return buildReport(runtime, {});
      if (task && task.report) return task.report;
      throw new ApiError(
        'NO_REPORT',
        '还没有这个任务的抓取报告。',
        '如果是服务重启过，任务记录会清空；已经抓到的章节不会丢，可以重新发起一次抓取。',
        404
      );
    },
    runtimeOf,
  };
};

module.exports.PROVIDERS = PROVIDERS;
module.exports.pickProvider = pickProvider;
