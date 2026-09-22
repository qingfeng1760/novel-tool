'use strict';
/**
 * constants.js —— 全局常量。
 *
 * 单独放一个文件的原因：SCHEMA_VERSION 同时被 context（装配）和 settings（数据文件）用到，
 * 如果放在 paths.js 里会造成"装配层 ↔ 服务层"的循环引用，
 * 拆成零依赖的常量模块最干净。
 */

/** 数据 schema 版本：所有落盘实体都带这个字段，将来做迁移时靠它判断 */
const SCHEMA_VERSION = 1;

/** v1 恒为 local —— 预留同步能力时用（PRD §7） */
const SYNC_STATE_LOCAL = 'local';

/** v1 只有本机一个"用户"（PRD §7 预留 owner_id） */
const DEFAULT_OWNER_ID = 'local';

/** 书籍状态枚举 */
const BOOK_STATUS = {
  READING: '在读',
  FOLLOWING: '追更中',
  FINISHED: '已读完',
  UNREAD: '未读',
};

/** 抓取状态枚举 */
const FETCH_STATUS = {
  NONE: '未抓',
  RUNNING: '抓取中',
  PARTIAL: '部分失败',
  DONE: '完成',
};

module.exports = {
  SCHEMA_VERSION,
  SYNC_STATE_LOCAL,
  DEFAULT_OWNER_ID,
  BOOK_STATUS,
  FETCH_STATUS,
};
