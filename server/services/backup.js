'use strict';
/**
 * backup.js —— data/ 整库打包与解包。
 *
 * 为什么导出格式里要放 manifest.json：
 * PRD §7 要求"导出格式需与将来云端版本保持一致，保证未来可直接导入"。
 * 如果 zip 里只有光秃秃的一堆文件，将来云端版本只能靠猜结构；
 * 加一个带 version / schemaVersion / 内容清单的 manifest，未来就能先读 manifest 再决定怎么导。
 *
 * 为什么排除 .trash 和临时文件：
 * .trash 是回收站语义（用户已经"移除"的东西），导出时带上只会让备份变大、
 * 还可能在导入时把用户删过的书又变回来。临时文件则本来就是半个文件。
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const createBackupImporter = require('./backup-import');

/** 备份里生成的文件名前缀（用中文是因为用户会自己去看这个文件夹） */
const BACKUP_PREFIX = '小说工具备份';

/** 打包时跳过的东西（相对 data/ 的 glob 语义，这里用简单前缀判断） */
const EXCLUDED_PREFIXES = ['.trash/', '.staging/', 'index/'];

function shouldSkip(rel) {
  const normalized = rel.split(path.sep).join('/');
  if (EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const base = path.basename(normalized);
  if (base.startsWith('.tmp-')) return true;
  if (base.endsWith('.bak')) return true;
  return false;
}

/** 递归收集 data/ 下要打进包的文件（相对 data/） */
function collectFiles(dataDir, relDir = '') {
  const out = [];
  const dir = relDir ? path.join(dataDir, relDir) : dataDir;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return out;
  }
  for (const entry of entries) {
    const rel = relDir ? path.join(relDir, entry.name) : entry.name;
    if (entry.isDirectory()) {
      out.push(...collectFiles(dataDir, rel));
    } else if (!shouldSkip(rel)) {
      out.push(rel.split(path.sep).join('/'));
    }
  }
  return out;
}

function timestampName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

module.exports = function createBackupService(ctx) {
  const backupImporter = createBackupImporter(ctx);
  /**
   * 导入整库备份（PRD 模块 9）。
   * 具体的冲突处理放在 backup-import.js 里，这里只做转发，
   * 让「打包」和「解包」各自独立、都能单独测。
   */
  function importZip(input, options = {}) {
    return backupImporter.importZip(input, options);
  }

  /**
   * 把 data/ 打成 zip。
   * @param {{outFile?:string}} options
   * @returns {Promise<{file:string,size:number,fileCount:number,manifest:Object}>}
   */
  function exportZip(options = {}) {
    const backupDir = options.backupDir || ctx.backupDir;
    fs.mkdirSync(backupDir, { recursive: true });
    const outFile =
      options.outFile || path.join(backupDir, `${BACKUP_PREFIX}-${timestampName()}.zip`);

    // 备份要完整：设置文件还没落盘时先写一份当前生效的设置，
    // 否则刚装好还没改过设置的用户导出的备份里会缺 settings.json。
    try {
      ctx.settings.get();
      if (!ctx.store.exists('settings.json')) ctx.settings.patch({});
    } catch (err) {
      /* 写不出来也不该让备份失败 */
    }

    // 备份要完整：设置文件还没落盘时先写一份当前生效的设置，
    // 否则"刚装好还没改过设置"的用户导出的备份里会缺 settings.json。
    try {
      if (!ctx.store.exists('settings.json')) ctx.settings.patch({});
    } catch (err) {
      /* 写不出来也不该让备份失败 */
    }

    const files = collectFiles(ctx.dataDir);
    const manifest = {
      format: 'novel-tool-backup',
      formatVersion: 1,
      app: '小说工具',
      appVersion: ctx.version,
      schemaVersion: ctx.schemaVersion,
      syncState: 'local',
      owner_id: 'local',
      exportedAt: new Date().toISOString(),
      /** zip 内数据根目录，导入时按它定位 */
      dataRoot: 'data/',
      fileCount: files.length,
      /** 未被收录的内容，导入方据此知道"少的东西本来就不该有" */
      excluded: EXCLUDED_PREFIXES,
      health: ctx.health && ctx.health.hasProblem ? ctx.health.issues : [],
    };

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outFile);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        resolve({
          file: outFile,
          size: fs.statSync(outFile).size,
          fileCount: files.length,
          manifest,
        });
      });
      output.on('error', reject);
      archive.on('warning', (err) => {
        if (err.code !== 'ENOENT') reject(err);
      });
      archive.on('error', reject);

      archive.pipe(output);
      archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
      for (const rel of files) {
        archive.file(path.join(ctx.dataDir, rel), { name: 'data/' + rel });
      }
      archive.finalize();
    });
  }

  /** 列出已有的备份包，新的排前面（设置页要用） */
  function listBackups() {
    const backupDir = ctx.backupDir;
    let entries = [];
    try {
      entries = fs.readdirSync(backupDir);
    } catch (err) {
      return [];
    }
    return entries
      .filter((name) => name.toLowerCase().endsWith('.zip'))
      .map((name) => {
        const full = path.join(backupDir, name);
        const stat = fs.statSync(full);
        return { name, file: full, size: stat.size, createdAt: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return {
    BACKUP_PREFIX,
    EXCLUDED_PREFIXES,
    exportZip,
    listBackups,
    collectFiles: () => collectFiles(ctx.dataDir),
    importZip,
    CONFLICT_MODES,
  };
};

// ------------------------------------------------------------------ 导入

/** 冲突处理方式（PRD 模块 9：跳过已存在的书 / 覆盖 / 并存） */
const CONFLICT_MODES = ['skip', 'overwrite', 'coexist'];

module.exports.collectFiles = collectFiles;
module.exports.timestampName = timestampName;
module.exports.BACKUP_PREFIX = BACKUP_PREFIX;
