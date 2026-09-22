'use strict';
/**
 * storage.js —— 存储占用查看与清理（PRD 模块 9）。
 *
 * 两件事：
 *   1. usage()：data/ 一共多大、每一块占多少、每本书占多少（可按大小排序）
 *   2. cleanup(target)：清理指定目标。**每个目标都必须说清楚影响范围**，
 *      因为界面上要二次确认，用户得知道他要付出什么代价。
 *
 * 注意"重建索引"也算一种清理动作 —— 它清的是索引这个缓存，不是用户数据。
 */

const path = require('path');
const { ApiError } = require('../lib/errors');

/** 可清理的目标 */
const CLEANUP_TARGETS = [
  {
    id: 'source-snapshots',
    label: '抓取来源页快照',
    description: '抓取时顺手存下来的原始网页，只用于排查问题，删掉不影响阅读和重新抓取。',
    impact: '删除 data/books/*/raw/ 下的所有网页快照。',
  },
  {
    id: 'rebuild-index',
    label: '重建全文检索索引',
    description: '索引是可重建的缓存。重建期间搜索会短暂变慢，完了就恢复正常。',
    impact: '清空并重新生成 data/index/ 下的索引文件，不动任何正文。',
  },
  {
    id: 'trash',
    label: '清空回收站',
    description: '从书架移除、合并掉的书，正文会先放进这里。清空之后就找不回来了。',
    impact: '删除 data/.trash/ 下的全部内容（正文会真的消失）。',
  },
  {
    id: 'staging',
    label: '清理导入暂存',
    description: '导入过程中临时存放的原始文件，正常情况下会自动清掉。',
    impact: '删除 data/.staging/ 下的全部内容，可能让"还没确认完的导入"作废。',
  },
];

module.exports = function createStorageService(ctx) {
  const { store, library } = ctx;

  /** data/ 各块的占用 */
  function usage() {
    const totalBytes = store.dirSize('');
    const books = library.list().map((book) => {
      const bytes = store.dirSize(path.posix.join('books', book.book_id));
      return {
        book_id: book.book_id,
        title: book.title,
        author: book.author,
        total_chapters: book.total_chapters,
        bytes,
      };
    });
    books.sort((a, b) => b.bytes - a.bytes);

    const breakdown = {
      books: store.dirSize('books'),
      index: store.dirSize('index'),
      reading: store.dirSize('reading'),
      trash: store.dirSize('.trash'),
      staging: store.dirSize('.staging'),
      backups: 0, // 备份在 data/ 外面，单独统计
    };
    const backupsBytes = (() => {
      let total = 0;
      try {
        for (const item of ctx.backup.listBackups()) total += item.size;
      } catch (err) {
        /* 备份目录不可读就算了 */
      }
      return total;
    })();
    breakdown.backups = backupsBytes;

    return {
      dataDir: ctx.dataDir,
      backupDir: ctx.backupDir,
      totalBytes,
      backupsBytes,
      breakdown,
      books,
      bookCount: books.length,
      /** 界面上按大小排序用的现成顺序 */
      sortedBySize: books.slice(0, 50),
    };
  }

  /** 清某本书的来源页快照 */
  function clearSourceSnapshots(bookId) {
    let removed = 0;
    let freed = 0;
    const targets = bookId ? [bookId] : store.listDir('books');
    for (const id of targets) {
      const rel = path.posix.join('books', id, 'raw');
      const bytes = store.dirSize(rel);
      if (store.removeDir(rel)) {
        removed++;
        freed += bytes;
      }
    }
    return { removed, freedBytes: freed };
  }

  /**
   * 执行清理。
   * @param {string} target CLEANUP_TARGETS 里的 id
   * @param {{book_id?:string}} options
   */
  function cleanup(target, options = {}) {
    const meta = CLEANUP_TARGETS.find((item) => item.id === target);
    if (!meta) {
      throw new ApiError(
        'UNKNOWN_CLEANUP_TARGET',
        '不知道要清理什么。',
        `可以清理的是：${CLEANUP_TARGETS.map((t) => t.label).join('、')}。`,
        400
      );
    }

    let result;
    if (target === 'source-snapshots') {
      const done = clearSourceSnapshots(options.book_id);
      result = {
        removed: done.removed,
        freedBytes: done.freedBytes,
        message: done.removed
          ? `清掉了 ${done.removed} 本书的来源页快照，腾出 ${formatBytes(done.freedBytes)}。`
          : '没有需要清理的来源页快照。',
      };
    } else if (target === 'rebuild-index') {
      const done = ctx.search.reindex();
      result = {
        removed: 0,
        freedBytes: 0,
        index: done,
        message: `${done.message}（索引本身占的空间会在重建后重新算）`,
      };
    } else if (target === 'trash') {
      const before = store.dirSize('.trash');
      const count = store.emptyTrash();
      result = {
        removed: count,
        freedBytes: before,
        message: count
          ? `清空回收站，删掉 ${count} 项，腾出 ${formatBytes(before)}。这一步之后找不回来了。`
          : '回收站本来就是空的。',
      };
    } else {
      const before = store.dirSize('.staging');
      const count = store.listDir('.staging').length;
      store.removeDir('.staging');
      store.ensureDir('.staging');
      result = {
        removed: count,
        freedBytes: before,
        message: count ? `清掉 ${count} 个暂存文件，腾出 ${formatBytes(before)}。` : '没有需要清理的暂存文件。',
      };
    }

    return {
      target,
      label: meta.label,
      impact: meta.impact,
      ...result,
      usage: usage(),
    };
  }

  function formatBytes(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} 字节`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  /** 关于信息（PRD 模块 9：版本号、数据目录绝对路径、schema 版本） */
  function about() {
    const settings = ctx.settings.get();
    return {
      app: '小说工具',
      version: ctx.version,
      schemaVersion: ctx.schemaVersion,
      dataDir: ctx.dataDir,
      backupDir: ctx.backupDir,
      userscriptDir: path.join(path.dirname(ctx.dataDir), 'userscript'),
      startedAt: ctx.startedAt,
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      /** 数据体检（哪个文件坏了、有没有用 .bak 回退） */
      health: ctx.health,
      /** 合规相关的硬下限，界面上用来给"改抓取参数"的风险提示做参照 */
      limits: {
        maxConcurrency: settings.fetch.concurrency,
        minDomainIntervalMs: settings.fetch.domainIntervalMs,
        complianceMaxConcurrency: ctx.settings.COMPLIANCE_LIMITS.maxConcurrency,
        complianceMinDomainIntervalMs: ctx.settings.COMPLIANCE_LIMITS.minDomainIntervalMs,
      },
      /** 脚本安装入口 */
      userscriptUrl: '/api/userscript/script',
      /** 存储层实现（将来换成云适配器时这里会变） */
      storageKind: ctx.storage.kind,
      /** 抓取器实现 */
      providers: ctx.fetcher.PROVIDERS.map((p) => ({ id: p.id, label: p.label })),
      /** 预留能力的状态，让"v1 没做但留了口子"这件事可见 */
      reserved: {
        auth: '未开放（/api/auth/* 返回 501）',
        schemaMigration: `已预留 migrate(from, to)，当前 schemaVersion = ${ctx.schemaVersion}`,
        syncState: 'local',
        cloudStorage: '未实现（StorageAdapter 已抽象）',
      },
    };
  }

  return {
    CLEANUP_TARGETS,
    usage,
    cleanup,
    about,
    formatBytes,
  };
};

module.exports.CLEANUP_TARGETS = CLEANUP_TARGETS;
