'use strict';
/**
 * fake-site.js —— 测试用的假小说站。
 *
 * 为什么要有它：
 * 抓取链路的测试绝对不能去打真实站点（既不合规也不稳定）。
 * 这里起一个只监听本机的小服务，把"常见目录页 / 章节页 / 翻页 / 登录墙 / 付费墙 /
 * robots.txt 禁止 / GBK 编码"这些情况都造出来，让抓取器的每条分支都能被测到。
 *
 * 注意：它只在本机监听 127.0.0.1，端口由系统分配，测试结束立刻关闭。
 */

const http = require('http');
const iconv = require('iconv-lite');

function defaultChapterText(index) {
  const lines = [];
  lines.push(`这是第 ${index} 章的第一段正文，用来验证抓取能不能拿到完整内容。`);
  lines.push(`这是第 ${index} 章的第二段正文，中间夹着一行站点推广。`);
  lines.push(`请记住本站域名 www.fake-novel-site.com，最快更新第 ${index} 章。`);
  lines.push(`这是第 ${index} 章的第三段正文，到这里这一章就结束了。`);
  return lines;
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * @param {{chapterCount?:number, paginateChapters?:number, robotsTxt?:string|null,
 *          encoding?:'utf-8'|'gbk', bookTitle?:string, author?:string}} options
 */
function createFakeSite(options = {}) {
  const config = {
    chapterCount: options.chapterCount === undefined ? 12 : options.chapterCount,
    /** 前 N 章带"下一页"分页 */
    paginateChapters: options.paginateChapters || 0,
    /** 这些章号返回 500（用来测"失败重试"与"失败不中断整个任务"） */
    failChapters: options.failChapters || [],
    /** 这些章号返回空正文（用来测"抓到空内容"这类失败原因） */
    emptyChapters: options.emptyChapters || [],
    robotsTxt: options.robotsTxt === undefined ? 'User-agent: *\nDisallow: /private/\n' : options.robotsTxt,
    encoding: options.encoding || 'utf-8',
    bookTitle: options.bookTitle || '测试小说',
    author: options.author || '测试作者',
  };

  /** 记录收到过哪些请求，测试里可以核对"有没有重复抓"、"请求间隔够不够" */
  const requestLog = [];

  function send(res, status, html, contentType = 'text/html; charset=utf-8') {
    const buffer =
      config.encoding === 'gbk' && contentType.includes('text/html')
        ? iconv.encode(html, 'gbk')
        : Buffer.from(html, 'utf8');
    const type =
      config.encoding === 'gbk' && contentType.includes('text/html')
        ? 'text/html; charset=gbk'
        : contentType;
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': buffer.length });
    res.end(buffer);
  }

  function chapterPage(index, page) {
    const lines = defaultChapterText(index);
    const isSecondPage = page === 2;
    const bodyLines = isSecondPage
      ? [`这是第 ${index} 章续页的内容，说明这一章被拆成了多页。`, `续页的最后一段，第 ${index} 章完。`]
      : lines;

    const nextPageLink =
      !isSecondPage && index <= config.paginateChapters
        ? '<a href="?page=2">下一页</a>'
        : '';
    const nextChapterLink =
      index < config.chapterCount ? `<a href="/book/ch${index + 1}">下一章</a>` : '';

    return `<!doctype html><html><head><meta charset="utf-8">
<title>第${index}章 测试标题${index}_${config.bookTitle}_${config.author}_示例站</title></head>
<body>
<div class="header"><a href="/">首页</a><a href="/book">目录</a></div>
<h1>第${index}章 测试标题${index}</h1>
<div id="content">
${bodyLines.map((line) => `${escapeHtml(line)}<br><br>`).join('\n')}
</div>
<div class="page-nav">${nextPageLink}<a href="/book/ch${Math.max(1, index - 1)}">上一章</a>${nextChapterLink}</div>
<div class="footer">示例站 版权所有</div>
</body></html>`;
  }

  function tocPage() {
    const items = [];
    for (let i = 1; i <= config.chapterCount; i++) {
      items.push(`<li><a href="/book/ch${i}">第${i}章 测试标题${i}</a></li>`);
    }
    return `<!doctype html><html><head><meta charset="utf-8">
<title>${config.bookTitle}_${config.author}_示例站</title></head>
<body>
<div class="header"><a href="/">首页</a><a href="/top">排行榜</a><a href="/help">帮助</a></div>
<div class="book-info">
  <h1>${config.bookTitle}</h1>
  <p>作者：${config.author}</p>
  <p>简介：这是一本用来测试抓取功能的小说。</p>
</div>
<div id="list">
  <ul>
  ${items.join('\n')}
  </ul>
</div>
<div class="footer">友情链接：<a href="/a">a站</a><a href="/b">b站</a></div>
</body></html>`;
  }

  function loginWallPage() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>请登录_示例站</title></head>
<body>
<div class="login-box">
  <p>请先登录后再阅读本章内容</p>
  <form method="post" action="/login">
    <input type="text" name="user" placeholder="用户名" />
    <input type="password" name="pass" placeholder="密码" />
    <button type="submit">立即登录</button>
  </form>
</div>
</body></html>`;
  }

  function paywallPage() {
    return `<!doctype html><html><head><meta charset="utf-8"><title>VIP章节_示例站</title></head>
<body>
<div class="vip-tip">
  <p>本章为付费章节，需要开通 VIP 会员才能阅读。</p>
  <p>试读结束，购买本章后可继续阅读。</p>
  <button>开通会员</button>
</div>
</body></html>`;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requestLog.push({ url: url.pathname + url.search, at: Date.now() });

    if (url.pathname === '/robots.txt') {
      if (config.robotsTxt === null) {
        send(res, 404, 'not found', 'text/plain; charset=utf-8');
        return;
      }
      send(res, 200, config.robotsTxt, 'text/plain; charset=utf-8');
      return;
    }

    if (url.pathname === '/book/login') {
      send(res, 200, loginWallPage());
      return;
    }
    if (url.pathname === '/book/vip') {
      send(res, 200, paywallPage());
      return;
    }
    if (url.pathname === '/private/book') {
      // 这个路径被默认 robots 规则禁掉，用来测"命中禁止路径"
      send(res, 200, tocPage());
      return;
    }

    if (url.pathname === '/book' || url.pathname === '/') {
      send(res, 200, tocPage());
      return;
    }

    const chapterMatch = /^\/book\/ch(\d+)$/.exec(url.pathname);
    if (chapterMatch) {
      const index = Number(chapterMatch[1]);
      if (index < 1 || index > config.chapterCount) {
        send(res, 404, '这一章不存在');
        return;
      }
      // 按配置制造失败场景：500（网络/页面异常）和空正文（抓到了但没内容）
      if (config.failChapters.includes(index)) {
        send(res, 500, '<html><head><title>500</title></head><body>服务器开小差了</body></html>');
        return;
      }
      if (config.emptyChapters.includes(index)) {
        send(
          res,
          200,
          `<!doctype html><html><head><title>第${index}章</title></head><body><div id="content"></div></body></html>`
        );
        return;
      }
      const page = Number(url.searchParams.get('page')) || 1;
      send(res, 200, chapterPage(index, page));
      return;
    }

    send(res, 404, '<html><head><title>404</title></head><body>没有这个页面</body></html>');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        config,
        port,
        origin: `http://127.0.0.1:${port}`,
        tocUrl: `http://127.0.0.1:${port}/book`,
        chapterUrl: (index) => `http://127.0.0.1:${port}/book/ch${index}`,
        loginUrl: `http://127.0.0.1:${port}/book/login`,
        vipUrl: `http://127.0.0.1:${port}/book/vip`,
        privateUrl: `http://127.0.0.1:${port}/private/book`,
        robotsUrl: `http://127.0.0.1:${port}/robots.txt`,
        requestLog,
        /** 每个 URL 被请求了几次 */
        countOf(pathname) {
          return requestLog.filter((r) => r.url.startsWith(pathname)).length;
        },
        reset() {
          requestLog.length = 0;
        },
        async close() {
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

module.exports = { createFakeSite, defaultChapterText };
