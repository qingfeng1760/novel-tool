'use strict';
/**
 * http-client.js —— 抓取用的 HTTP 客户端。
 *
 * 直接用 Node 自带的 fetch，但补齐三件本地工具必须自己管的事：
 *   1. **按字节取回再自己解码**。很多小说站是 GBK 页面，
 *      交给 fetch 的 res.text() 会按 UTF-8 解出一堆乱码。所以取 arrayBuffer，
 *      再用我们自己的 encoding 服务检测 + 解码（和导入那条路共用同一套逻辑）。
 *   2. 超时。默认 20 秒，否则一个卡住的请求会把整个抓取任务吊死。
 *   3. 明确的 User-Agent 与 Referer，不做任何伪装（不是浏览器模拟，也不碰 Cookie）。
 *
 * 合规约束（PRD §9）：这里不做任何接口逆向、参数破解、验证码识别；
 * 只按普通 GET 请求公开页面，能不能抓由 compliance 服务先判断。
 */

const encoding = require('../encoding');

const DEFAULT_TIMEOUT_MS = 20000;
/**
 * User-Agent。
 * 注意：HTTP 头的值只能是 Latin-1 字节，写中文会在 fetch 里直接抛错
 * （"Cannot convert argument to a ByteString"），所以这里一律用 ASCII。
 */
const DEFAULT_UA = 'NovelTool/1.0 (local personal reader; +offline)';

/**
 * @param {string} url
 * @param {{timeoutMs?:number, referer?:string, userAgent?:string}} options
 * @returns {Promise<{status:number, ok:boolean, url:string, finalUrl:string, text:string,
 *                    bytes:number, encoding:string, contentType:string, headers:Object}>}
 */
async function fetchText(url, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'User-Agent': options.userAgent || DEFAULT_UA,
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  // Referer 只用来通过正常的防盗链，不携带任何用户身份
  if (options.referer) headers.Referer = options.referer;

  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') || '';

    let text = '';
    let usedEncoding = 'UTF-8';
    try {
      // 先看 HTTP 头里有没有明说编码
      const declared = /charset=["']?([\w-]+)/i.exec(contentType);
      const declaredName = declared ? normalizeDeclared(declared[1]) : null;
      if (declaredName) {
        text = encoding.decode(buffer, declaredName);
        usedEncoding = declaredName;
      } else {
        const detected = encoding.detect(buffer);
        usedEncoding = detected.encoding;
        text = encoding.decode(buffer, detected.encoding);
      }
    } catch (err) {
      // 解码彻底失败也要能继续：至少让上层的"登录墙/付费墙"检测能看到里面的英文关键字
      text = buffer.toString('utf8');
      usedEncoding = 'UTF-8(降级)';
    }

    return {
      status: res.status,
      ok: res.ok,
      url,
      finalUrl: res.url || url,
      text,
      bytes: buffer.length,
      encoding: usedEncoding,
      contentType,
      headers: Object.fromEntries(res.headers.entries()),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 把 HTTP 头里声明的编码名对齐到我们支持的 7 种 */
function normalizeDeclared(name) {
  const key = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const map = {
    UTF8: 'UTF-8',
    GBK: 'GBK',
    GB2312: 'GBK',
    GB18030: 'GB18030',
    BIG5: 'BIG5',
    UTF16LE: 'UTF-16LE',
    UTF16BE: 'UTF-16BE',
  };
  return map[key] || null;
}

/** 只取 URL 的 host（拿来做同域限速） */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (err) {
    return '';
  }
}

/** 解析成绝对地址 */
function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString();
  } catch (err) {
    return null;
  }
}

/** 取站点根地址（robots.txt 要拼在它下面） */
function originOf(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (err) {
    return '';
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_UA,
  fetchText,
  hostOf,
  originOf,
  resolveUrl,
  normalizeDeclared,
};
