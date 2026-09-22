'use strict';
/**
 * static.js —— 把 web/ 目录当静态站点发出去。
 *
 * 为什么自己写：
 * 硬约束 3 明确"不要 CDN、不要远程字体"，所以所有前端资源都必须由本地服务发出；
 * 我们只需要 GET + 正确 MIME + 防目录穿越这三件事，不必引入静态中间件。
 */

const fs = require('fs');
const path = require('path');
const { safeJoin } = require('./paths');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.user.js': 'text/javascript; charset=utf-8',
};

function contentTypeFor(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.user.js')) return MIME['.user.js'];
  return MIME[path.extname(lower)] || 'application/octet-stream';
}

/**
 * 尝试把请求路径映射成 webRoot 下的真实文件。
 * @returns {{filePath:string, stat:fs.Stats}|null}
 */
function resolveStatic(webRoot, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 允许 /reader.html、/assets/app.js 这类路径；禁止任何 ../ 逃逸
  let target;
  try {
    target = safeJoin(webRoot, rel.replace(/^\/+/, ''));
  } catch (err) {
    return null;
  }
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      const indexFile = path.join(target, 'index.html');
      if (fs.existsSync(indexFile)) {
        return { filePath: indexFile, stat: fs.statSync(indexFile) };
      }
      return null;
    }
    return { filePath: target, stat };
  } catch (err) {
    return null;
  }
}

/** 真正写响应。返回 true 表示已处理。 */
function serveStatic(webRoot, pathname, res) {
  const hit = resolveStatic(webRoot, pathname);
  if (!hit) return false;
  const body = fs.readFileSync(hit.filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(hit.filePath),
    'Content-Length': body.length,
    // 本地工具开发迭代频繁，禁掉缓存免得改完看不到效果
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
  return true;
}

module.exports = { serveStatic, resolveStatic, contentTypeFor, MIME };
