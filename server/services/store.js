'use strict';
/**
 * store.js —— 存储层（唯一真相源）。
 *
 * 设计依据（PRD §1.3 硬约束 2、§6.2 写入规则）：
 *   1. 浏览器存储只能当缓存，真相源一定是 data/ 下的磁盘文件 —— 所以业务代码只跟本模块打交道。
 *   2. 一律"写临时文件 → 原子重命名"，禁止直接覆盖：直接覆盖时若进程被杀，会留下半个文件，
 *      JSON 直接坏掉，用户的书就没了。原子重命名要么成功要么完全没动。
 *   3. 每次覆盖前先留一份同名 .bak：新内容本身写对了但内容有问题时，用户还有上一版可回退。
 *   4. 启动时校验 JSON 可解析，损坏则回退 .bak，并且**明确告知哪个文件坏了**，绝不静默丢弃。
 *   5. 每章独立一个 txt 文件，避免大文件卡顿与浏览器存储上限。
 *
 * 另外这里顺手提供了 StorageAdapter 的本地实现（预留项，见 PRD §7）：
 * 将来要加 CloudAdapter 时，只要实现同一组方法，业务代码不用改。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ensureDirSync, safeJoin, DATA_SUBDIRS } = require('../lib/paths');

/** 临时文件统一前缀，方便异常退出后清理残留 */
const TMP_PREFIX = '.tmp-';

function isTmpName(name) {
  return name.startsWith(TMP_PREFIX);
}

class Store {
  /**
   * @param {{dataDir:string}} options
   */
  constructor(options = {}) {
    if (!options.dataDir) throw new Error('Store 需要 dataDir');
    this.dataDir = path.resolve(options.dataDir);
    /** 启动体检结果：[{file,status,message,technical}] */
    this.issues = [];
  }

  // ---------------------------------------------------------------- 路径

  abs(relPath) {
    return safeJoin(this.dataDir, relPath);
  }

  exists(relPath) {
    return fs.existsSync(this.abs(relPath));
  }

  // ---------------------------------------------------------------- 初始化 / 体检

  /** 建好数据目录骨架，然后做一次全量 JSON 体检 */
  init() {
    ensureDirSync(this.dataDir);
    for (const sub of DATA_SUBDIRS) {
      ensureDirSync(path.join(this.dataDir, sub));
    }
    this.verifyAllJson();
    return this.healthReport();
  }

  _record(issue) {
    // 同一个文件同一种状态只记一次，避免刷新时刷屏
    const dup = this.issues.find((i) => i.file === issue.file && i.status === issue.status);
    if (!dup) this.issues.push(issue);
  }

  /**
   * 遍历 data/ 下所有 .json，校验能否解析。
   * 损坏 → 尝试用同名 .bak 回退（并把 .bak 内容写回主文件）；连 .bak 也不行 → 标记为不可恢复。
   */
  verifyAllJson() {
    this.issues = [];
    const jsonFiles = this._walkFiles('', (name) => name.toLowerCase().endsWith('.json'));

    for (const rel of jsonFiles) {
      const primary = this._tryParseFile(rel);
      if (primary.ok) continue;

      const bakRel = rel + '.bak';
      const backup = this._tryParseFile(bakRel);
      if (backup.ok) {
        // 回退：把 .bak 的内容原样写回主文件（写回本身也是原子写）
        this._writeBufferAtomic(rel, Buffer.from(JSON.stringify(backup.value), 'utf8'));
        this._record({
          file: rel,
          status: 'recovered',
          message: `data/${rel} 损坏，已回退到 .bak，数据没有丢。`,
          technical: primary.error,
        });
      } else {
        this._record({
          file: rel,
          status: 'corrupt',
          message: `data/${rel} 损坏，而且备用文件 data/${bakRel} 也读不出来。`,
          technical: primary.error,
        });
      }
    }
    return this.issues;
  }

  /** 给设置页和启动日志用的人话简报 */
  healthReport() {
    return {
      dataDir: this.dataDir,
      issues: this.issues.map((i) => ({ file: i.file, status: i.status, message: i.message })),
      hasProblem: this.issues.length > 0,
    };
  }

