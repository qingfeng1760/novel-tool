'use strict';
/**
 * compliance.js —— 抓取前置合规自检（PRD §9）。
 *
 * 三条前置自检，任一不通过就直接终止，**不提供"我知道有风险但我要继续"的选项**：
 *   1. 目标站 robots.txt 禁止了这个路径 → 拒绝，并指出具体是哪一条规则；
 *   2. 页面有登录墙特征（要登录才能看正文）→ 拒绝；
 *   3. 页面有付费 / VIP / 订阅墙特征 → 拒绝。
 *
 * 另外把 robots 解析结果缓存在内存里：抓整本时每章都要过一遍路径检查，
 * 每次都去拉一遍 robots.txt 既不礼貌也没必要（同一进程内按站点缓存）。
 */

const robotsParser = require('robots-parser');
const { fetchText, originOf } = require('./fetcher/http-client');

/** 我们对外声明的身份。不伪装成浏览器，也不做任何 Cookie 携带。 */
const USER_AGENT = 'NovelTool/1.0';

/** robots.txt 的缓存时长：同一进程里 10 分钟内不重复拉取 */
const ROBOTS_TTL_MS = 10 * 60 * 1000;

/** 登录墙特征 */
const LOGIN_PATTERNS = [
  { re: /请\s*(?:先)?登录(?:后|再)?(?:阅读|查看|继续)?/, label: '页面提示"请登录后阅读"' },
  { re: /登录(?:后|才)(?:可|能)(?:查看|阅读|继续)/, label: '页面提示"登录才能查看"' },
  { re: /(?:会员|账号)?登录(?:页面|窗口|框)?/, label: '出现登录入口' },
  { re: /立即登录|马上登录|去登录|未登录/, label: '出现"立即登录"提示' },
  { re: /<input[^>]+type=["']?password/i, label: '页面里有密码输入框' },
];

/** 付费 / VIP / 订阅墙特征。写窄一点，避免把"最新章节"这类正常标题误判 */
const PAYWALL_PATTERNS = [
  { re: /VIP\s*(?:章节|会员|专享|阅读)/i, label: '标记为 VIP 章节' },
  { re: /(?:本章|该章|此章)(?:为)?付费(?:章节)?/, label: '标记为付费章节' },
  { re: /付费阅读|付费章节|付费内容/, label: '出现"付费阅读"' },
  { re: /(?:开通|成为|升级)\s*VIP|开通会员|加入会员/, label: '要求开通会员' },
  { re: /(?:购买|订阅)(?:本章|全书|本书|后阅读)/, label: '要求购买或订阅' },
  { re: /(?:书币|阅点|金币|余额)\s*(?:不足|不够)/, label: '货币不足提示' },
  { re: /试读(?:结束|完毕)|试读到此为止/, label: '试读结束提示' },
  { re: /本章尚未购买|尚未订阅/, label: '尚未购买提示' },
];

/** robots 缓存：origin -> {at, status, text, parser} */
const robotsCache = new Map();

function detectByList(text, patterns) {
  const evidence = [];
  for (const pattern of patterns) {
    if (pattern.re.test(text)) evidence.push(pattern.label);
  }
  return { detected: evidence.length > 0, evidence };
}

function detectLoginWall(text) {
  return detectByList(String(text || ''), LOGIN_PATTERNS);
}

function detectPaywall(text) {
  return detectByList(String(text || ''), PAYWALL_PATTERNS);
}

/** 拉取并解析 robots.txt（带缓存） */
async function loadRobots(origin, options = {}) {
  const cached = robotsCache.get(origin);
  const now = Date.now();
  if (cached && now - cached.at < ROBOTS_TTL_MS && !options.force) return cached;

  const robotsUrl = `${origin}/robots.txt`;
  let entry = { at: now, url: robotsUrl, status: 0, text: '', parser: null, error: null };
  try {
    const res = await fetchText(robotsUrl, { timeoutMs: 8000 });
    entry = { ...entry, status: res.status, text: res.text };
    // 404 / 403 都按"没有 robots 规则"处理，这也是通行做法：
    // robots.txt 不存在就等于没有限制，而不是等于全面禁止
    if (res.status === 200 && res.text.trim()) {
      entry.parser = robotsParser(robotsUrl, res.text);
    }
  } catch (err) {
    entry.error = err && err.message ? err.message : String(err);
  }
  robotsCache.set(origin, entry);
  return entry;
}

/** 从 robots.txt 原文里把命中规则那一行找出来，好告诉用户"具体是哪条" */
function findRuleText(robotsText, lineNumber) {
  if (!robotsText || !lineNumber) return '';
  const lines = robotsText.split(/\r?\n/);
  // robots-parser 给的行号是从 0 开始的
  const line = lines[lineNumber] || lines[lineNumber - 1];
  return line ? line.trim() : '';
}

/**
 * 判断某个 URL 是否被 robots 允许。
 * @returns {{allowed:boolean, known:boolean, ruleLine:number, ruleText:string, crawlDelay:number|null}}
 */
async function checkRobots(url, options = {}) {
  const origin = originOf(url);
  if (!origin) return { allowed: true, known: false, ruleLine: 0, ruleText: '', crawlDelay: null };

  const entry = await loadRobots(origin, options);
  if (!entry.parser) {
    return {
      allowed: true,
      known: false,
      ruleLine: 0,
      ruleText: '',
      crawlDelay: null,
      robotsUrl: entry.url,
      status: entry.status,
      note: entry.status === 200 ? '这个站点的 robots.txt 里没有相关规则。' : '没有读到 robots.txt（视为不限制）。',
    };
  }

  let allowed = true;
  let lineNumber = 0;
  try {
    const verdict = entry.parser.isAllowed(url, USER_AGENT);
    // isAllowed 可能返回 undefined（没有匹配到规则），这时按允许处理
    allowed = verdict !== false;
    if (!allowed) {
      lineNumber = entry.parser.getMatchingLineNumber(url, USER_AGENT) || 0;
    }
  } catch (err) {
    allowed = true;
  }

  return {
    allowed,
    known: true,
    ruleLine: lineNumber,
    ruleText: findRuleText(entry.text, lineNumber),
    crawlDelay: entry.parser.getCrawlDelay(USER_AGENT) || null,
    robotsUrl: entry.url,
    status: entry.status,
    note: allowed ? 'robots.txt 没有禁止这个路径。' : 'robots.txt 明确禁止了这个路径。',
  };
}

/**
 * 完整的前置自检。
 * @param {string} url
 * @param {{fetchPage?:boolean, timeoutMs?:number}} options
 *   fetchPage: 是否顺带把页面取回来做登录墙/付费墙判断（探测阶段会取，所以可以复用）
 */
async function inspect(url, options = {}) {
  const result = {
    url,
    checkedAt: new Date().toISOString(),
    allowed: true,
    reason: null,
    message: '',
    hint: '',
    robots: null,
    login: { detected: false, evidence: [] },
    paywall: { detected: false, evidence: [] },
    page: null,
  };

  // ---- 0. 只接受 http/https
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    result.allowed = false;
    result.reason = 'bad_url';
    result.message = '这个地址看起来不是一个网址。';
    result.hint = '请复制浏览器地址栏里完整的目录页地址（以 http:// 或 https:// 开头）。';
    return result;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    result.allowed = false;
    result.reason = 'bad_url';
    result.message = `工具只能抓 http 或 https 的网页，这个地址是 ${parsed.protocol}`;
    result.hint = '请换一个网页地址。';
    return result;
  }

  // ---- 1. robots.txt
  let robots;
  try {
    robots = await checkRobots(url, { timeoutMs: options.timeoutMs });
  } catch (err) {
    robots = { allowed: true, known: false, ruleText: '', note: '读取 robots.txt 失败，按不限制处理。' };
  }
  result.robots = robots;
  if (!robots.allowed) {
    result.allowed = false;
    result.reason = 'robots';
    result.message = '目标站点的 robots.txt 明确禁止抓取这个页面，工具不会去抓它。';
    result.hint = robots.ruleText
      ? `命中的规则是第 ${robots.ruleLine + 1} 行：${robots.ruleText}。请换一个允许抓取的站点，或者直接手动把正文复制进「粘贴正文」。`
      : '请换一个允许抓取的站点，或者直接手动把正文复制进「粘贴正文」。';
    return result;
  }

  // ---- 2 / 3. 页面特征
  if (options.fetchPage === false) return result;

  let page;
  try {
    page = await fetchText(url, { timeoutMs: options.timeoutMs });
  } catch (err) {
    result.allowed = false;
    result.reason = 'network';
    result.message = '打不开这个页面。';
    result.hint = '请确认网络能访问这个地址，以及地址粘贴完整；如果这个站点需要登录或已经打不开了，工具也没法抓它。';
    return result;
  }

  result.page = { status: page.status, finalUrl: page.finalUrl, bytes: page.bytes, encoding: page.encoding };

  if (!page.ok) {
    result.allowed = false;
    result.reason = 'http_error';
    result.message = `这个页面返回了 ${page.status}，工具拿不到内容。`;
    result.hint = '请确认链接没有失效；如果这个页面本来就需要登录才能看，工具也不会去绕过它。';
    return result;
  }

  const login = detectLoginWall(page.text);
  const paywall = detectPaywall(page.text);
  result.login = login;
  result.paywall = paywall;

  if (login.detected) {
    result.allowed = false;
    result.reason = 'login';
    result.message = '这个页面要求登录才能看正文，工具不会提供绕过登录的能力，所以不能抓。';
    result.hint = `识别到的特征：${login.evidence.join('、')}。可以改用「粘贴正文」把你自己有权阅读的内容存进来。`;
    return result;
  }

  if (paywall.detected) {
    result.allowed = false;
    result.reason = 'paywall';
    result.message = '这个页面是付费 / VIP / 订阅内容，工具不会提供绕过付费墙的能力，所以不能抓。';
    result.hint = `识别到的特征：${paywall.evidence.join('、')}。可以改用「粘贴正文」把你自己有权阅读的内容存进来。`;
    return result;
  }

  result.message = '合规自检通过：robots.txt 没有禁止，也没有发现登录墙或付费墙。';
  return result;
}

/** 抓取过程中对每一章再做一次路径检查（用缓存，几乎不花时间） */
async function isPathAllowed(url) {
  const robots = await checkRobots(url);
  return robots;
}

function clearRobotsCache() {
  robotsCache.clear();
}

module.exports = {
  USER_AGENT,
  ROBOTS_TTL_MS,
  LOGIN_PATTERNS,
  PAYWALL_PATTERNS,
  detectLoginWall,
  detectPaywall,
  checkRobots,
  inspect,
  isPathAllowed,
  clearRobotsCache,
};
