'use strict';
/**
 * http-utils.js —— HTTP 请求 / 响应的公共处理。
 *
 * 为什么这么写：
 * PRD §4.0 规定"统一响应体"：成功 `{ok:true,data}`，失败 `{ok:false,error:{code,message,hint}}`。
 * 所有路由都走这里的 sendOk / sendError，就不会出现某个接口偷偷返回别的形状，
 * 前端也只需要认一种结构。
 */

const { ApiError, toApiError } = require('./errors');

/** 默认请求体上限：单章正文 + 粘贴导入，32 MB 足够，也顺手挡住异常大的请求 */
const DEFAULT_BODY_LIMIT = 32 * 1024 * 1024;

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    // 本地工具不需要被搜索引擎/缓存干扰；顺便禁止浏览器做 MIME 嗅探
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/** 成功：{ ok: true, data } */
function sendOk(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

/** 失败：{ ok: false, error: { code, message, hint } } */
function sendError(res, err) {
  const apiError = toApiError(err);
  // 技术细节只打到控制台，绝不返回给界面（PRD §12 禁止堆栈/英文裸奔）
  if (apiError.technical) {
    console.error('[内部错误]', apiError.code, apiError.technical);
  }
  sendJson(res, apiError.status || 500, { ok: false, error: apiError.toPayload() });
}

/** 读取完整请求体到 Buffer，超限直接抛 413 语义的中文错误 */
function readBody(req, limit = DEFAULT_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(
          new ApiError(
            'PAYLOAD_TOO_LARGE',
            '这次要传的内容太大了（超过 32 MB）。',
            '请把文件拆小一点再导入，比如按卷拆分。',
            413
          )
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) =>
      reject(
        new ApiError('BODY_READ_FAILED', '读取上传内容失败，连接可能被中断了。', '请重新试一次。', 400)
      ) || reject(err)
    );
  });
}

/** 解析 JSON 请求体；空体视为空对象，坏 JSON 给人话提示 */
function parseJsonBody(buf) {
  if (!buf || buf.length === 0) return {};
  const text = buf.toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ApiError(
      'BAD_JSON',
      '这次提交的数据格式不对，工具读不懂。',
      '请刷新页面后重新操作一次。',
      400
    );
  }
}

/**
 * 发一个文件给浏览器下载。
 *
 * 文件名用 RFC 5987 的 filename* 形式，这样中文书名（比如「剑来.txt」）
 * 在 Chrome / Edge 里不会变成乱码；同时保留普通 filename 给老浏览器兜底。
 */
function sendFile(res, { filename, contentType = 'application/octet-stream', buffer, extraHeaders = {} }) {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const asciiName = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Content-Disposition':
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(body);
}

module.exports = {
  DEFAULT_BODY_LIMIT,
  sendJson,
  sendOk,
  sendError,
  sendFile,
  readBody,
  parseJsonBody,
};
