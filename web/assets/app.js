/**
 * app.js —— 单页应用入口。
 *
 * 职责只有四件：
 *   1. 拉一次 /api/health，把"数据体检问题"和版本信息展示出来（有问题必须让用户看见，PRD §6.2）；
 *   2. 装配路由（具体视图在 views/index.js 里注册）；
 *   3. 处理顶栏的搜索框与「加书」按钮；
 *   4. 兜住所有未捕获异常，转成中文提示而不是让它变成白屏。
 */

import { api } from './api.js';
import { router } from './router.js';
import { toast, toastError } from './ui.js';
import { registerViews } from './views/index.js';

/** 全局运行信息，各视图共享（避免每个视图都再拉一次 /api/health） */
export const appState = {
  health: null,
  version: '',
  dataDir: '',
};

async function loadHealth() {
  try {
    const health = await api.get('/api/health');
    appState.health = health;
    appState.version = health.version;
    appState.dataDir = health.dataDir;
    renderHealthBanner(health);
  } catch (err) {
    // 服务没起来时会走到这里：给一条能指导下一步的提示，而不是白屏
    toastError(err);
  }
}

function renderHealthBanner(health) {
  const banner = document.getElementById('healthBanner');
  if (!banner) return;
  const issues = (health && health.health && health.health.issues) || [];
  if (!issues.length) {
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = '';
  const title = document.createElement('strong');
  title.textContent = '数据检查发现异常：';
  banner.appendChild(title);
  const ul = document.createElement('ul');
  for (const issue of issues) {
    const li = document.createElement('li');
    li.textContent = issue.message;
    ul.appendChild(li);
  }
  banner.appendChild(ul);
}

function wireTopbar() {
  const input = document.getElementById('quickSearch');
  if (input) {
    // 书名即时搜索走路由参数，具体过滤在书架视图里做（PRD §3：本地匹配，输入即过滤）
    input.addEventListener('input', () => {
      const keyword = input.value.trim();
      if (router.current && router.current.path !== '/shelf') router.go('/shelf');
      window.dispatchEvent(new CustomEvent('shelf:filter', { detail: keyword }));
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        router.go('/search?q=' + encodeURIComponent(input.value.trim()));
      }
    });
  }

  const addBtn = document.getElementById('btnAddBook');
  if (addBtn) {
    addBtn.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent('addbook:open'));
    });
  }
}

function main() {
  window.addEventListener('error', (event) => {
    console.error(event.error || event.message);
    toast('界面出了点小问题，请刷新页面重试。', 'error', 5000);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    if (reason && reason.message) toastError(reason);
    else toast('有一个操作没能完成，请重试。', 'error', 5000);
    event.preventDefault();
  });

  wireTopbar();
  registerViews(router);
  router.start();
  loadHealth();
  // 暴露给调试用：用户可以让开发者打开控制台看这个对象
  window.__novelTool = { router, appState };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main);
} else {
  main();
}
