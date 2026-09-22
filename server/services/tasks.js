'use strict';
/**
 * tasks.js —— 长任务登记表。
 *
 * 为什么需要：
 * PRD §4.0 规定"长任务（抓取、导入、备份）返回 task_id，通过 GET /api/tasks/:id 轮询进度"。
 * 抓取、导入、备份三块都要用同一套进度轮询，所以把"任务"这个概念抽成一个公共服务，
 * 避免三处各写一遍、字段名还对不上。
 *
 * 为什么放内存：
 * 任务本身是"这一次运行的临时状态"，不是用户数据；真正要保住的是已经落盘的章节
 * （断点续抓靠的是磁盘上已完成的章节文件，而不是任务对象）。所以重启后任务列表清空是对的，
 * 也避免把易失的进度写进 data/ 污染唯一真相源。
 */

const crypto = require('crypto');

/** 任务终态 */
const TERMINAL_STATUS = new Set(['done', 'failed', 'cancelled']);

function createTasksService(ctx) {
  /** id -> task */
  const tasks = new Map();
  /** 只保留最近 N 个终态任务，避免长时间运行内存无限涨 */
  const KEEP_FINISHED = 50;

  function prune() {
    const finished = [...tasks.values()]
      .filter((t) => TERMINAL_STATUS.has(t.status))
      .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    while (finished.length > KEEP_FINISHED) {
      const victim = finished.shift();
      tasks.delete(victim.id);
    }
  }

  function snapshot(task) {
    if (!task) return null;
    return JSON.parse(JSON.stringify(task));
  }

  return {
    /**
     * 新建任务
     * @param {{type:string,title:string,total?:number,payload?:Object}} init
     */
    create(init) {
      const id = 't_' + crypto.randomBytes(6).toString('hex');
      const task = {
        id,
        type: init.type,
        title: init.title || '任务',
        status: 'pending',
        /** 三色进度：已抓 / 待抓 / 失败（PRD 模块 2） */
        progress: {
          done: 0,
          failed: 0,
          total: Number(init.total) || 0,
        },
        message: '',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        error: null,
        report: null,
        payload: init.payload || {},
      };
      tasks.set(id, task);
      return snapshot(task);
    },

    get(id) {
      return snapshot(tasks.get(id));
    },

    has(id) {
      return tasks.has(id);
    },

    list() {
      return [...tasks.values()]
        .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
        .map(snapshot);
    },

    /** 打补丁；progress 做"合并"而不是整体替换，调用方只报增量就行 */
    update(id, patch = {}) {
      const task = tasks.get(id);
      if (!task) return null;
      if (patch.progress) {
        task.progress = { ...task.progress, ...patch.progress };
      }
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'progress') continue;
        task[key] = value;
      }
      if (TERMINAL_STATUS.has(task.status) && !task.finishedAt) {
        task.finishedAt = new Date().toISOString();
      }
      if (TERMINAL_STATUS.has(task.status)) prune();
      return snapshot(task);
    },

    /** 累加式更新进度，抓取循环里最常用 */
    bump(id, { done = 0, failed = 0, total } = {}) {
      const task = tasks.get(id);
      if (!task) return null;
      task.progress.done += done;
      task.progress.failed += failed;
      if (typeof total === 'number') task.progress.total = total;
      return snapshot(task);
    },

    finish(id, patch = {}) {
      return this.update(id, { ...patch, status: patch.status || 'done' });
    },

    fail(id, error, patch = {}) {
      const message =
        error && error.message ? error.message : typeof error === 'string' ? error : '任务失败了';
      return this.update(id, {
        ...patch,
        status: 'failed',
        error: {
          code: (error && error.code) || 'TASK_FAILED',
          message,
          hint: (error && error.hint) || '可以稍后重试，已经成功抓到的部分不会丢。',
        },
      });
    },

    /** 计算已用时 / 预计剩余（前端进度条要用） */
    timing(id) {
      const task = tasks.get(id);
      if (!task) return null;
      const started = new Date(task.startedAt).getTime();
      const end = task.finishedAt ? new Date(task.finishedAt).getTime() : Date.now();
      const elapsedMs = Math.max(0, end - started);
      const total = task.progress.total || 0;
      const done = task.progress.done + task.progress.failed;
      let etaMs = null;
      if (total > 0 && done > 0 && done < total) {
        etaMs = Math.round((elapsedMs / done) * (total - done));
      }
      return { elapsedMs, etaMs };
    },

    remove(id) {
      return tasks.delete(id);
    },

    clear() {
      tasks.clear();
    },
  };
}

module.exports = createTasksService;
module.exports.TERMINAL_STATUS = TERMINAL_STATUS;
