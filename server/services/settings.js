'use strict';
/**
 * settings.js —— 全局设置读写（data/settings.json）。
 *
 * 为什么把默认值写死在代码里：
 * 硬约束与 §9 要求"抓取参数默认值必须合规且安全，且不得被调低到违反合规要求"。
 * 所以合规相关的下限（同域间隔 ≥3 秒、并发 ≤2）是代码级 clamp，
 * 而不是界面上的一个提示——用户改不进去，就不会因为手滑把自己送进违规区。
 *
 * 预留：设置对象带 schemaVersion / updatedAt / syncState / owner_id，
 * 将来接云同步时字段已经在了，不用改结构（PRD §7）。
 */

const { SCHEMA_VERSION, SYNC_STATE_LOCAL, DEFAULT_OWNER_ID } = require('../lib/constants');

/** 合规硬下限，任何设置入口都不得突破 */
const COMPLIANCE_LIMITS = {
  /** 同一站点并发上限（PRD §9：不超过 2） */
  maxConcurrency: 2,
  /** 同域两次请求最小间隔（PRD §9：不小于 3 秒） */
  minDomainIntervalMs: 3000,
};

const DEFAULT_SETTINGS = {
  schemaVersion: SCHEMA_VERSION,
  syncState: 'local',
  owner_id: 'local',
  updatedAt: null,

  /** 服务相关 */
  server: {
    port: 8618,
  },

  /** 抓取参数（二级设置，默认合规安全） */
  fetch: {
    concurrency: 2,
    domainIntervalMs: 3000,
    retryMax: 3,
    /** 断网/被拒时是否允许追更自动检查 */
    autoCheckUpdates: true,
    /** 是否保存抓取来源页快照（仅调试用，默认关） */
    saveSourceSnapshot: false,
  },

  /** 导入相关 */
  import: {
    /** 正文清洗开关，PRD 模块 7 要求默认关闭 */
    cleanEnabled: false,
    /** 默认分章规则 id */
    defaultRule: 'default',
  },

  /** 阅读偏好（模块 5，全局保存，换书不用重设） */
  reader: {
    fontSize: 19,
    lineHeight: 1.9,
    /** serif | sans | mono */
    fontFamily: 'serif',
    /** 版心宽度，单位 px */
    contentWidth: 760,
    /** 首行缩进字数 */
    indent: 2,
    /** day | night | eye */
    theme: 'day',
    /** scroll | page */
    mode: 'scroll',
    /** 阅读区留白（沉浸模式会临时隐藏） */
    showHeader: true,
  },

  /** 书架相关 */
  library: {
    /** 移除的书在 .trash 里的保留天数，null = 永久保留（更安全） */
    trashRetentionDays: null,
  },
};

/** 深合并，但只合并普通对象；数组直接替换 */
function deepMerge(base, patch) {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(patch) || typeof patch !== 'object') return patch;
  const out = Array.isArray(base) || typeof base !== 'object' || base === null ? {} : { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value);
  }
  return out;
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * 合规化抓取参数。
 * @returns {{value:Object, warnings:string[]}} warnings 是要在界面上显示的改动说明
 */
