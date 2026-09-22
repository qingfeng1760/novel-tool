'use strict';
/**
 * generic-web.js —— 通用网页抓取器（v1 唯一的 SourceProvider 实现）。
 *
 * 承诺范围（PRD §8 明确）：**大多数常见目录页结构能自动猜出来**，
 * 不承诺覆盖某个具体站点，更不内置任何站点清单。
 *
 * 探测思路（不靠任何站点规则，纯结构判断）：
 *   目录区：谁下面的"像章节标题的链接"最多，谁就是目录容器；
 *   正文区：在章节页里找"文字多、标签少"（文字密度高）的容器，那就是正文；
 *   翻页控件：找文字是「下一页 / 下页 / next」的链接；
 *   并且严格区分"下一页"和"下一章" —— 前者要把内容接起来，后者不能接。
 *
 * 探测失败时不做无根据的猜测：把页面里所有"候选目录区 / 候选正文区"
 * 原样列出来交给用户点选（PRD 模块 2 要求的"手动点选修复"）。
 */

const cheerio = require('cheerio');
const { fetchText, resolveUrl, hostOf } = require('../http-client');

/** 常见正文容器选择器：先按经验试，试不到再走结构打分 */
const KNOWN_CONTENT_SELECTORS = [
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

/** 章节标题特征的松判断：用来给"像章节标题的链接"计数 */
const CHAPTER_TITLE_LIKE = /(第\s*[0-9０-９零一二三四五六七八九十百千万两]{1,12}\s*[章回节卷篇集]|Chapter\s*\d{1,5}|序章|楔子|引子|番外|尾声|后记|终章|大结局)/i;

/** 目录页"下一页"控件 */
const NEXT_PAGE_TEXT = /^\s*(?:下一页|下页|下一頁|后一页|next|›|»|>)\s*$/i;
/** 章节页"下一章"控件 —— 这个不能当成翻页 */
const NEXT_CHAPTER_TEXT = /下一[章节回]|下章/i;

const MAX_PAGINATION = 20;
const MIN_CONTENT_CHARS = 40;

// ------------------------------------------------------------------ 小工具

/** 生成一个尽量简短又能唯一定位的选择器 */
function buildSelector($, el) {
  if (!el || !el.attribs) return '';
  const node = el;

  const escape = (text) => String(text).replace(/([^\w-])/g, '\\$1');
  const candidates = [];

  if (node.attribs.id) candidates.push(`#${escape(node.attribs.id)}`);
  const tag = node.tagName || node.name;
  if (node.attribs.class) {
    const classes = String(node.attribs.class).trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (classes.length) candidates.push(`${tag}.${classes.map(escape).join('.')}`);
  }
  candidates.push(tag);

  // 从最简单的写法开始试，谁唯一就用谁
  for (const candidate of candidates) {
    try {
      if ($(candidate).length === 1) return candidate;
    } catch (err) {
      /* 选择器语法问题，跳过 */
    }
  }

  // 都不唯一：拼一条带祖先路径的选择器
  const parts = [];
  let current = node;
  for (let depth = 0; current && current.tagName && depth < 6; depth++) {
    const currentTag = current.tagName;
    const parent = current.parent;
    const sameTagSiblings = parent
      ? (parent.children || []).filter((c) => c.tagName === currentTag)
      : [current];
    const suffix =
      sameTagSiblings.length > 1
        ? `:nth-child(${(parent.children || []).indexOf(current) + 1})`
        : '';
    parts.unshift(currentTag + suffix);
    if (current.attribs && current.attribs.id) {
      parts[0] = `#${escape(current.attribs.id)}`;
      break;
    }
    current = parent;
  }
  return parts.join(' > ');
}

function textOf($, el) {
  return $(el).text().replace(/\s+/g, ' ').trim();
}

/** 元素里的"文字密度"：文字多、标签少，才像正文 */
function densityOf($, el) {
  const text = textOf($, el);
  const tags = $(el).find('*').length + 1;
  return { text, length: text.length, tags, density: text.length / tags };
}

/** 元素在文档里的深度（越深越具体） */
function depthOf(el) {
  let depth = 0;
  let current = el;
  while (current && current.parent) {
    depth++;
    current = current.parent;
  }
  return depth;
}

/**
 * 给一组链接打分。
 *
 * 关键在评分公式：光看"链接多"会把 <body> 选出来（它包含全站导航），
 * 所以必须同时奖励"像章节标题的链接占比"，并惩罚"不像章节标题的链接"。
 * 举例（本机假站点）：
 *   <body>   15 个链接、12 个像章节 → 因为混了 3 个导航链接而被扣分
 *   #list    12 个链接、12 个像章节 → 又纯又集中，胜出
 *   .header   3 个导航链接          → 得分极低，被淘汰
 */
function scoreLinkGroup(links, depth = 0) {
  if (links.length < 3) return -1;
  const uniqueHrefs = new Set(links.map((l) => l.href)).size;
  const chapterLike = links.filter((l) => CHAPTER_TITLE_LIKE.test(l.title)).length;
  const other = links.length - chapterLike;
  const chapterRatio = chapterLike / links.length;
  const avgLen = links.reduce((sum, l) => sum + l.title.length, 0) / links.length;
  // 章节标题一般不长不短；太长多是把整段文字包在链接里的导航
  const lengthScore = avgLen >= 2 && avgLen <= 26 ? 1 : 0.3;

  return (
    chapterLike * 2 +
    chapterRatio * 20 -
    other * 1.2 +
    Math.min(uniqueHrefs, 6) * 0.5 +
    lengthScore * 2 +
    Math.min(depth, 8) * 0.3
  );
}

/** 候选的最低分：低于这个分数基本就是页头页脚的导航 */
const MIN_TOC_SCORE = 5;

// ------------------------------------------------------------------ 探测

/**
 * 找出候选的目录区。
 *
 * 注意这里遍历的是**所有元素**，而不是"链接的直接父元素"：
 * 目录常见结构是 `<div id="list"><ul><li><a>…</a></li></ul></div>`，
 * 如果只看直接父元素，每个 <li> 都只有一个链接，会被当成"链接太少"直接漏掉，
 * 最后反而把页头那三个导航链接选中。
 *
 * @returns {Array<{el:*, selector:string, links:Array, score:number}>}
 */
function findTocCandidates($) {
  const candidates = [];
  $('body *').each((_, el) => {
    const $el = $(el);
    const anchors = $el.find('a[href]');
    if (anchors.length < 3) return;

    const links = [];
    anchors.each((__, a) => {
      const href = String($(a).attr('href') || '').trim();
      if (!href || href.startsWith('#') || /^javascript:/i.test(href)) return;
      const title = textOf($, a);
      if (!title || title.length > 60) return;
      links.push({ title, href, el: a });
    });
    if (links.length < 3) return;

    const depth = depthOf(el);
    const score = scoreLinkGroup(links, depth);
    if (score < MIN_TOC_SCORE) return;
    candidates.push({ el, selector: buildSelector($, el), links, score, depth });
  });

  // 分数相同时取更深的那个 —— 越深越具体，越不容易把整页都当成目录
  candidates.sort((a, b) => b.score - a.score || b.depth - a.depth);
  return candidates;
}

/** 在章节页里找出候选正文区 */
function findContentCandidates($) {
  const candidates = [];
  $('div, article, section, td, main').each((_, el) => {
    const info = densityOf($, el);
    if (info.length < MIN_CONTENT_CHARS) return;
    // 链接太多说明是导航/列表，不是正文
    const linkText = $(el)
      .find('a')
      .text()
      .replace(/\s+/g, '')
      .length;
    const linkRatio = linkText / Math.max(1, info.text.replace(/\s+/g, '').length);
    if (linkRatio > 0.5) return;
    const breaks = $(el).find('br').length;
    const paragraphs = $(el).find('p').length;
    const score = info.density * 0.5 + info.length * 0.02 + breaks * 3 + paragraphs * 2 - linkRatio * 40;
    candidates.push({ el, selector: buildSelector($, el), ...info, score });
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

/** 找"下一页"控件（只在给定范围内找） */
function findNextPageControl($, rootEl) {
  const scope = rootEl ? $(rootEl) : $.root();
  let found = null;
  scope.find('a[href]').each((_, a) => {
    if (found) return;
    const text = textOf($, a);
    if (NEXT_PAGE_TEXT.test(text)) {
      found = { href: String($(a).attr('href') || ''), text };
    }
  });
  return found;
}

/** 从页面标题里猜书名与作者 */
function guessBookMeta($, url) {
  const rawTitle = String($('title').first().text() || '').trim();
  let title = rawTitle;
  let author = '';

  // 常见写法："书名_作者_站点名" / "书名 - 作者" / "书名(作者)的最新章节"
  const patterns = [
    /^(.+?)\s*[_\-|]\s*(.+?)\s*[_\-|]\s*(.+)$/,
    /^(.+?)\s*[（(]([^）)]+)[）)]/,
    /^(.+?)\s*[-_|]\s*(.+)$/,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(rawTitle);
    if (!hit) continue;
    title = hit[1].trim();
    author = (hit[2] || '').trim();
    break;
  }
  // 去掉"最新章节""全文阅读"这类尾巴。
  // 注意这里**不能**把"小说"当尾巴去掉 —— 很多书的书名本身就以"小说"结尾。
  title = title.replace(/[（(]?(最新章节|全文阅读|免费阅读|无弹窗|全文免费阅读)[）)]?$/g, '').trim();

  // 页面上常见的作者标记
  if (!author) {
    const authorNode = $('[class*=author], [id*=author]').first();
    if (authorNode.length) {
      const text = textOf($, authorNode.get(0));
      const hit = /作者[：:]\s*([^\s|]+)/.exec(text);
      if (hit) author = hit[1].trim();
    }
  }
  if (!author) {
    const hit = /作者[：:]\s*([^\s<|]{1,20})/.exec($('body').text().slice(0, 4000));
    if (hit) author = hit[1].trim();
  }

  let site = '';
  try {
    site = new URL(url).host;
  } catch (err) {
    site = '';
  }
  return { pageTitle: rawTitle, title: title || site || '未命名', author, site };
}

/**
 * 探测目录页。
 * @param {string} url
 * @param {{tocSelector?:string, contentSelector?:string, linkSelector?:string, page?:Object}} options
 *        page: 已经取回来的页面（compliance 阶段取过就不重复请求）
 */
async function probe(url, options = {}) {
  const page = options.page || (await fetchText(url));
  const $ = cheerio.load(page.text);

  // ---- 目录区
  let tocCandidates = findTocCandidates($);
  let toc = null;
  if (options.tocSelector) {
    const el = $(options.tocSelector).get(0);
    if (!el) {
      return {
        ok: false,
        reason: 'toc_selector_not_found',
        message: '你指定的目录区选择器在页面上找不到元素。',
        hint: '请先从下面的候选里点一个，或者检查选择器是否写对了。',
      };
    }
    const links = [];
    $(el)
      .find(options.linkSelector || 'a[href]')
      .each((_, a) => {
        const href = String($(a).attr('href') || '').trim();
        const title = textOf($, a);
        if (href && title && !href.startsWith('#')) links.push({ title, href, el: a });
      });
    toc = { el, selector: options.tocSelector, links, score: scoreLinkGroup(links) };
  } else if (tocCandidates.length) {
    toc = tocCandidates[0];
  }

  if (!toc || !toc.links.length) {
    return {
      ok: false,
      reason: 'no_toc',
      message: '没认出这个页面的结构：页面上找不到像"章节列表"的区域。',
      hint: '请在下面从页面结构里手动点选目录区，然后重新探测。',
      candidates: {
        toc: tocCandidates.slice(0, 8).map((c) => ({
          selector: c.selector,
          linkCount: c.links.length,
          sample: c.links.slice(0, 3).map((l) => l.title),
        })),
      },
      pageTitle: $('title').first().text().trim(),
    };
  }

  // 去重（同一章可能出现多个链接）并转成绝对地址
  const seen = new Set();
  const chapterLinks = [];
  for (const link of toc.links) {
    const absolute = resolveUrl(page.finalUrl || url, link.href);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    chapterLinks.push({ title: link.title, url: absolute });
  }

  const meta = guessBookMeta($, url);
  const tocNext = findNextPageControl($, toc.el);

  // ---- 正文区：抓第一章来试
  const probeChapterUrl = chapterLinks[0] ? chapterLinks[0].url : null;
  let content = null;
  let contentCandidates = [];
  let chapterPage = null;

  if (probeChapterUrl) {
    try {
      chapterPage = await fetchText(probeChapterUrl, { referer: url });
      const $chapter = cheerio.load(chapterPage.text);

      if (options.contentSelector) {
        const el = $chapter(options.contentSelector).get(0);
        if (!el) {
          return {
            ok: false,
            reason: 'content_selector_not_found',
            message: '你指定的正文选择器在章节页里找不到元素。',
            hint: '请重新从候选里点选正文区。',
          };
        }
        const info = densityOf($chapter, el);
        content = { el, selector: options.contentSelector, ...info };
      } else {
        // 先按常见选择器试
        for (const selector of KNOWN_CONTENT_SELECTORS) {
          const el = $chapter(selector).get(0);
          if (!el) continue;
          const info = densityOf($chapter, el);
          if (info.length >= MIN_CONTENT_CHARS) {
            content = { el, selector, ...info };
            break;
          }
        }
        if (!content) {
          contentCandidates = findContentCandidates($chapter);
          if (contentCandidates.length) content = contentCandidates[0];
        }
      }

      if (!content) {
        const fallback = findContentCandidates($chapter);
        if (fallback.length) {
          content = fallback[0];
          contentCandidates = fallback;
        }
      }
    } catch (err) {
      chapterPage = null;
    }
  }

  const warnings = [];
  if (!content) {
    warnings.push('没能自动认出正文区，抓取时可能会把导航文字也带进来。可以手动点选正文区。');
  }
  if (chapterLinks.length < 3) {
    warnings.push('这个页面上的章节链接很少（可能只列出了部分章节），请确认这是目录页。');
  }

  const nextPage = chapterPage ? findNextPageControl(cheerio.load(chapterPage.text), null) : null;

  return {
    ok: true,
    provider: 'generic-web',
    url,
    finalUrl: page.finalUrl || url,
    site: meta.site,
    encoding: page.encoding,
    book: { title: meta.title, author: meta.author, page_title: meta.pageTitle, source_site: meta.site },
    toc: {
      selector: toc.selector,
      linkSelector: 'a[href]',
      linkCount: chapterLinks.length,
      sample: chapterLinks.slice(0, 5),
      pagination: tocNext
        ? { hasNext: true, text: tocNext.text, url: resolveUrl(page.finalUrl || url, tocNext.href) }
        : { hasNext: false },
    },
    content: content
      ? {
          selector: content.selector,
          charCount: content.length,
          sampleText: content.text.slice(0, 400),
          detected: Boolean(options.contentSelector) || KNOWN_CONTENT_SELECTORS.includes(content.selector),
        }
      : { selector: '', charCount: 0, sampleText: '', detected: false },
    chapterPagination: nextPage
      ? { hasNext: true, text: nextPage.text, isSameChapter: !NEXT_CHAPTER_TEXT.test(nextPage.text) }
      : { hasNext: false },
    /** 探测失败/不确定时，把页面里的候选原样交出去让用户点选 */
    candidates: {
      toc: tocCandidates.slice(0, 8).map((c) => ({
        selector: c.selector,
        linkCount: c.links.length,
        sample: c.links.slice(0, 3).map((l) => l.title),
      })),
      content: contentCandidates.slice(0, 8).map((c) => ({
        selector: c.selector,
        charCount: c.length,
        sample: c.text.slice(0, 80),
      })),
    },
    warnings,
    chapterLinks,
    probedAt: new Date().toISOString(),
  };
}

// ------------------------------------------------------------------ 抓单章

/**
 * 把一个章节页的正文抽出来（含"下一页"拼合）。
 * @returns {{title:string, content:string, pages:number, removed:Array, charCount:number, url:string}}
 */
async function extractChapter(pageUrl, probeResult, options = {}) {
  const { cleaner } = options;
  const collected = [];
  const removed = [];
  let pages = 0;
  let currentUrl = pageUrl;
  let title = '';

  while (currentUrl && pages < MAX_PAGINATION) {
    // eslint-disable-next-line no-await-in-loop
    const page = await fetchText(currentUrl, { referer: probeResult.url });
    const $ = cheerio.load(page.text);
    pages++;

    if (!title) {
      const heading = $('h1').first().text().trim() || $('title').first().text().trim();
      title = heading.split(/[_\-|]/)[0].trim();
    }

    let container = null;
    if (probeResult.content && probeResult.content.selector) {
      container = $(probeResult.content.selector).get(0) || null;
    }
    if (!container) {
      for (const selector of KNOWN_CONTENT_SELECTORS) {
        const el = $(selector).get(0);
        if (el && textOf($, el).length >= MIN_CONTENT_CHARS) {
          container = el;
          break;
        }
      }
    }
    if (!container) {
      const candidates = findContentCandidates($);
      if (candidates.length) container = candidates[0].el;
    }

    let text = '';
    if (container) {
      // <br> 是段落分隔，直接取 text() 会把整段黏成一行，所以先把它们变成换行
      const $copy = cheerio.load($.html(container));
      $copy('script, style, iframe, noscript').remove();
      $copy('br').replaceWith('\n');
      $copy('p, div, li, h1, h2, h3').each((_, el) => {
        const $el = $copy(el);
        $el.append('\n');
      });
      // 正文里的链接多半是"上一章/目录/下一章"，整行丢掉（下面还会按行再筛一遍）
      $copy('a').each((_, el) => {
        const href = String($copy(el).attr('href') || '');
        if (!href || href === '#' || /^javascript:/i.test(href)) return;
        $copy(el).replaceWith('\n');
      });
      text = $copy.root().text();
    }

    // 按行清洗：Nav 行 + 广告行
    const lines = text
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[\u00a0\u3000]/g, ' ').replace(/[ \t]+/g, ' ').trim());

    const kept = [];
    for (const line of lines) {
      if (!line) {
        kept.push('');
        continue;
      }
      // 纯导航行
      if (/^(上一章|下一章|上一页|下一页|回目录|目录|返回书页|加入书签|推荐本书|手机阅读|章节报错)$/.test(line)) {
        removed.push({ reason: '导航行', snippet: line });
        continue;
      }
      const adReason = cleaner ? cleaner.detectAdLine(line) : null;
      if (adReason) {
        removed.push({ reason: adReason, snippet: line.slice(0, 80) });
        continue;
      }
      kept.push(line);
    }

    collected.push(kept.join('\n').replace(/\n{3,}/g, '\n\n').trim());

    // 找"下一页"（同章续页才跟，跨章不跟）
    const nextControl = findNextPageControl($, null);
    if (!nextControl || NEXT_CHAPTER_TEXT.test(nextControl.text)) break;
    const nextUrl = resolveUrl(page.finalUrl || currentUrl, nextControl.href);
    if (!nextUrl || nextUrl === currentUrl) break;
    // 下一页的链接文字里出现"章"就说明是下一章了，不接
    if (CHAPTER_TITLE_LIKE.test(nextControl.text)) break;
    currentUrl = nextUrl;
  }

  const content = collected.filter(Boolean).join('\n\n').trim();
  return {
    title,
    content,
    pages,
    removed,
    charCount: content.replace(/\s/g, '').length,
    url: pageUrl,
  };
}

/**
 * 只读目录页（不取章节页）。
 *
 * 追更检查只需要"目录上现在有哪些章"，不需要正文样例，
 * 也不应该为了检查更新而多抓一个章节页 —— 少一次请求就是少打扰一次对方站点。
 */
async function probeToc(url, options = {}) {
  const page = options.page || (await fetchText(url));
  const $ = cheerio.load(page.text);

  let toc = null;
  if (options.tocSelector) {
    const el = $(options.tocSelector).get(0);
    if (el) {
      const links = [];
      $(el)
        .find(options.linkSelector || 'a[href]')
        .each((_, a) => {
          const href = String($(a).attr('href') || '').trim();
          const title = textOf($, a);
          if (href && title && !href.startsWith('#')) links.push({ title, href, el: a });
        });
      toc = { el, selector: options.tocSelector, links };
    }
  }
  if (!toc) {
    const candidates = findTocCandidates($);
    toc = candidates[0] || null;
  }
  if (!toc || !toc.links.length) {
    return { ok: false, reason: 'no_toc', message: '没能在目录页上认出章节列表。' };
  }

  const seen = new Set();
  const chapterLinks = [];
  for (const link of toc.links) {
    const absolute = resolveUrl(page.finalUrl || url, link.href);
    if (!absolute || seen.has(absolute)) continue;
    seen.add(absolute);
    chapterLinks.push({ title: link.title, url: absolute });
  }

  const meta = guessBookMeta($, url);
  return {
    ok: true,
    url,
    finalUrl: page.finalUrl || url,
    site: meta.site,
    encoding: page.encoding,
    book: { title: meta.title, author: meta.author, page_title: meta.pageTitle, source_site: meta.site },
    toc: { selector: toc.selector, linkSelector: 'a[href]', linkCount: chapterLinks.length },
    chapterLinks,
    probedAt: new Date().toISOString(),
  };
}

/** 试抓：取前 N 章正文供用户确认 */
async function previewChapters(probeResult, count = 3, options = {}) {
  const targets = (probeResult.chapterLinks || []).slice(0, count);
  const results = [];
  for (const target of targets) {
    // eslint-disable-next-line no-await-in-loop
    const extracted = await extractChapter(target.url, probeResult, options);
    results.push({
      index: results.length + 1,
      title: extracted.title || target.title,
      url: target.url,
      charCount: extracted.charCount,
      pages: extracted.pages,
      removed: extracted.removed,
      preview: extracted.content.slice(0, 600),
      content: extracted.content,
    });
  }
  return results;
}

/** 内容近似判重：用于"重复章节自动跳过" */
function isProbablySameChapter(a, b) {
  const norm = (text) =>
    String(text || '')
      .replace(/\s+/g, '')
      .slice(0, 200);
  return norm(a) === norm(b) && norm(a).length > 20;
}

module.exports = {
  id: 'generic-web',
  label: '通用网页抓取',
  KNOWN_CONTENT_SELECTORS,
  NEXT_PAGE_TEXT,
  NEXT_CHAPTER_TEXT,
  buildSelector,
  findTocCandidates,
  findContentCandidates,
  findNextPageControl,
  guessBookMeta,
  probe,
  probeToc,
  extractChapter,
  previewChapters,
  isProbablySameChapter,
  hostOf,
};