  /** 递归列出相对路径下的所有文件（相对 data/），可传过滤函数 */
  _walkFiles(relDir, filter, out = []) {
    const dir = relDir ? this.abs(relDir) : this.dataDir;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      return out;
    }
    for (const entry of entries) {
      const rel = relDir ? relDir + '/' + entry.name : entry.name;
      // 回收站、上传暂存区、临时文件都不参与体检：
      // 它们在语义上就是"可能不完整 / 随时会没"的东西
      if (entry.name === '.trash' || entry.name === '.staging') continue;
      if (isTmpName(entry.name)) continue;
      if (entry.isDirectory()) {
        this._walkFiles(rel, filter, out);
      } else if (!filter || filter(entry.name, rel)) {
        out.push(rel);
      }
    }
    return out;
  }

  _tryParseFile(rel) {
    const target = this.abs(rel);
    let raw;
    try {
      raw = fs.readFileSync(target, 'utf8');
    } catch (err) {
      return { ok: false, error: err.code === 'ENOENT' ? '文件不存在' : err.message, missing: true };
    }
    if (raw.trim() === '') {
      // 空文件当成"空对象"，不算损坏：工具第一次跑的时候就是这种状态
      return { ok: true, value: null, empty: true };
    }
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ---------------------------------------------------------------- 读

  /**
   * 读 JSON。文件不存在返回 fallback；损坏时自动尝试 .bak。
   * @param {string} rel
   * @param {*} fallback
   */
  readJson(rel, fallback = null) {
    const primary = this._tryParseFile(rel);
    if (primary.ok) {
      return primary.empty ? fallback : primary.value;
    }
    if (primary.missing) return fallback;

    const backup = this._tryParseFile(rel + '.bak');
    if (backup.ok && !backup.empty) {
      this._record({
        file: rel,
        status: 'recovered',
        message: `data/${rel} 损坏，已回退到 .bak，数据没有丢。`,
        technical: primary.error,
      });
      return backup.value;
    }
    this._record({
      file: rel,
      status: 'corrupt',
      message: `data/${rel} 损坏，而且备用文件 data/${rel}.bak 也读不出来。`,
      technical: primary.error,
    });
    return fallback;
  }

  /** 读纯文本；主文件读不出来时退回 .bak */
  readText(rel, fallback = null) {
    const target = this.abs(rel);
    try {
      return fs.readFileSync(target, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        try {
          const bak = fs.readFileSync(target + '.bak', 'utf8');
          this._record({
            file: rel,
            status: 'recovered',
            message: `data/${rel} 读不出来，已回退到 .bak。`,
            technical: err.message,
          });
          return bak;
        } catch (inner) {
          /* 继续往下走，返回 fallback */
        }
      }
      return fallback;
    }
  }

  readBuffer(rel) {
    const target = this.abs(rel);
    try {
      return fs.readFileSync(target);
    } catch (err) {
      try {
        return fs.readFileSync(target + '.bak');
      } catch (inner) {
        return null;
      }
    }
  }

  // ---------------------------------------------------------------- 写（原子）

  /**
   * 原子写 Buffer。
   * 步骤：临时文件 → fsync → （若已有目标，先留 .bak）→ rename 覆盖。
   * 之所以先 fsync：不做的话"文件已改名但内容还在系统缓存里"时断电会得到空文件。
   *
   * options.sync = false 用于**批量写章节正文**这种场景：
   * 一次性导入 3000 章时，每章都 fsync 会让导入慢好几倍，而单章的持久性其实不重要
   * ——因为 book.json（章节清单）是最后才写的，中途断掉的话这些正文文件根本不会被任何
   * 清单引用，相当于不可见，下次导入直接覆盖即可。整本书的"可见性"由最后一次
   * book.json 的原子写来保证。
   */
  _writeBufferAtomic(rel, buffer, options = {}) {
    const target = this.abs(rel);
    const dir = path.dirname(target);
    ensureDirSync(dir);

    const tmp = path.join(
      dir,
      TMP_PREFIX + path.basename(target) + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex')
    );

    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, buffer);
      if (options.sync !== false) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    if (fs.existsSync(target)) {
      // .bak 也走"临时 → 改名"，这样 .bak 永远不会是半个文件
      const bakTmp = tmp + '.bak';
      fs.copyFileSync(target, bakTmp);
      fs.renameSync(bakTmp, target + '.bak');
    }

    fs.renameSync(tmp, target);
    return target;
  }

  writeJson(rel, value, options) {
    const text = JSON.stringify(value, null, 2);
    this._writeBufferAtomic(rel, Buffer.from(text, 'utf8'), options);
    return value;
  }

  writeText(rel, text, options) {
    this._writeBufferAtomic(rel, Buffer.from(String(text), 'utf8'), options);
    return text;
  }

  writeBuffer(rel, buffer, options) {
    this._writeBufferAtomic(rel, Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer), options);
    return buffer;
  }

  // ---------------------------------------------------------------- 目录 / 删除

  ensureDir(rel = '') {
    return ensureDirSync(rel ? this.abs(rel) : this.dataDir);
  }

  listDir(rel = '') {
    try {
      return fs.readdirSync(rel ? this.abs(rel) : this.dataDir);
    } catch (err) {
      return [];
    }
  }

  /** 删除文件（连带 .bak）。只用于明确要清除的目标，业务上"移除书"必须走 moveToTrash。 */
  remove(rel) {
    const target = this.abs(rel);
    let removed = false;
    for (const p of [target, target + '.bak']) {
      try {
        fs.unlinkSync(p);
        removed = true;
      } catch (err) {
        /* 不存在就算了 */
      }
    }
    return removed;
  }

  removeDir(rel) {
    const target = this.abs(rel);
    if (!fs.existsSync(target)) return false;
    fs.rmSync(target, { recursive: true, force: true });
    return true;
  }

  /**
   * 移动到回收站（不移除正文）。
   * PRD §3 明确："移除只删索引，正文文件移入 data/.trash/，不直接抹掉"。
   * 重名时加时间戳后缀，保证不会互相覆盖。
   */
  moveToTrash(relPath, trashName) {
    const source = this.abs(relPath);
    if (!fs.existsSync(source)) return null;
    const trashDir = path.join(this.dataDir, '.trash');
    ensureDirSync(trashDir);

    const base = trashName || path.basename(source);
    let dest = path.join(trashDir, base);
    if (fs.existsSync(dest)) {
      dest = path.join(trashDir, `${base}.${Date.now()}`);
    }
    fs.renameSync(source, dest);
    return path.relative(this.dataDir, dest).split(path.sep).join('/');
  }

  /** 清空回收站 */
  emptyTrash() {
    const trashDir = path.join(this.dataDir, '.trash');
    if (!fs.existsSync(trashDir)) return 0;
    const entries = fs.readdirSync(trashDir);
    for (const entry of entries) {
      fs.rmSync(path.join(trashDir, entry), { recursive: true, force: true });
    }
    return entries.length;
  }

  /** 递归统计占用（字节） */
  dirSize(rel = '') {
    const dir = rel ? this.abs(rel) : this.dataDir;
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
            /* 文件刚好被删掉了，忽略 */
          }
        }
      }
    };
    walk(dir);
    return total;
  }

  /** 列出某目录下全部文件（相对 data/） */
  listFiles(rel = '', filter) {
    return this._walkFiles(rel, filter);
  }
}

/** book_id = sha1(来源域名 + 书名) 取前 12 位（PRD §6.1） */
function makeBookId(sourceDomain, title) {
  const seed = `${String(sourceDomain || 'local')}::${String(title || '').trim()}`;
  return crypto.createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 12);
}

/** 正文内容哈希：追更判断"章节内容有没有变"，以及重复章节去重（PRD §6.3） */
function contentHash(text) {
  const normalized = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\s\u3000]+/g, '')
    .trim();
  return crypto.createHash('sha1').update(normalized, 'utf8').digest('hex');
}

module.exports = { Store, makeBookId, contentHash, TMP_PREFIX };
