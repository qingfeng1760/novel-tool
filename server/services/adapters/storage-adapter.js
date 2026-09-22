'use strict';
/**
 * storage-adapter.js —— 存储层抽象（PRD §7 预留项）。
 *
 * 为什么要有这一层：
 * 需求明确"将来加 CloudAdapter 时业务代码不改"。
 * 所以业务代码只允许依赖下面这套 StorageAdapter 接口，
 * 不直接碰 fs，也不直接碰 Store 的私有细节。
 * v1 只实现 LocalFileAdapter（本机文件系统 = 唯一真相源）。
 */

const crypto = require('crypto');
const { Store } = require('./../store');

/**
 * 接口说明（v1 只有这一个实现，但契约必须写清楚）：
 *
 *   readJson(rel, fallback)      读 JSON，不存在或损坏时返回 fallback
 *   writeJson(rel, value)        原子写 JSON
 *   readText(rel, fallback)      读纯文本
 *   writeText(rel, text)         原子写纯文本
 *   readBuffer(rel)              读二进制，不存在返回 null
 *   writeBuffer(rel, buffer)     原子写二进制
 *   exists(rel)                  是否存在
 *   remove(rel)                  删除单个文件
 *   removeDir(rel)               删除目录
 *   ensureDir(rel)               建目录
 *   listDir(rel)                 列目录
 *   listFiles(rel, filter)       递归列文件
 *   moveToTrash(rel, name)       移入回收站（不物理删除用户内容）
 *   dirSize(rel)                 统计占用
 *   healthReport()               数据体检结果
 *   generateId(prefix)           生成实体 id
 *
 * 注意：接口里没有任何"绝对路径"概念，一律传相对数据根的路径。
 * 这样 CloudAdapter 才能用同一批相对路径去对象存储里找 key。
 */
class StorageAdapter {
  /* eslint-disable no-unused-vars */
  readJson(rel, fallback) {
    throw new Error('StorageAdapter.readJson 未实现');
  }
  writeJson(rel, value) {
    throw new Error('StorageAdapter.writeJson 未实现');
  }
  readText(rel, fallback) {
    throw new Error('StorageAdapter.readText 未实现');
  }
  writeText(rel, text) {
    throw new Error('StorageAdapter.writeText 未实现');
  }
  readBuffer(rel) {
    throw new Error('StorageAdapter.readBuffer 未实现');
  }
  writeBuffer(rel, buffer) {
    throw new Error('StorageAdapter.writeBuffer 未实现');
  }
  exists(rel) {
    throw new Error('StorageAdapter.exists 未实现');
  }
  remove(rel) {
    throw new Error('StorageAdapter.remove 未实现');
  }
  removeDir(rel) {
    throw new Error('StorageAdapter.removeDir 未实现');
  }
  ensureDir(rel) {
    throw new Error('StorageAdapter.ensureDir 未实现');
  }
  listDir(rel) {
    throw new Error('StorageAdapter.listDir 未实现');
  }
  listFiles(rel, filter) {
    throw new Error('StorageAdapter.listFiles 未实现');
  }
  moveToTrash(rel, name) {
    throw new Error('StorageAdapter.moveToTrash 未实现');
  }
  dirSize(rel) {
    throw new Error('StorageAdapter.dirSize 未实现');
  }
  healthReport() {
    throw new Error('StorageAdapter.healthReport 未实现');
  }
  /* eslint-enable no-unused-vars */

  /** 生成实体 id（默认实现，各适配器可覆盖） */
  generateId(prefix = 'id') {
    return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
  }
}

/**
 * 本机文件系统实现 —— 直接委托给 S0 写好的 Store。
 * 这里**不加任何逻辑**：原子写、.bak、损坏回退都是 Store 的职责，
 * 适配器只负责把"相对路径"这层契约翻译过去。
 */
class LocalFileAdapter extends StorageAdapter {
  constructor(store) {
    super();
    if (!(store instanceof Store)) {
      throw new Error('LocalFileAdapter 需要一个 Store 实例');
    }
    this.store = store;
    /** 适配器名字，设置页"关于"里会显示 */
    this.kind = 'local';
    this.dataDir = store.dataDir;
  }

  readJson(rel, fallback = null) {
    return this.store.readJson(rel, fallback);
  }
  writeJson(rel, value, options) {
    return this.store.writeJson(rel, value, options);
  }
  readText(rel, fallback = null) {
    return this.store.readText(rel, fallback);
  }
  writeText(rel, text, options) {
    return this.store.writeText(rel, text, options);
  }
  readBuffer(rel) {
    return this.store.readBuffer(rel);
  }
  writeBuffer(rel, buffer, options) {
    return this.store.writeBuffer(rel, buffer, options);
  }
  exists(rel) {
    return this.store.exists(rel);
  }
  remove(rel) {
    return this.store.remove(rel);
  }
  removeDir(rel) {
    return this.store.removeDir(rel);
  }
  ensureDir(rel = '') {
    return this.store.ensureDir(rel);
  }
  listDir(rel = '') {
    return this.store.listDir(rel);
  }
  listFiles(rel = '', filter) {
    return this.store.listFiles(rel, filter);
  }
  moveToTrash(rel, name) {
    return this.store.moveToTrash(rel, name);
  }
  emptyTrash() {
    return this.store.emptyTrash();
  }
  dirSize(rel = '') {
    return this.store.dirSize(rel);
  }
  healthReport() {
    return this.store.healthReport();
  }
}

/** 适配器注册表：将来 registerAdapter('cloud', factory) 即可接上云存储 */
const ADAPTERS = new Map([['local', (store) => new LocalFileAdapter(store)]]);

function registerAdapter(kind, factory) {
  ADAPTERS.set(kind, factory);
  return ADAPTERS;
}

function createAdapter(kind, store) {
  const factory = ADAPTERS.get(kind);
  if (!factory) {
    throw new Error(`没有名为 ${kind} 的存储适配器`);
  }
  return factory(store);
}

module.exports = {
  StorageAdapter,
  LocalFileAdapter,
  ADAPTERS,
  registerAdapter,
  createAdapter,
};