function sanitizeFetchSettings(input, current) {
  const warnings = [];
  const base = { ...DEFAULT_SETTINGS.fetch, ...(current || {}), ...(input || {}) };

  const concurrency = Math.round(clamp(base.concurrency, 1, COMPLIANCE_LIMITS.maxConcurrency));
  if (Number(base.concurrency) > COMPLIANCE_LIMITS.maxConcurrency) {
    warnings.push(
      `同一站点并发最多 ${COMPLIANCE_LIMITS.maxConcurrency} 个，已按合规要求改为 ${concurrency}。`
    );
  }
  if (Number(base.concurrency) < 1) {
    warnings.push('并发数至少要 1 个，已改为 1。');
  }

  let domainIntervalMs = Math.round(Number(base.domainIntervalMs));
  if (!Number.isFinite(domainIntervalMs) || domainIntervalMs < COMPLIANCE_LIMITS.minDomainIntervalMs) {
    if (Number.isFinite(domainIntervalMs) && domainIntervalMs !== 0) {
      warnings.push(
        `同域请求间隔不能小于 ${COMPLIANCE_LIMITS.minDomainIntervalMs / 1000} 秒，已按合规要求改回 ${COMPLIANCE_LIMITS.minDomainIntervalMs} 毫秒。`
      );
    }
    domainIntervalMs = COMPLIANCE_LIMITS.minDomainIntervalMs;
  }

  const retryMax = Math.round(clamp(base.retryMax, 1, 10));
  if (Number(base.retryMax) > 10) warnings.push('重试次数上限是 10 次，已改为 10。');

  return {
    value: {
      concurrency,
      domainIntervalMs,
      retryMax,
      autoCheckUpdates: base.autoCheckUpdates !== false,
      saveSourceSnapshot: base.saveSourceSnapshot === true,
    },
    warnings,
  };
}

module.exports = function createSettingsService(ctx) {
  const FILE = 'settings.json';

  function read() {
    const raw = ctx.store.readJson(FILE, null);
    const merged = deepMerge(DEFAULT_SETTINGS, raw || {});
    // 读的时候也要过一遍合规：手改过 settings.json 的人也不能绕过下限
    merged.fetch = sanitizeFetchSettings(merged.fetch, null).value;
    merged.schemaVersion = merged.schemaVersion || SCHEMA_VERSION;
    merged.syncState = 'local';
    merged.owner_id = merged.owner_id || 'local';
    return merged;
  }

  function write(next) {
    const payload = { ...next, updatedAt: new Date().toISOString() };
    ctx.store.writeJson(FILE, payload);
    return payload;
  }

  return {
    COMPLIANCE_LIMITS,
    DEFAULTS: DEFAULT_SETTINGS,
    /** 合规夹取函数：路由层读设置时也要用它，保证手改 settings.json 也绕不过去 */
    sanitizeFetchSettings,

    /** 取全部设置 */
    get() {
      return read();
    },

    /** 按 patch 深合并写入；与合规冲突的值会被夹回并返回 warnings */
    patch(patch) {
      const current = read();
      const next = deepMerge(current, patch || {});
      const warnings = [];

      const sanitized = sanitizeFetchSettings(next.fetch, current.fetch);
      next.fetch = sanitized.value;
      warnings.push(...sanitized.warnings);

      next.schemaVersion = next.schemaVersion || SCHEMA_VERSION;
      next.syncState = 'local';
      next.owner_id = next.owner_id || 'local';

      return { settings: write(next), warnings };
    },

    /** 只读 / 只写阅读偏好（模块 5 用） */
    getReader() {
      return read().reader;
    },

    putReader(patch) {
      const current = read();
      const reader = deepMerge(current.reader, patch || {});
      // 数值参数做一次范围夹取，避免界面滑杆传进来离谱的值把版面撑爆
      reader.fontSize = clamp(reader.fontSize, 12, 40);
      reader.lineHeight = clamp(reader.lineHeight, 1.2, 3);
      reader.contentWidth = clamp(reader.contentWidth, 420, 1400);
      reader.indent = clamp(reader.indent, 0, 4);
      if (!['serif', 'sans', 'mono', 'system'].includes(reader.fontFamily)) reader.fontFamily = 'serif';
      if (!['day', 'night', 'eye'].includes(reader.theme)) reader.theme = 'day';
      if (!['scroll', 'page'].includes(reader.mode)) reader.mode = 'scroll';
      write({ ...current, reader });
      return reader;
    },

    getFetch() {
      return read().fetch;
    },

    putFetch(patch) {
      const current = read();
      const sanitized = sanitizeFetchSettings(patch, current.fetch);
      write({ ...current, fetch: sanitized.value });
      return { fetch: sanitized.value, warnings: sanitized.warnings };
    },
  };
};

module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.COMPLIANCE_LIMITS = COMPLIANCE_LIMITS;
module.exports.sanitizeFetchSettings = sanitizeFetchSettings;
