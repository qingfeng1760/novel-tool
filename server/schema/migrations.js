'use strict';
/**
 * migrations.js —— 数据格式迁移骨架（PRD §7 预留项，v1 空实现）。
 *
 * 为什么 v1 就要有：
 * 将来只要动过一次数据结构（比如把 char_offset 换成 location 对象），
 * 老用户的 data/ 就必须能升上来。提前把入口、版本号、失败话术定好，
 * 到时候只是往 MIGRATIONS 里加一条，而不是临时设计一套机制。
 *
 * v1 的 migrate 行为：版本相同直接返回；需要跨版本升级但还没有对应的迁移步骤时，
 * 明确报"这个数据是更新版本写的"，绝不做破坏性猜测。
 */

const { SCHEMA_VERSION } = require('../lib/constants');
const { ApiError } = require('../lib/errors');

/**
 * 迁移步骤表。
 * 每项形如 { from: 1, to: 2, run(data, ctx) {...} }，按 from 升序依次执行。
 * v1 只有 1.0，所以这里是空的 —— 但结构定死了。
 */
const MIGRATIONS = [];

/** 取数据里记录的 schema 版本，取不到就当 1 */
function detectVersion(data) {
  if (!data || typeof data !== 'object') return SCHEMA_VERSION;
  const v = Number(data.schemaVersion);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * 把数据从一个 schema 版本迁到另一个版本。
 * @param {*} data 原始数据（对象）
 * @param {number} fromVersion
 * @param {number} toVersion
 * @returns {*} 迁移后的数据（v1 原样返回）
 */
function migrate(data, fromVersion, toVersion = SCHEMA_VERSION) {
  const from = Number(fromVersion) || detectVersion(data);
  const to = Number(toVersion) || SCHEMA_VERSION;

  if (from === to) return data;

  if (from > to) {
    // 用更新版本的工具打开老数据，比"降级"更常见的是用户装回了旧版本
    throw new ApiError(
      'SCHEMA_TOO_NEW',
      `这份数据是更新版本的工具写的（版本 ${from}），当前工具只认到版本 ${to}。`,
      '请更新到最新版本的小说工具再打开；你的数据没有被改动。',
      409
    );
  }

  let current = data;
  let version = from;
  while (version < to) {
    const step = MIGRATIONS.find((m) => m.from === version);
    if (!step) {
      throw new ApiError(
        'MIGRATION_MISSING',
        `缺少从版本 ${version} 升级到 ${version + 1} 的处理办法。`,
        '请先备份 data 目录，然后联系开发者；你的数据没有被改动。',
        500
      );
    }
    current = step.run(current);
    version = step.to;
  }

  if (current && typeof current === 'object') {
    current.schemaVersion = version;
  }
  return current;
}

module.exports = { MIGRATIONS, migrate, detectVersion, CURRENT_VERSION: SCHEMA_VERSION };
