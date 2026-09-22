'use strict';
/**
 * routes/fetch.js —— 模块 2「抓取控制台」的接口。
 *
 * 接口清单（PRD 模块 2）：
 *   POST /api/fetch/compliance?url=      前置合规自检（也支持 POST）
 *   POST /api/fetch/probe                探测目录页结构
 *   POST /api/fetch/probe/manual         提交手动点选的选择器后重新探测
 *   POST /api/fetch/candidates           列出候选目录区 / 正文区（手动点选的数据源）
 *   POST /api/fetch/probe/preview        试抓前 3 章正文供确认
 *   POST /api/fetch/tasks                创建整本抓取任务，返回 task_id
 *   GET  /api/fetch/tasks/:id            三色进度 + 已用时 + 预计剩余
 *   POST /api/fetch/tasks/:id/pause|resume|cancel
 *   POST /api/fetch/tasks/:id/retry      单章重试 / 重试全部失败章
 *   GET  /api/fetch/tasks/:id/report     抓取报告
 *
 * 追更相关（schedule / status / check）属于 S9，在 scheduler 模块里注册。
 */

const { ApiError } = require('../lib/errors');

module.exports = {
  mount(router, ctx) {
    const { fetcher, tasks } = ctx;

    const readUrl = async (c) => {
      if (c.method === 'GET') return c.q('url') || '';
      const body = await c.json();
      return (body && body.url) || '';
    };

    const requireUrl = (url) => {
      if (!url) {
        throw new ApiError('NO_URL', '还没有填目录页地址。', '请把小说目录页的网址粘进来。', 400);
      }
      return url;
    };

    // ------------------------------------------------------------ 合规自检

    router.get('/api/fetch/compliance', async (c) => fetcher.inspectCompliance(requireUrl(c.q('url'))));

    router.post('/api/fetch/compliance', async (c) => {
      const body = await c.json();
      return fetcher.inspectCompliance(requireUrl(body.url), {
        fetchPage: body.fetch_page !== false,
      });
    });

    // ------------------------------------------------------------ 探测

    router.post('/api/fetch/probe', async (c) => {
      const body = await c.json();
      const url = requireUrl(body.url);

      // 先过合规：不合规就不去探测，省得白跑一趟
      const check = body.skip_compliance ? null : await fetcher.inspectCompliance(url);
      if (check && !check.allowed) {
        throw new ApiError('COMPLIANCE_REJECTED', check.message, check.hint, 403);
      }

      const result = await fetcher.probe(url, {
        tocSelector: body.toc_selector,
        contentSelector: body.content_selector,
        linkSelector: body.link_selector,
      });
      return { ...result, compliance: check };
    });

    router.post('/api/fetch/probe/manual', async (c) => {
      const body = await c.json();
      const url = requireUrl(body.url);
      if (!body.toc_selector && !body.content_selector) {
        throw new ApiError(
          'NO_SELECTOR',
          '手动修复要至少指定目录区或正文区。',
          '请先从候选里点一个区块，再重新探测。',
          400
        );
      }
      return fetcher.probe(url, {
        tocSelector: body.toc_selector,
        contentSelector: body.content_selector,
        linkSelector: body.link_selector,
      });
    });

    router.post('/api/fetch/candidates', async (c) => {
      const body = await c.json();
      return fetcher.candidates(requireUrl(body.url), { chapter_url: body.chapter_url });
    });

    router.post('/api/fetch/probe/preview', async (c) => {
      const body = await c.json();
      if (!body.probe || !body.probe.ok) {
        throw new ApiError(
          'NEED_PROBE_FIRST',
          '还没有探测结果，不能试抓。',
          '请先做一次结构探测并确认结果。',
          400
        );
      }
      const chapters = await fetcher.previewChapters(body.probe, Number(body.count) || 3);
      return {
        chapters,
        count: chapters.length,
        note: '这是前几章试抓的结果。确认正文干净、没有夹带导航和广告，就可以开始整本抓取。',
      };
    });

    // ------------------------------------------------------------ 任务

    router.post('/api/fetch/tasks', async (c) => {
      const body = await c.json();
      return fetcher.startFetchTask(body);
    });

    router.get('/api/fetch/tasks', () => tasks.list());

    router.get('/api/fetch/tasks/:id', (c) => {
      const task = tasks.get(c.params.id);
      if (!task) {
        throw new ApiError(
          'TASK_NOT_FOUND',
          '找不到这个抓取任务了。',
          '服务重启过的话任务记录会清空，但已经抓到的章节都还在，可以重新发起一次抓取。',
          404
        );
      }
      return { ...task, timing: tasks.timing(c.params.id) };
    });

    for (const action of ['pause', 'resume', 'cancel']) {
      router.post(`/api/fetch/tasks/:id/${action}`, (c) => fetcher[action](c.params.id));
    }

    router.post('/api/fetch/tasks/:id/retry', async (c) => {
      const body = await c.json();
      return fetcher.retry(c.params.id, body);
    });

    router.get('/api/fetch/tasks/:id/report', (c) => fetcher.getReport(c.params.id));
  },
};
