'use strict';
/**
 * context.js —— 应用上下文（依赖装配点）。
 *
 * 为什么单独抽出来：
 * 服务、路由、测试三边都需要同一份"已初始化好的世界"（store + 各 service）。
 * 集中在这里装配，测试就能用一行代码拿到和生产完全一致的运行时对象，
 * 不会出现"测试自己拼一套、结果测的是别的东西"。
 *
 * 装配顺序有讲究：下面的顺序就是模块之间的依赖顺序，
 * 例如 importer 需要先有 library 才能落库，所以 library 一定排在前面。
 */

const pkg = require('../package.json');
const { Store } = require('./services/store');
const { createAdapter } = require('./services/adapters/storage-adapter');
const { resolveDataDir, resolveBackupDir, resolveWebDir } = require('./lib/paths');
const { SCHEMA_VERSION } = require('./lib/constants');

/**
 * 服务清单：[ctx 上的名字, 模块路径, 类型]
 * 按开发阶段（PRD §11 S0~S10）逐步补齐，顺序即依赖顺序。
 *
 * 类型：
 *   'service'（默认）—— 导出的是工厂函数 factory(ctx, options)，需要 ctx 才能构造；
 *   'module'        —— 无状态的纯函数模块（如编码检测、分章、清洗），直接用导出的对象。
 */
const SERVICE_MANIFEST = [
  ['settings', './services/settings'], // S0 起：全局设置读写（端口、并发、间隔等）
  ['tasks', './services/tasks'], // S0 起：长任务登记表（抓取/导入/备份 共用）
  ['backup', './services/backup'], // S0 起：data/ 打包与解包
  ['library', './services/library'], // S1 起：书库仓储（Book / Chapter）
  ['reading', './services/reading'], // S1 起：进度 / 书签 / 笔记 / 历史 / 时长
  ['chapterize', './services/chapterize', 'module'], // S2 起：自动分章（纯函数）
  ['cleaner', './services/cleaner', 'module'], // S2 起：正文清洗（纯函数）
  ['encoding', './services/encoding', 'module'], // S2 起：编码检测与乱码还原（纯函数）
  ['importer', './services/importer'], // S2 起：导入流水线（模块 7）
  ['shelf', './services/shelf'], // S3 起：书架组合视图（模块 1）
  ['chapters', './services/chapters'], // S5 起：目录体检 / 更新对比 / 手工调章（模块 4）
  ['search', './services/search'], // S6 起：全文索引与检索（模块 8）
  ['compliance', './services/compliance', 'module'], // S7 起：合规自检（纯函数 + 内存缓存）
  ['fetcher', './services/fetcher'], // S7 起：抓取器与抓取任务编排（模块 2）
  ['userscript', './services/userscript'], // S8 起：浏览器脚本的服务端对应实现（模块 3）
  ['scheduler', './services/scheduler'], // S9 起：定时追更（只提示不下载）
  // 注意：名字叫 storageManager 而不是 storage ——
  // ctx.storage 已经被 StorageAdapter（PRD §7 的预留接口）占用了，不能覆盖它
  ['storageManager', './services/storage'], // S10 起：存储占用与清理（模块 9）
];

function createContext(options = {}) {
  const dataDir = options.dataDir || resolveDataDir();
  const backupDir = options.backupDir || resolveBackupDir();
  const webDir = options.webDir || resolveWebDir();

  const store = new Store({ dataDir });
  const health = store.init();

  const ctx = {
    version: pkg.version,
    schemaVersion: SCHEMA_VERSION,
    dataDir,
    backupDir,
    webDir,
    store,
    /**
     * 存储适配器：业务代码只认这个接口，不直接碰 fs。
     * v1 是 LocalFileAdapter（本机文件系统 = 唯一真相源），
     * 将来接云同步时换成 CloudAdapter，上层代码不用改（PRD §7）。
     */
    storage: createAdapter('local', store),
    /** 启动体检结果：哪个文件坏了、是否已用 .bak 回退 */
    health,
    startedAt: new Date().toISOString(),
  };

  for (const [name, modulePath, kind = 'service'] of SERVICE_MANIFEST) {
    // eslint-disable-next-line global-require
    const loaded = require(modulePath);
    if (kind === 'module') {
      ctx[name] = loaded;
      continue;
    }
    if (typeof loaded !== 'function') {
      throw new Error(`服务 ${name} 没导出工厂函数`);
    }
    ctx[name] = loaded(ctx, options);
  }

  // 启动时清掉上次没走完的导入暂存（用户中途关掉窗口留下的残渣）
  if (ctx.importer && typeof ctx.importer.cleanupStaging === 'function') {
    try {
      ctx.importer.cleanupStaging();
    } catch (err) {
      console.error('[清理导入暂存失败，不影响使用]', err.message);
    }
  }

  return ctx;
}

module.exports = { createContext, SCHEMA_VERSION, SERVICE_MANIFEST };
