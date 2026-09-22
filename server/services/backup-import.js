'use strict';
/**
 * backup-import.js —— 整库备份的导入与冲突处理（PRD 模块 9）。
 *
 * 冲突三种处理方式（PRD 明确要求让用户选）：
 *   skip      跳过已存在的书（默认，最安全）
 *   overwrite 用备份里的覆盖本地那一本（本地那本会先进回收站，不直接删）
 *   coexist   两份都留着 —— 备份里那本换一个新编号，标题加「（导入）」后缀
 *
 * 为什么导入完要重建索引：
 *   coexist 模式下书的编号会变、overwrite 模式下目录被换过，
 *   与其一条条去改索引条目，不如直接从每本书的 book.json 重新生成索引 ——
 *   索引本来就是派生数据，重建永远比修补可靠。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const AdmZip = require('adm-zip');
const { ApiError } = require('../lib/errors');
const { makeBookId } = require('./store');
const { nowIso } = require('../schema/models');
const { SCHEMA_VERSION } = require('../lib/constants');

const CONFLICT_MODES = ['skip', 'overwrite', 'coexist'];

module.exports = function createBackupImporter(ctx) {
  // 注意：装配顺序上 backup 服务排在 library 前面，构造时 ctx.library 还不存在，
  // 所以这里必须懒取，不能把 ctx.library / ctx.store 在构造时解构出来。
  const lib = () => ctx.library;
  const io = () => ctx.store;

  // ---------------------------------------------------------------- 工具

  function readJsonSafe(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return fallback;
    }
  }

  function copyDir(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }

  function dirSize(dir) {
    let total = 0;
    const walk = (d) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (err) {
        return;
      }
      for (const entry of entries) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else {
          try {
            total += fs.statSync(full).size;
          } catch (err) {
            /* 忽略 */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  /** coexist 时给书换一个不冲突的编号 */
  function makeCoexistId(original, title) {
    if (!lib().exists(original)) return original;
    let candidate = makeBookId('imported', `${title}-${Date.now()}`);
    let guard = 0;
    while (lib().exists(candidate) && guard < 20) {
      candidate = makeBookId('imported', `${title}-${Date.now()}-${guard}`);
      guard++;
    }
    return candidate;
  }

  // ---------------------------------------------------------------- 导入

  /**
   * @param {Buffer|string} input  zip 内容或 zip 文件路径
   * @param {{conflict?:string, import_settings?:boolean}} options
   */
  function importZip(input, options = {}) {
    const conflict = CONFLICT_MODES.includes(options.conflict) ? options.conflict : 'skip';

    let zip;
    try {
      zip = new AdmZip(input);
    } catch (err) {
      throw new ApiError(
        'BAD_BACKUP',
        '这个文件读不出来，不像是压缩包。',
        '请选择用「备份.bat」或设置页「导出整库」生成的那个 zip 文件。',
        400
      );
    }

    const manifestEntry = zip.getEntry('manifest.json');
    if (!manifestEntry) {
      throw new ApiError(
        'NOT_A_BACKUP',
        '这个压缩包里没有小说工具的备份信息（manifest.json）。',
        '请选择用「备份.bat」或设置页「导出整库」生成的那个 zip 文件。',
        400
      );
    }

    let manifest;
    try {
      manifest = JSON.parse(zip.readAsText('manifest.json'));
    } catch (err) {
      throw new ApiError(
        'BAD_MANIFEST',
        '备份信息读不出来。',
        '这个 zip 可能已经损坏，请换一个备份文件，或者重新备份一次。',
        400
      );
    }

    if (manifest.format !== 'novel-tool-backup') {
      throw new ApiError(
        'NOT_A_BACKUP',
        '这个压缩包不是小说工具的备份。',
        '请选择用「备份.bat」或设置页「导出整库」生成的那个 zip 文件。',
        400
      );
    }

    // 解压到系统临时目录：不动 data/，出问题也不会污染用户数据
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novel-tool-import-'));
    const result = {
      conflict,
      conflictLabel: { skip: '跳过已存在的书', overwrite: '覆盖', coexist: '并存' }[conflict],
      manifest: {
        app: manifest.app,
        appVersion: manifest.appVersion,
        schemaVersion: manifest.schemaVersion,
        exportedAt: manifest.exportedAt,
        fileCount: manifest.fileCount,
      },
      books: { added: [], skipped: [], overwritten: [], coexisted: [] },
      reading: { progress: 0, bookmarks: 0, notes: 0, history: 0, sessions: 0 },
      settingsImported: false,
      warnings: [],
    };

    try {
      zip.extractAllTo(tmp, true);
      const srcData = path.join(tmp, 'data');
      if (!fs.existsSync(srcData)) {
        throw new ApiError(
          'BACKUP_EMPTY',
          '备份包里没有数据目录。',
          '这个备份可能是空的，请换一个备份文件。',
          400
        );
      }

      const backupLibrary = readJsonSafe(path.join(srcData, 'library.json'), { books: [] });
      const summaries = Array.isArray(backupLibrary.books) ? backupLibrary.books : [];

      /** 备份里的书编号 → 导入后的书编号（coexist 时会变） */
      const idMap = new Map();

      for (const summary of summaries) {
        const oldId = summary && summary.book_id;
        if (!oldId) continue;
        const sourceDir = path.join(srcData, 'books', oldId);
        if (!fs.existsSync(sourceDir)) {
          result.warnings.push(`备份里没有《${summary.title || oldId}》的正文目录，已跳过。`);
          continue;
        }

        const title = summary.title || oldId;
        const exists = lib().exists(oldId);

        if (exists && conflict === 'skip') {
          result.books.skipped.push({ book_id: oldId, title, reason: '书架上已经有这本书' });
          // 阅读进度也按"跳过"处理：不覆盖本地已有的
          idMap.set(oldId, oldId);
          continue;
        }

        if (exists && conflict === 'overwrite') {
          // 先把本地那本挪进回收站，再放备份的进去
          const trashed = lib().remove(oldId, { purge: false });
          copyDir(sourceDir, path.join(ctx.dataDir, 'books', oldId));
          result.books.overwritten.push({
            book_id: oldId,
            title,
            trashed: trashed ? trashed.trashed : null,
          });
          idMap.set(oldId, oldId);
          continue;
        }

        if (exists && conflict === 'coexist') {
          const newId = makeCoexistId(oldId, title);
          copyDir(sourceDir, path.join(ctx.dataDir, 'books', newId));
          // 改写这本文档里的编号与标题，让它成为独立的一本
          const bookFile = path.join(ctx.dataDir, 'books', newId, 'book.json');
          const book = readJsonSafe(bookFile, null);
          if (book) {
            book.book_id = newId;
            book.title = `${book.title || title}（导入）`;
            book.source_site = book.source_site || 'imported';
            book.updatedAt = nowIso();
            book.schemaVersion = SCHEMA_VERSION;
            fs.writeFileSync(bookFile, JSON.stringify(book, null, 2), 'utf8');
          }
          result.books.coexisted.push({ book_id: newId, title: `${title}（导入）`, from: oldId });
          idMap.set(oldId, newId);
          continue;
        }

        // 本地没有这本书：直接放进来
        copyDir(sourceDir, path.join(ctx.dataDir, 'books', oldId));
        result.books.added.push({ book_id: oldId, title });
        idMap.set(oldId, oldId);
      }

      // 从每本书的 book.json 重新生成索引 —— 比修补索引可靠
      lib().rebuildIndex();

      // ---- 阅读数据合并
      mergeProgress(srcData, idMap, conflict, result);
      mergeList(srcData, 'bookmarks.json', 'bookmarks', idMap, conflict, result, 'bookmarks');
      mergeList(srcData, 'notes.json', 'notes', idMap, conflict, result, 'notes');
      mergeHistory(srcData, idMap, result);
      mergeSessions(srcData, idMap, result);

      // ---- 设置：默认不动（覆盖用户现有偏好是一件"悄悄改变用户习惯"的事）
      if (options.import_settings === true) {
        const settingsFile = path.join(srcData, 'settings.json');
        if (fs.existsSync(settingsFile)) {
          const remote = readJsonSafe(settingsFile, null);
          if (remote) {
            io().writeJson('settings.json', remote);
            result.settingsImported = true;
          }
        }
      }

      // ---- 索引重建（书变多了）
      if (ctx.search && typeof ctx.search.reindex === 'function') {
        try {
          ctx.search.reindex();
        } catch (err) {
          result.warnings.push('全文索引重建失败，可以在设置页手动重建一次。');
        }
      }

      const added = result.books.added.length;
      const overwritten = result.books.overwritten.length;
      const coexisted = result.books.coexisted.length;
      const skipped = result.books.skipped.length;
      result.message =
        `导入完成：新增 ${added} 本，覆盖 ${overwritten} 本，并存 ${coexisted} 本，跳过 ${skipped} 本。` +
        (result.reading.progress ? ` 合并了 ${result.reading.progress} 本书的阅读进度。` : '');
      return result;
    } finally {
      // 临时目录一定要清掉
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (err) {
        /* 清不掉就留给系统清理 */
      }
    }
  }

  /** 阅读进度：按 book_id 映射后合并 */
  function mergeProgress(srcData, idMap, conflict, result) {
    const file = path.join(srcData, 'reading', 'progress.json');
    if (!fs.existsSync(file)) return;
    const remote = readJsonSafe(file, null);
    if (!remote || !remote.progress) return;

    const local = io().readJson('reading/progress.json', null) || {};
    const localProgress = local.progress || {};
    let merged = 0;

    for (const [oldId, item] of Object.entries(remote.progress)) {
      const newId = idMap.get(oldId);
      if (!newId) continue;
      const localItem = localProgress[newId];
      if (localItem && conflict === 'skip') continue;
      // 本地更新的就保留本地（除非是覆盖模式）
      if (localItem && conflict === 'coexist') {
        const localAt = new Date(localItem.updated_at || 0).getTime();
        const remoteAt = new Date(item.updated_at || 0).getTime();
        if (localAt >= remoteAt) continue;
      }
      localProgress[newId] = { ...item, book_id: newId };
      merged++;
    }

    if (merged) {
      io().writeJson('reading/progress.json', {
        ...local,
        schemaVersion: SCHEMA_VERSION,
        syncState: 'local',
        owner_id: 'local',
        updatedAt: nowIso(),
        progress: localProgress,
      });
    }
    result.reading.progress = merged;
  }

  /** 书签 / 笔记：按 id 去重后追加 */
  function mergeList(srcData, fileName, key, idMap, conflict, result, counterKey) {
    const file = path.join(srcData, 'reading', fileName);
    if (!fs.existsSync(file)) return;
    const remote = readJsonSafe(file, null);
    if (!remote || !Array.isArray(remote[key])) return;

    const local = io().readJson(`reading/${fileName}`, null) || {};
    const items = Array.isArray(local[key]) ? [...local[key]] : [];
    const seenIds = new Set(items.map((item) => item.id));
    const seenKeys = new Set(items.map((item) => `${item.book_id}|${item.chapter_index}|${item.char_offset}`));
    let merged = 0;

    for (const item of remote[key]) {
      const newId = idMap.get(item.book_id);
      if (!newId) continue;
      const next = { ...item, book_id: newId };
      if (seenIds.has(next.id)) {
        if (conflict !== 'overwrite') continue;
        const at = items.findIndex((x) => x.id === next.id);
        items[at] = next;
        merged++;
        continue;
      }
      const dedupeKey = `${next.book_id}|${next.chapter_index}|${next.char_offset}`;
      if (seenKeys.has(dedupeKey) && conflict === 'skip') continue;
      items.push(next);
      seenIds.add(next.id);
      seenKeys.add(dedupeKey);
      merged++;
    }

    if (merged) {
      io().writeJson(`reading/${fileName}`, {
        ...local,
        schemaVersion: SCHEMA_VERSION,
        syncState: 'local',
        owner_id: 'local',
        updatedAt: nowIso(),
        [key]: items,
      });
    }
    result.reading[counterKey] = merged;
  }

  function mergeHistory(srcData, idMap, result) {
    const file = path.join(srcData, 'reading', 'history.json');
    if (!fs.existsSync(file)) return;
    const remote = readJsonSafe(file, null);
    if (!remote || !Array.isArray(remote.entries)) return;

    const local = io().readJson('reading/history.json', null) || {};
    const entries = Array.isArray(local.entries) ? [...local.entries] : [];
    let merged = 0;
    for (const entry of remote.entries) {
      const newId = idMap.get(entry.book_id);
      if (!newId) continue;
      entries.push({ ...entry, book_id: newId });
      merged++;
    }
    if (!merged) return;
    entries.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    if (entries.length > 500) entries.length = 500;
    io().writeJson('reading/history.json', {
      ...local,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      updatedAt: nowIso(),
      entries,
    });
    result.reading.history = merged;
  }

  function mergeSessions(srcData, idMap, result) {
    const file = path.join(srcData, 'reading', 'sessions.json');
    if (!fs.existsSync(file)) return;
    const remote = readJsonSafe(file, null);
    if (!remote || !Array.isArray(remote.sessions)) return;

    const local = io().readJson('reading/sessions.json', null) || {};
    const sessions = Array.isArray(local.sessions) ? [...local.sessions] : [];
    // 用开始时间 + 书编号做去重键：重复导入同一份备份不会把时长算两遍
    const seen = new Set(sessions.map((s) => `${s.book_id}|${s.started_at}|${s.duration_ms}`));
    let merged = 0;
    for (const session of remote.sessions) {
      const newId = idMap.get(session.book_id);
      if (!newId) continue;
      const key = `${newId}|${session.started_at}|${session.duration_ms}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sessions.push({ ...session, book_id: newId });
      merged++;
    }
    if (!merged) return;
    sessions.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    if (sessions.length > 5000) sessions.length = 5000;
    io().writeJson('reading/sessions.json', {
      ...local,
      schemaVersion: SCHEMA_VERSION,
      syncState: 'local',
      owner_id: 'local',
      updatedAt: nowIso(),
      sessions,
    });
    result.reading.sessions = merged;
  }

  return {
    CONFLICT_MODES,
    importZip,
    dirSize,
  };
};

module.exports.CONFLICT_MODES = CONFLICT_MODES;
