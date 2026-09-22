'use strict';
/**
 * paths.js —— 统一管理"项目根 / 数据目录 / 备份目录"的绝对路径。
 *
 * 为什么单独抽出来：
 * 硬约束要求"只在本机运行、data/ 可以整体拷走"，所以数据目录必须能被外部指定
 * （测试里用临时目录，用户也可以把 data/ 放到别处）。把所有路径计算集中在一处，
 * 就不会出现某个模块自己拼路径、结果写到奇怪地方的问题。
 */

const path = require('path');
const fs = require('fs');

/** 项目根目录：server/lib/ → 上跳两级即 novel-tool/ */
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/** 运行时数据目录。测试通过 NOVEL_TOOL_DATA 注入临时目录，避免污染真实数据。 */
function resolveDataDir() {
  const custom = process.env.NOVEL_TOOL_DATA;
  return custom ? path.resolve(custom) : path.join(ROOT_DIR, 'data');
}

/** 备份目录（backups/*.zip） */
function resolveBackupDir() {
  const custom = process.env.NOVEL_TOOL_BACKUP;
  return custom ? path.resolve(custom) : path.join(ROOT_DIR, 'backups');
}

/** 静态资源目录 web/ */
function resolveWebDir() {
  const custom = process.env.NOVEL_TOOL_WEB;
  return custom ? path.resolve(custom) : path.join(ROOT_DIR, 'web');
}

/** 油猴脚本目录 userscript/ */
function resolveUserscriptDir() {
  return path.join(ROOT_DIR, 'userscript');
}

/** data/ 下需要预先建好的子目录 */
const DATA_SUBDIRS = [
  'books',
  'reading',
  'index',
  'raw',
  // 上传暂存区：只放"还没确定要导入"的原始字节，成功落库后立刻清掉
  '.staging',
  '.trash',
];

/**
 * 把相对路径安全地拼到 data/ 下。
 * 做了目录穿越防护：任何试图用 ../ 逃出数据目录的路径都会被拒绝。
 */
function safeJoin(baseDir, relPath) {
  const target = path.resolve(baseDir, relPath);
  const rel = path.relative(baseDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('路径越界：不允许访问数据目录以外的文件');
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return target;
}

function ensureDirSync(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  ROOT_DIR,
  DATA_SUBDIRS,
  resolveDataDir,
  resolveBackupDir,
  resolveWebDir,
  resolveUserscriptDir,
  safeJoin,
  ensureDirSync,
};
