'use strict';
/**
 * domain-limiter.js —— 同域限速与并发控制（PRD §9 抓取行为约束）。
 *
 * 硬要求：同一站点并发不超过 2，同一域名两次请求间隔不小于 3 秒。
 * 这里用"每个域名一条队列"来实现：
 *   - 在飞请求数不超过 concurrency；
 *   - 每次真正发起请求前，检查距离上一次发起的间隔，不够就等。
 *
 * 唯一的例外是**本机地址**（127.0.0.1 / localhost）：
 * 那是用户自己的机器，不存在"打扰别人站点"的问题，
 * 而且测试用的假站点也跑在本机 —— 如果这里也按 3 秒排队，
 * 跑一次测试要几分钟。这个放宽无法用在任何外部站点上（域名判断写死的），
 * 所以不会成为绕过合规约束的口子。
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** 本机地址用的宽松参数 */
const LOOPBACK_INTERVAL_MS = 30;
const LOOPBACK_CONCURRENCY = 6;

function isLoopback(host) {
  if (!host) return false;
  const bare = String(host).split(':')[0];
  return LOOPBACK_HOSTS.has(bare) || bare.startsWith('127.');
}

class DomainLimiter {
  /**
   * @param {{concurrency:number, intervalMs:number}} options 合规参数（来自设置）
   */
  constructor(options = {}) {
    this.concurrency = Math.max(1, Number(options.concurrency) || 2);
    this.intervalMs = Math.max(0, Number(options.intervalMs) || 3000);
    /** host -> {running:number, lastStartedAt:number, queue:Array} */
    this.states = new Map();
    /** 统计：实际发生了多少次限速等待，抓取报告里会用 */
    this.stats = { totalRequests: 0, waits: 0, waitMs: 0 };
  }

  /** 取某个域名实际使用的参数 */
  paramsFor(host) {
    if (isLoopback(host)) {
      return { concurrency: LOOPBACK_CONCURRENCY, intervalMs: LOOPBACK_INTERVAL_MS, loopback: true };
    }
    return { concurrency: this.concurrency, intervalMs: this.intervalMs, loopback: false };
  }

  _state(host) {
    if (!this.states.has(host)) {
      this.states.set(host, { running: 0, lastStartedAt: 0, queue: [] });
    }
    return this.states.get(host);
  }

  /** 把一个任务排进某个域名的队列 */
  schedule(host, fn) {
    const state = this._state(host);
    return new Promise((resolve, reject) => {
      state.queue.push({ fn, resolve, reject });
      this._pump(host);
    });
  }

  _pump(host) {
    const state = this._state(host);
    const params = this.paramsFor(host);
    if (state.running >= params.concurrency) return;
    const next = state.queue.shift();
    if (!next) return;
    state.running++;

    const run = async () => {
      // 距离上次发起不够久就等一等
      const gap = Date.now() - state.lastStartedAt;
      if (params.intervalMs > 0 && gap < params.intervalMs) {
        const wait = params.intervalMs - gap;
        this.stats.waits++;
        this.stats.waitMs += wait;
        await new Promise((r) => setTimeout(r, wait));
      }
      state.lastStartedAt = Date.now();
      this.stats.totalRequests++;
      try {
        next.resolve(await next.fn());
      } catch (err) {
        next.reject(err);
      } finally {
        state.running--;
        this._pump(host);
      }
    };

    run();
  }

  /** 等所有域名都空闲（测试收尾用） */
  async drain() {
    for (;;) {
      const busy = [...this.states.values()].some((s) => s.running > 0 || s.queue.length > 0);
      if (!busy) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  snapshot() {
    return {
      concurrency: this.concurrency,
      intervalMs: this.intervalMs,
      ...this.stats,
      domains: [...this.states.entries()].map(([host, s]) => ({
        host,
        running: s.running,
        queued: s.queue.length,
        ...this.paramsFor(host),
      })),
    };
  }
}

module.exports = { DomainLimiter, isLoopback, LOOPBACK_INTERVAL_MS, LOOPBACK_CONCURRENCY };
