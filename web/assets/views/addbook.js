/**
 * addbook.js —— 「加书」弹层（PRD §3：点开有三个页签）。
 *
 * 三个页签分别对应内容进来的三条路：
 *   贴链接抓取 → 抓取控制台（模块 2）
 *   传文件导入 → 导入页的选择文件（模块 7）
 *   粘贴正文   → 导入页的粘贴框（模块 7）
 *
 * 为什么用弹层而不是直接跳三个页面：
 * 加书是最高频的动作，先在原地把"你要走哪条路"问清楚，比跳到一个页面再让用户自己找入口快得多。
 */

import { openOverlay, esc } from '../ui.js';

const CHOICES = [
  {
    id: 'link',
    title: '贴链接抓取',
    desc: '把小说目录页的网址粘进来，工具自己整本抓下来，之后还能定时检查更新。',
    action: '去抓取控制台',
    hash: '/fetch',
    icon: '链',
  },
  {
    id: 'file',
    title: '传文件导入',
    desc: '把电脑上的 TXT 拖进来或选进来，工具会自动识别编码、乱码一键还原、自动分章。',
    action: '选择文件',
    hash: '/import?mode=file',
    icon: '文',
  },
  {
    id: 'paste',
    title: '粘贴正文',
    desc: '从网页或别的地方复制正文，直接粘进来，同样会自动分章入库。',
    action: '去粘贴',
    hash: '/import?mode=paste',
    icon: '贴',
  },
];

/** 打开加书弹层；onPick 由调用方决定跳转方式（默认改哈希路由） */
export function openAddBookDialog(onPick) {
  const { panel, close } = openOverlay();
  panel.classList.add('addbook-panel');
  panel.innerHTML = `
    <h2 class="addbook-title">加一本书</h2>
    <p class="addbook-sub">内容可以走三条路进来，选一条就行。</p>
    <div class="addbook-grid">
      ${CHOICES.map(
        (c) => `
        <button class="addbook-card" type="button" data-id="${c.id}">
          <span class="addbook-icon">${esc(c.icon)}</span>
          <span class="addbook-card-title">${esc(c.title)}</span>
          <span class="addbook-card-desc">${esc(c.desc)}</span>
          <span class="addbook-card-action">${esc(c.action)} →</span>
        </button>`
      ).join('')}
    </div>
    <div class="dialog-actions">
      <button class="btn" type="button" data-act="cancel">取消</button>
    </div>`;
  panel.querySelector('[data-act="cancel"]').onclick = () => close();
  for (const button of panel.querySelectorAll('.addbook-card')) {
    button.onclick = () => {
      const choice = CHOICES.find((c) => c.id === button.dataset.id);
      close();
      if (onPick) onPick(choice);
    };
  }
}

/** 空书架时用的三张引导卡（PRD §3：三张卡片分别介绍三条加书路径） */
export function emptyGuideHtml() {
  return `
    <div class="empty-guide">
      <h2>书架还是空的</h2>
      <p class="empty-guide-sub">内容可以走三条路进来，点哪张就走哪条。</p>
      <div class="addbook-grid">
        ${CHOICES.map(
          (c) => `
          <button class="addbook-card" type="button" data-guide="${c.id}">
            <span class="addbook-icon">${esc(c.icon)}</span>
            <span class="addbook-card-title">${esc(c.title)}</span>
            <span class="addbook-card-desc">${esc(c.desc)}</span>
            <span class="addbook-card-action">${esc(c.action)} →</span>
          </button>`
        ).join('')}
      </div>
    </div>`;
}

/** 把空书架引导卡上的点击接上路由 */
export function wireEmptyGuide(container, onPick) {
  for (const button of container.querySelectorAll('[data-guide]')) {
    button.onclick = () => {
      const choice = CHOICES.find((c) => c.id === button.dataset.guide);
      if (onPick) onPick(choice);
    };
  }
}

export { CHOICES };
