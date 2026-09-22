'use strict';
/**
 * scheduler.js —— 定时追更（PRD 模块 2、流程 E）。
 *
 * 这个模块有一条必须守住的规矩：
 *   **发现新章节只写"待更新"标记，出角标和通知，绝不自动下载。**
 * 用户点「更新」才走抓取链路 —— 否则工具会在用户不知情的时候持续去访问别人的站点，
 * 既不符合预期，也违背"抓取要克制"的前提。
 *
 * 检查流程：
 *   定时器到点（或用户点「立即检查」）
 *     → 合规自检（robots / 登录墙 / 付费墙，任一不过就记下来并跳过，不改任何数据）
 *     → 只读目录页
 *     → 和现有章节清单比对（标题 + 序号）
 *     → 有新章节：写 new_chapters 标记、状态改成"追更中"、生成一条通知
 *     → 更新"上次检查时间 / 下次检查时间"
 *
 * 通知单独落一个 data/notifications.json：
 *   PRD §6.1 的目录清单里没有列它，但模块 2 明确要求"发现新章节出角标和通知"，
 *   通知得有个能持久化的地方；它只是提示信息，丢了也不影响书的内容。
 */

const { ApiError, Errors } = require('../lib/errors');
const { CHECK_MODE_DAYS, CHECK_MODE_LABEL, CHECK_MODES, nowIso } = require('../schema/models');

/** 定时器扫描间隔：每 5 分钟看一次有没有到点的书 */
const TICK_MS = 5 * 60 * 1000;
/** 通知最多留多少条 */
const NOTIFICATION_LIMIT = 200;
const NOTIFICATIONS_FILE = 'notifications.json';

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function normalizeTitle(title) {
  return String(title || '')
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・:：\-_—.,，。！!？?、'"“”‘’《》<>]/g, '')
    .toLowerCase();
}

