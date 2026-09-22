// ==UserScript==
// @name         小说工具
// @namespace    local.novel-tool
// @version      1.0.0
// @description  把正在看的小说章节（或整本）存进本机的「小说工具」。数据只在你自己的电脑上，不上传任何地方。
// @author       本机小说工具
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

/* 小说工具 · 浏览器脚本（模块 3）
 *
 * 场景是"随手存，不打断"，所以设计上只做三件事：
 *   1. 在页面右下角放一个不挡住正文的小浮窗，只有三个按钮；
 *   2. 抓之前先说清楚"将追加到《XXX》的第 N 章"，避免存错地方；
 *   3. 本地服务没启动时把内容暂存在浏览器里，服务一起来自动补交。
 *
 * 只跟 127.0.0.1 上的本机服务通信（用 GM_xmlhttpRequest 绕开跨域限制），
 * 不往任何别的地方发数据。
 */

(function () {
  'use strict';

  const BASE = 'http://127.0.0.1:8618'; // 端口被占用时服务会顺延，脚本会自动试探
  const PORT_TRIES = 6;
  const QUEUE_KEY = 'novel-tool-queue';
  const HIDDEN_KEY = 'novel-tool-hidden';
  const PENDING_MAX = 200;

  /** 常见正文容器，按经验从准到不准排列 */
  const CONTENT_SELECTORS = [
    '#content',
    '#chaptercontent',
    '#chapterContent',
    '#booktext',
    '#htmlContent',
    '#nr1',
    '#nr',
    '.content',
    '.chapter-content',
    '.read-content',
    '.showtxt',
    '.yd_text2',
    'article',
    '.article-content',
  ];

  /** 常见章节标题容器 */
  const TITLE_SELECTORS = ['h1', '.bookname h1', '.chapter-title', '#chapter-title', '.title', '.j_chapterName'];

  let baseUrl = BASE;
  let online = false;
  let resolved = null;
  let busy = false;
  let panel = null;
  let statusEl = null;
  let progressEl = null;

  // ---------------------------------------------------------------- 本地存储

  function readValue(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') {
        const value = GM_getValue(key, undefined);
        if (value !== undefined) return value;
      }
    } catch (err) {
      /* 落到 localStorage */
    }
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  }

  function writeValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (err) {
      /* 落到 localStorage */
    }
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* 存不下就算了 */
    }
  }

  function readQueue() {
    const queue = readValue(QUEUE_KEY, []);
    return Array.isArray(queue) ? queue : [];
  }

  function writeQueue(queue) {
    writeValue(QUEUE_KEY, queue.slice(-PENDING_MAX));
  }

  function enqueue(item) {
    const queue = readQueue();
    queue.push({ ...item, queued_at: new Date().toISOString() });
    writeQueue(queue);
    return queue.length;
  }

  // ---------------------------------------------------------------- 与服务通信

  function request(method, path, body, timeout) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const done = (text, status) => {
        let parsed = null;
        try {
          parsed = JSON.parse(text);
        } catch (err) {
          parsed = null;
        }
        if (!parsed) {
          reject(new Error(status >= 400 ? `本机服务返回了 ${status}` : '本机服务返回了看不懂的内容'));
          return;
        }
        if (parsed.ok === true) resolve(parsed.data);
        else if (parsed.ok === false && parsed.error) {
          const error = new Error(parsed.error.message || '这一步没能完成');
          error.hint = parsed.error.hint;
          error.code = parsed.error.code;
          reject(error);
        } else {
          reject(new Error('本机服务返回了看不懂的内容'));
        }
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method,
          url: baseUrl + path,
          headers: payload ? { 'Content-Type': 'application/json' } : {},
          data: payload,
          timeout: timeout || 15000,
          onload: (res) => done(res.responseText, res.status),
          onerror: () => reject(new Error('OFFLINE')),
          ontimeout: () => reject(new Error('TIMEOUT')),
        });
        return;
      }

      fetch(baseUrl + path, {
        method,
        headers: payload ? { 'Content-Type': 'application/json' } : {},
        body: payload,
      })
        .then(async (res) => done(await res.text(), res.status))
        .catch(() => reject(new Error('OFFLINE')));
    });
  }

  /** 服务端口可能顺延（8618 被占用），所以逐个试一遍 */
  async function detectService() {
    for (let i = 0; i < PORT_TRIES; i++) {
      baseUrl = `http://127.0.0.1:${8618 + i}`;
      try {
        // eslint-disable-next-line no-await-in-loop
        const info = await request('GET', '/api/userscript/ping', undefined, 2500);
        online = Boolean(info && info.online);
        if (online) {
          setStatus(`本机工具在线（v${info.version}）`, 'ok');
          return true;
        }
      } catch (err) {
        /* 试下一个端口 */
      }
    }
    online = false;
    setStatus('请先双击启动.bat', 'warn');
    return false;
  }

  // ---------------------------------------------------------------- 页面解析

  function guessBookTitle() {
    // 页面上常见的书名容器
    const node = document.querySelector('[class*=bookname] h1, .book-name, #info h1, .book_title, [itemprop=name]');
    if (node && node.textContent.trim()) return node.textContent.trim();

    const raw = document.title || '';
    const parts = raw.split(/[_\-|]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length >= 2) return parts[0];
    return raw.replace(/[（(][^）)]*[）)]/g, '').trim();
  }

  function guessAuthor() {
    const node = document.querySelector('[class*=author], #info p');
    if (node) {
      const hit = /作者[：:]\s*([^\s|]{1,20})/.exec(node.textContent);
      if (hit) return hit[1].trim();
    }
    const hit = /作者[：:]\s*([^\s<|]{1,20})/.exec((document.body ? document.body.textContent : '').slice(0, 4000));
    return hit ? hit[1].trim() : '';
  }

  function guessChapterTitle() {
    for (const selector of TITLE_SELECTORS) {
      const node = document.querySelector(selector);
      if (node && node.textContent.trim() && node.textContent.trim().length <= 60) {
        return node.textContent.trim();
      }
    }
    const raw = document.title || '';
    const first = raw.split(/[_\-|]/)[0].trim();
    return first || '未命名章节';
  }

  /** 取出这一页的正文纯文本 */
  function extractContent() {
    let best = null;
    for (const selector of CONTENT_SELECTORS) {
      const node = document.querySelector(selector);
      if (!node) continue;
      const text = node.innerText || node.textContent || '';
      if (text.replace(/\s/g, '').length >= 200) {
        best = node;
        break;
      }
      if (!best && text.replace(/\s/g, '').length >= 80) best = node;
    }

    if (!best) {
      // 结构不认识：找页面上文字最长的块（排除掉导航、脚本、样式）
      let longest = null;
      let longestLength = 0;
      for (const node of document.querySelectorAll('div, article, section, td')) {
        const text = node.innerText || '';
        const length = text.replace(/\s/g, '').length;
        if (length <= longestLength) continue;
        const linkText = Array.from(node.querySelectorAll('a')).reduce((sum, a) => sum + a.textContent.length, 0);
        if (linkText / Math.max(1, text.length) > 0.4) continue;
        longest = node;
        longestLength = length;
      }
      best = longest;
    }

    if (!best) return '';
    return (best.innerText || best.textContent || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /** 页面上像章节链接的，挑出来（「抓整本」用） */
  function findChapterLinks() {
    const links = [];
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      const title = (a.textContent || '').trim();
      if (!title || title.length > 60) continue;
      if (!/(第\s*[0-9０-９零一二三四五六七八九十百千万两]{1,12}\s*[章回节]|Chapter\s*\d+|序章|楔子|番外|尾声|终章)/i.test(title)) {
        continue;
      }
      const href = a.href;
      if (!href || seen.has(href)) continue;
      seen.add(href);
      links.push({ title, url: href });
    }
    return links;
  }

  // ---------------------------------------------------------------- 界面

  function setStatus(text, kind) {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.kind = kind || '';
  }

  function setProgress(text) {
    if (!progressEl) return;
    progressEl.textContent = text || '';
  }

  const STYLE = `
    .nt-fab, .nt-panel { font-family: system-ui, -apple-system, 'Microsoft YaHei', sans-serif; }
    .nt-fab {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 44px; height: 44px; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
      background: #b4552d; color: #fff; font-size: 15px; font-weight: 700;
      box-shadow: 0 4px 14px rgba(0,0,0,.28); cursor: pointer; user-select: none;
      border: none;
    }
    .nt-panel {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
      width: 268px; padding: 12px; border-radius: 12px;
      background: #fffdfa; color: #22201d; font-size: 13px; line-height: 1.55;
      box-shadow: 0 8px 28px rgba(0,0,0,.22); border: 1px solid #e6e0d6;
    }
    .nt-panel h4 { margin: 0 0 6px; font-size: 13.5px; font-weight: 700; }
    .nt-row { display: flex; gap: 6px; margin-top: 8px; }
    .nt-btn {
      flex: 1; padding: 7px 8px; font: inherit; font-size: 12.5px;
      border-radius: 8px; border: 1px solid #e0d8cc; background: #f6f2ec;
      color: #22201d; cursor: pointer;
    }
    .nt-btn:hover { background: #efe8de; }
    .nt-btn-primary { background: #b4552d; border-color: #b4552d; color: #fff; font-weight: 600; }
    .nt-btn-primary:hover { background: #9c4523; }
    .nt-btn[disabled] { opacity: .5; cursor: not-allowed; }
    .nt-status { margin-top: 8px; font-size: 12px; color: #6b6862; }
    .nt-status[data-kind=ok] { color: #2f7d4f; }
    .nt-status[data-kind=warn] { color: #b07a12; }
    .nt-status[data-kind=err] { color: #b3372c; }
    .nt-progress { margin-top: 4px; font-size: 12px; color: #9a968e; }
    .nt-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .nt-link { font-size: 12px; color: #b4552d; cursor: pointer; background: none; border: none; padding: 0; }
    .nt-list { max-height: 200px; overflow: auto; margin: 8px 0 0; padding: 0; list-style: none; }
    .nt-list li { padding: 6px 8px; border-radius: 6px; cursor: pointer; }
    .nt-list li:hover { background: #f4efe7; }
    .nt-list small { color: #9a968e; display: block; }
  `;

  function injectStyle() {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  function render() {
    const hidden = readValue(HIDDEN_KEY, false);
    if (hidden) {
      panel = document.createElement('button');
      panel.className = 'nt-fab';
      panel.type = 'button';
      panel.title = '打开小说工具';
      panel.textContent = '书';
      panel.onclick = () => {
        writeValue(HIDDEN_KEY, false);
        rebuild();
      };
      document.body.appendChild(panel);
      return;
    }

    panel = document.createElement('div');
    panel.className = 'nt-panel';
    panel.innerHTML = `
      <div class="nt-head">
        <h4>小说工具</h4>
        <button class="nt-link" id="nt-hide" type="button">隐藏</button>
      </div>
      <div class="nt-status" id="nt-status">正在连接本机工具…</div>
      <div class="nt-progress" id="nt-progress"></div>
      <div class="nt-row">
        <button class="nt-btn nt-btn-primary" id="nt-save" type="button">存这一章</button>
        <button class="nt-btn" id="nt-all" type="button">抓整本</button>
      </div>
      <div class="nt-row">
        <button class="nt-btn" id="nt-pick" type="button">存到已有书</button>
      </div>
      <ul class="nt-list" id="nt-list" hidden></ul>`;
    document.body.appendChild(panel);

    statusEl = panel.querySelector('#nt-status');
    progressEl = panel.querySelector('#nt-progress');

    panel.querySelector('#nt-hide').onclick = () => {
      writeValue(HIDDEN_KEY, true);
      rebuild();
    };
    panel.querySelector('#nt-save').onclick = () => saveThisChapter();
    panel.querySelector('#nt-all').onclick = () => saveWholeBook();
    panel.querySelector('#nt-pick').onclick = () => pickExistingBook();

    refreshResolve();
  }

  function rebuild() {
    if (panel) panel.remove();
    panel = null;
    statusEl = null;
    progressEl = null;
    render();
  }

  // ---------------------------------------------------------------- 业务动作

  /** 识别归属并更新提示语 */
  async function refreshResolve() {
    const payload = {
      url: location.href,
      title: guessBookTitle(),
      author: guessAuthor(),
    };
    if (!online) {
      setStatus('请先双击启动.bat', 'warn');
      return null;
    }
    try {
      const result = await request('POST', '/api/userscript/resolve', payload);
      resolved = result;
      setStatus(result.message, result.matched ? 'ok' : '');
      return result;
    } catch (err) {
      if (err.message === 'OFFLINE') {
        online = false;
        setStatus('请先双击启动.bat', 'warn');
      } else {
        setStatus(err.message, 'err');
      }
      return null;
    }
  }

  function chapterPayload() {
    return {
      url: location.href,
      title: guessBookTitle(),
      author: guessAuthor(),
      chapter_title: guessChapterTitle(),
      content: extractContent(),
      book_id: resolved && resolved.matched ? resolved.book.book_id : undefined,
    };
  }

  async function saveThisChapter() {
    if (busy) return;
    const item = chapterPayload();
    if (!item.content || item.content.replace(/\s/g, '').length < 20) {
      setStatus('这个页面上没找到正文，没法保存。', 'warn');
      return;
    }

    busy = true;
    const saveBtn = panel && panel.querySelector('#nt-save');
    if (saveBtn) saveBtn.disabled = true;
    setStatus('正在保存…');

    try {
      if (!online && !(await detectService())) throw new Error('OFFLINE');
      const result = await request('POST', '/api/userscript/capture', item);
      setStatus(result.message, result.saved ? 'ok' : 'warn');
      if (!result.saved && result.chapter_index) {
        setProgress(`（第 ${result.chapter_index} 章已存在，未重复写入）`);
      } else {
        setProgress('');
      }
      await refreshResolve();
    } catch (err) {
      if (err.message === 'OFFLINE') {
        const size = enqueue(item);
        online = false;
        setStatus('服务没启动，已暂存在浏览器里，等服务起来会自动补交。', 'warn');
        setProgress(`暂存队列：${size} 条`);
      } else {
        setStatus(err.message, 'err');
      }
    } finally {
      busy = false;
      if (saveBtn) saveBtn.disabled = false;
    }
  }

  /** 抓整本：把当前页面上能看到的章节链接逐章抓下来再批量提交 */
  async function saveWholeBook() {
    if (busy) return;
    const links = findChapterLinks();
    if (links.length < 2) {
      setStatus('这个页面上没有章节列表。请到目录页再点「抓整本」。', 'warn');
      return;
    }
    const limit = 30;
    const targets = links.slice(0, limit);

    busy = true;
    const allBtn = panel && panel.querySelector('#nt-all');
    if (allBtn) allBtn.disabled = true;
    setStatus(`正在抓取 ${targets.length} 章…`);

    const chapters = [];
    try {
      for (let i = 0; i < targets.length; i++) {
        setProgress(`${i + 1} / ${targets.length}`);
        try {
          // eslint-disable-next-line no-await-in-loop
          const html = await fetchPage(targets[i].url);
          const parsed = extractFromHtml(html);
          if (parsed.content && parsed.content.replace(/\s/g, '').length >= 20) {
            chapters.push({
              url: targets[i].url,
              chapter_title: parsed.title || targets[i].title,
              content: parsed.content,
            });
          }
        } catch (err) {
          /* 单章失败不影响其它章 */
        }
        // 页面之间稍微停一下，别把人家站点打得太急
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 1200));
      }

      if (!chapters.length) {
        setStatus('一章都没抓到，可能是页面结构变了。', 'err');
        return;
      }

      if (!online && !(await detectService())) throw new Error('OFFLINE');

      const result = await request(
        'POST',
        '/api/userscript/batch',
        {
          url: location.href,
          title: guessBookTitle(),
          author: guessAuthor(),
          book_id: resolved && resolved.matched ? resolved.book.book_id : undefined,
          chapters,
        },
        120000
      );

      setStatus(result.message, 'ok');
      setProgress(
        links.length > limit ? `页面上共 ${links.length} 章，这次只抓了前 ${limit} 章；整本建议用「抓取控制台」。` : ''
      );
      await refreshResolve();
    } catch (err) {
      if (err.message === 'OFFLINE') {
        for (const chapter of chapters) {
          enqueue({
            url: chapter.url,
            title: guessBookTitle(),
            author: guessAuthor(),
            chapter_title: chapter.chapter_title,
            content: chapter.content,
          });
        }
        online = false;
        setStatus('服务没启动，已把抓到的章节暂存起来，等服务起来自动补交。', 'warn');
      } else {
        setStatus(err.message, 'err');
      }
    } finally {
      busy = false;
      if (allBtn) allBtn.disabled = false;
    }
  }

  /** 用 GM_xmlhttpRequest 取回一个页面（脚本跑在页面里，普通 fetch 会被跨域挡住） */
  function fetchPage(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('这个浏览器脚本管理器不支持跨页抓取'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        timeout: 20000,
        onload: (res) => resolve(res.responseText),
        onerror: () => reject(new Error('取回页面失败')),
        ontimeout: () => reject(new Error('取回页面超时')),
      });
    });
  }

  /** 从一段 HTML 里抽出章节标题与正文（用浏览器自带的解析能力，不引任何库） */
  function extractFromHtml(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    let title = '';
    for (const selector of TITLE_SELECTORS) {
      const node = doc.querySelector(selector);
      if (node && node.textContent.trim() && node.textContent.trim().length <= 60) {
        title = node.textContent.trim();
        break;
      }
    }
    if (!title && doc.title) title = doc.title.split(/[_\-|]/)[0].trim();

    let container = null;
    for (const selector of CONTENT_SELECTORS) {
      const node = doc.querySelector(selector);
      if (!node) continue;
      const text = node.textContent || '';
      if (text.replace(/\s/g, '').length >= 80) {
        container = node;
        break;
      }
    }
    if (!container) {
      let longest = null;
      let longestLength = 0;
      for (const node of doc.querySelectorAll('div, article, section, td')) {
        const text = node.textContent || '';
        const length = text.replace(/\s/g, '').length;
        if (length > longestLength) {
          longest = node;
          longestLength = length;
        }
      }
      container = longest;
    }
    if (!container) return { title, content: '' };

    // 把 <br> 换成换行，否则整章会黏成一行
    const clone = container.cloneNode(true);
    for (const br of Array.from(clone.querySelectorAll('br'))) {
      br.replaceWith('\n');
    }
    for (const media of Array.from(clone.querySelectorAll('script, style, iframe'))) {
      media.remove();
    }
    const content = (clone.textContent || '')
      .replace(/\u00a0/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter((line, i, all) => line || (all[i - 1] && all[i - 1] !== ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { title, content };
  }

  /** 存到已有书：列出书架上的书让用户挑 */
  async function pickExistingBook() {
    const list = panel && panel.querySelector('#nt-list');
    if (!list) return;
    if (!list.hidden) {
      list.hidden = true;
      return;
    }
    if (!online && !(await detectService())) {
      setStatus('请先双击启动.bat', 'warn');
      return;
    }
    setStatus('正在读取书架…');
    try {
      const data = await request('GET', '/api/books');
      const books = (data && data.books) || [];
      list.hidden = false;
      if (!books.length) {
        list.innerHTML = '<li>书架还是空的。<small>先点「存这一章」会自动新建一本。</small></li>';
        return;
      }
      list.innerHTML = '';
      for (const book of books.slice(0, 40)) {
        const li = document.createElement('li');
        li.innerHTML = `${escapeHtml(book.title)}<small>${escapeHtml(book.author || '作者未知')} · 已有 ${book.total_chapters} 章</small>`;
        li.onclick = () => {
          resolved = {
            matched: true,
            via: 'explicit',
            book: { book_id: book.book_id, title: book.title, total_chapters: book.total_chapters },
            message: `将追加到《${book.title}》的第 ${book.total_chapters + 1} 章。`,
          };
          setStatus(resolved.message, 'ok');
          list.hidden = true;
        };
        list.appendChild(li);
      }
    } catch (err) {
      setStatus(err.message, 'err');
    }
  }

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  // ---------------------------------------------------------------- 补交暂存

  async function flushQueue() {
    const queue = readQueue();
    if (!queue.length) return;
    if (!online && !(await detectService())) return;
    try {
      const result = await request('POST', '/api/userscript/flush', { items: queue }, 120000);
      // 服务端会带上原队列下标，按它精确清掉已经成功的条目；
      // 失败的（含被跳过但仍要清掉的重复条目）留在队列里下次再试
      const failedIndexes = new Set((result.results || []).filter((r) => !r.ok).map((r) => r.queue_index));
      const remaining = queue.filter((_, i) => failedIndexes.has(i));
      writeQueue(remaining);
      setStatus(result.message, remaining.length ? 'warn' : 'ok');
      setProgress(remaining.length ? `暂存队列还有 ${remaining.length} 条` : '');
    } catch (err) {
      /* 补交失败不打扰用户，下次再试 */
    }
  }

  // ---------------------------------------------------------------- 启动

  async function boot() {
    if (!document.body) return;
    injectStyle();
    render();

    await detectService();
    if (online) {
      await refreshResolve();
      flushQueue();
      // 服务是之后才起来的：每隔一会儿试着补交一次
      setInterval(() => {
        if (!online) detectService().then((ok) => ok && flushQueue());
        else flushQueue();
      }, 60000);
    }

    const queue = readQueue();
    if (queue.length) setProgress(`暂存队列：${queue.length} 条`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