module.exports = function createSchedulerService(ctx) {
  const { library, fetcher, settings } = ctx;

  let timer = null;
  let running = false;

  // ---------------------------------------------------------------- 通知

  function readNotifications() {
    const raw = ctx.storage.readJson(NOTIFICATIONS_FILE, null);
    if (!raw || !Array.isArray(raw.notifications)) return [];
    return raw.notifications;
  }

  function writeNotifications(list) {
    ctx.storage.writeJson(NOTIFICATIONS_FILE, {
      schemaVersion: ctx.schemaVersion,
      syncState: 'local',
      owner_id: 'local',
      updatedAt: nowIso(),
      notifications: list.slice(0, NOTIFICATION_LIMIT),
    });
    return list;
  }

  function pushNotification(item) {
    const list = readNotifications();
    // 同一本书同一类通知只留最新的一条，避免反复检查刷屏
    const filtered = list.filter((n) => !(n.book_id === item.book_id && n.type === item.type));
    filtered.unshift({
      id: `nt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      at: nowIso(),
      read: false,
      ...item,
    });
    writeNotifications(filtered);
    return filtered[0];
  }

  function listNotifications(options = {}) {
    const list = readNotifications();
    const unread = list.filter((n) => !n.read);
    return {
      notifications: options.unreadOnly ? unread : list,
      unreadCount: unread.length,
    };
  }

  function markRead(ids) {
    const list = readNotifications();
    const target = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    for (const item of list) {
      if (!target || target.has(item.id)) item.read = true;
    }
    writeNotifications(list);
    return listNotifications();
  }

  // ---------------------------------------------------------------- 排期

  /** 按频率算出下一次检查时间 */
  function computeNextCheck(mode, from = new Date()) {
    const days = CHECK_MODE_DAYS[mode];
    if (!days) return null;
    return addDays(from, days).toISOString();
  }

  /**
   * 设置追更频率（单本或批量）。
   * @param {{book_ids?:string[], all?:boolean, mode:string}} options
   */
  function setSchedule(options = {}) {
    const mode = String(options.mode || '').trim();
    if (!CHECK_MODES.includes(mode)) {
      throw new ApiError(
        'BAD_CHECK_MODE',
        '没有这个追更频率。',
        `可选的是：${CHECK_MODES.map((m) => CHECK_MODE_LABEL[m]).join(' / ')}。`,
        400
      );
    }

    let targets = [];
    if (options.all) {
      targets = library.list().filter((b) => b.toc_url);
    } else if (Array.isArray(options.book_ids) && options.book_ids.length) {
      targets = options.book_ids.map((id) => library.require(id));
    } else {
      throw new ApiError(
        'NO_SCHEDULE_TARGET',
        '没有指明要给哪本书设置追更。',
        '请先选中要设置的书。',
        400
      );
    }

    if (!targets.length) {
      throw new ApiError(
        'NOTHING_TO_SCHEDULE',
        '这些书都没有目录页地址，没法检查更新。',
        '只有从网址抓进来的书才能追更；导入的书可以在设置页手动添加更新检查的目录页。',
        400
      );
    }

    const updated = [];
    for (const book of targets) {
      // 排期从"现在 + 间隔"开始算；手动模式没有下次检查时间
      const next = mode === 'manual' ? null : computeNextCheck(mode, new Date());
      updated.push(
        library.patch(book.book_id, {
          check_mode: mode,
          next_check_at: next,
        })
      );
    }

    return {
      mode,
      modeLabel: CHECK_MODE_LABEL[mode],
      books: updated.map((b) => ({
        book_id: b.book_id,
        title: b.title,
        check_mode: b.check_mode,
        next_check_at: b.next_check_at,
      })),
      message:
        updated.length === 1
          ? `《${updated[0].title}》的追更频率已设为「${CHECK_MODE_LABEL[mode]}」。`
          : `已经把 ${updated.length} 本书的追更频率设为「${CHECK_MODE_LABEL[mode]}」。`,
    };
  }

  /** 追更状态总览：每本书上次检查 / 下次检查 */
  function status() {
    const books = library.list();
    const autoCheck = settings.getFetch().autoCheckUpdates;
    return {
      autoCheckEnabled: autoCheck,
      timerRunning: Boolean(timer),
      checkModes: CHECK_MODES.map((mode) => ({ mode, label: CHECK_MODE_LABEL[mode] })),
      books: books.map((book) => ({
        book_id: book.book_id,
        title: book.title,
        source_site: book.source_site,
        toc_url: book.toc_url,
        check_mode: book.check_mode || 'manual',
        check_mode_label: CHECK_MODE_LABEL[book.check_mode || 'manual'],
        last_checked_at: book.last_checked_at,
        next_check_at: book.next_check_at,
        new_chapters: book.new_chapters || 0,
        status: book.status,
        /** 这本书能不能追更（没有目录页就不能） */
        schedulable: Boolean(book.toc_url),
      })),
    };
  }

  // ---------------------------------------------------------------- 检查

  /**
   * 检查一本书有没有更新。
   * 整个过程只读目录页，不抓任何正文。
   */
  async function checkBook(bookId, options = {}) {
    const book = library.get(bookId);
    if (!book) throw Errors.bookNotFound(bookId);

    if (!book.toc_url) {
      return {
        book_id: bookId,
        title: book.title,
        checked: false,
        reason: 'no_toc_url',
        message: '这本书没有记录目录页地址，没法检查更新（导入的书属于这种情况）。',
      };
    }

    // 1. 合规自检：不通过就什么都不动，只记下原因
    const compliance = await fetcher.inspectCompliance(book.toc_url, { fetchPage: false });
    if (!compliance.allowed) {
      const checkedAt = nowIso();
      library.patch(bookId, {
        last_checked_at: checkedAt,
        next_check_at: computeNextCheck(book.check_mode || 'manual', new Date(checkedAt)),
      });
      return {
        book_id: bookId,
        title: book.title,
        checked: true,
        allowed: false,
        reason: compliance.reason,
        message: `检查被拦下了：${compliance.message}`,
        hint: compliance.hint,
      };
    }

    // 2. 只读目录页
    let toc;
    try {
      toc = await fetcher.probeTocOnly(book.toc_url, {});
    } catch (err) {
      return {
        book_id: bookId,
        title: book.title,
        checked: true,
        allowed: true,
        reason: 'fetch_failed',
        message: '读取目录页失败，这次没查到更新。',
        detail: err && err.message ? err.message : String(err),
      };
    }

    if (!toc.ok) {
      return {
        book_id: bookId,
        title: book.title,
        checked: true,
        allowed: true,
        reason: 'no_toc',
        message: '目录页结构变了，没能读出章节列表，这次没查到更新。',
      };
    }

    // 3. 比对：以标题为准（顺序无关），序号只作参考
    const existingTitles = new Set(book.chapters.map((ch) => normalizeTitle(ch.title)));
    const knownUrls = new Set();
    const newChapters = [];
    const titleChanges = [];

    toc.chapterLinks.forEach((link, i) => {
      const index = i + 1;
      const key = normalizeTitle(link.title);
      if (!key || existingTitles.has(key)) return;
      const existing = book.chapters[index - 1];
      if (existing && existing.title && normalizeTitle(existing.title) !== key) {
        titleChanges.push({ index, from: existing.title, to: link.title });
        return;
      }
      if (knownUrls.has(link.url)) return;
      knownUrls.add(link.url);
      newChapters.push({ index, title: link.title, url: link.url });
    });

    const checkedAt = new Date();
    const next = computeNextCheck(book.check_mode || 'manual', checkedAt);
    const hasNew = newChapters.length > 0;

    // 4. 只写标记，绝不下载（PRD 明确要求）
    const patch = {
      last_checked_at: checkedAt.toISOString(),
      next_check_at: next,
      new_chapters: hasNew ? newChapters.length : 0,
      last_updated_at: hasNew ? checkedAt.toISOString() : book.last_updated_at,
    };
    if (hasNew && book.status !== '已读完') patch.status = '追更中';
    if (hasNew && book.status === '已读完') patch.status = '追更中';
    library.patch(bookId, patch);

    // 5. 通知（发现新章节才有）
    let notification = null;
    if (hasNew) {
      notification = pushNotification({
        type: 'update',
        book_id: bookId,
        book_title: book.title,
        new_chapters: newChapters.length,
        total_chapters: book.total_chapters,
        message: `《${book.title}》有 ${newChapters.length} 章新内容，点开这条可以去更新。`,
        /** 只提示，不下载 */
        auto_downloaded: false,
      });
    }

    return {
      book_id: bookId,
      title: book.title,
      checked: true,
      allowed: true,
      hasNew,
      newChapters,
      titleChanges,
      existingChapters: book.total_chapters,
      siteChapters: toc.chapterLinks.length,
      last_checked_at: patch.last_checked_at,
      next_check_at: patch.next_check_at,
      notification,
      /** 提醒界面：这里只出提示，不动正文 */
      needs_user_action: hasNew,
      message: hasNew
        ? `《${book.title}》发现 ${newChapters.length} 章新内容，已出更新角标，等你点「更新」才下载。`
        : `《${book.title}》没有更新。`,
      hint: hasNew ? '去书籍详情页点「更新」即可把新章节抓下来。' : '',
    };
  }

  /** 检查所有到点的书（定时器与手动"全部检查"都走这里） */
  async function runDueChecks(now = new Date(), options = {}) {
    if (running) return { skipped: true, message: '上一次检查还没跑完，这次先跳过。' };
    running = true;
    try {
      const force = options.force === true;
      const books = library.list().filter((b) => {
        if (!b.toc_url) return false;
        const mode = b.check_mode || 'manual';
        if (mode === 'manual') return force && options.includeManual === true;
        if (force) return true;
        if (!b.next_check_at) return true;
        return new Date(b.next_check_at).getTime() <= now.getTime();
      });

      const results = [];
      for (const book of books) {
        // eslint-disable-next-line no-await-in-loop
        const result = await checkBook(book.book_id);
        results.push(result);
      }

      const updated = results.filter((r) => r.hasNew);
      return {
        checked: results.length,
        updated: updated.length,
        results,
        message: results.length
          ? `检查了 ${results.length} 本书，其中 ${updated.length} 本有更新。`
          : '这会儿没有需要检查的书。',
      };
    } finally {
      running = false;
    }
  }

  /** 手动立即检查某本（PRD：POST /api/fetch/schedule/check） */
  async function checkNow(bookId) {
    if (bookId) return checkBook(bookId);
    return runDueChecks(new Date(), { force: true });
  }

  /** 抓取任务完成后刷新一下这本书的追更状态 */
  function refreshBook(bookId) {
    const book = library.get(bookId);
    if (!book) return null;
    // 用户主动下载过之后，待更新标记就该清掉了
    if (book.new_chapters) {
      return library.patch(bookId, { new_chapters: 0 });
    }
    return book;
  }

  // ---------------------------------------------------------------- 定时器

  function start() {
    if (timer) return timer;
    if (!settings.getFetch().autoCheckUpdates) {
      // 用户在设置里关了自动检查：不起定时器，但手动检查仍然可用
      return null;
    }
    timer = setInterval(() => {
      runDueChecks().catch((err) => {
        console.error('[追更检查出错]', err && err.message ? err.message : err);
      });
    }, TICK_MS);
    // 不因为这个定时器而让进程无法退出
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return {
    TICK_MS,
    NOTIFICATIONS_FILE,
    computeNextCheck,
    setSchedule,
    status,
    checkBook,
    runDueChecks,
    checkNow,
    refreshBook,
    listNotifications,
    markRead,
    pushNotification,
    start,
    stop,
    isRunning: () => running,
  };
};

module.exports.TICK_MS = TICK_MS;
module.exports.NOTIFICATIONS_FILE = NOTIFICATIONS_FILE;
module.exports.addDays = addDays;
