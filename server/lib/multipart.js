'use strict';
/**
 * multipart.js —— 极简 multipart/form-data 解析。
 *
 * 为什么会需要：
 * PRD 模块 7 要求 `POST /api/import/upload` 走 multipart 上传 TXT。
 * 浏览器原生 FormData 只会发 multipart，而我们不想为了一个上传接口引入 multer/busboy。
 * 这里只实现"够用且正确"的子集：
 *   - 支持多个 name/value 字段；
 *   - 支持 filename（文件字段），内容按二进制保留（TXT 编码千奇百怪，绝不能当字符串处理）；
 *   - 不处理嵌套、不处理多段同名（后出现的覆盖前面的）。
 *
 * 关键正确性点：分隔符必须以 CRLF 作为前缀定位，否则正文里恰好出现 "--boundary"
 * 字样时会被误判为分隔符。
 */

const { ApiError } = require('./errors');

/** 从 Content-Type 头里取出 boundary */
function getBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  return (m[1] || m[2] || '').trim();
}

/** 收集 buffer 中所有 delimiter 出现的位置 */
function indexOfAll(buffer, delimiter, start = 0) {
  const positions = [];
  let idx = buffer.indexOf(delimiter, start);
  while (idx !== -1) {
    positions.push(idx);
    idx = buffer.indexOf(delimiter, idx + delimiter.length);
  }
  return positions;
}

/**
 * 解析 multipart 请求体。
 * @param {Buffer} buffer  完整请求体
 * @param {string} contentType 请求的 Content-Type
 * @returns {{fields:Object<string,string>, files:Array<{name:string,filename:string,contentType:string,data:Buffer}>}}
 */
function parseMultipart(buffer, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw new ApiError(
      'BAD_MULTIPART',
      '上传的数据缺少分隔标识，工具没法拆开它。',
      '请刷新页面后重新选择文件上传。',
      400
    );
  }

  const CRLF = Buffer.from('\r\n');
  const delimiter = Buffer.from('--' + boundary);
  const positions = indexOfAll(buffer, delimiter);
  if (positions.length < 2) {
    throw new ApiError(
      'BAD_MULTIPART',
      '上传的数据不完整，工具没能读到文件内容。',
      '请重新选择文件再上传一次。',
      400
    );
  }

  const fields = {};
  const files = [];

  for (let i = 0; i < positions.length - 1; i++) {
    const start = positions[i] + delimiter.length;
    const end = positions[i + 1];
    let part = buffer.subarray(start, end);
    // 结尾处是 "--" 表示整体结束，不再是内容段
    if (part.length >= 2 && part[0] === 0x2d && part[1] === 0x2d) break;
    // 去掉紧跟分隔符的 CRLF
    if (part.length >= 2 && part[0] === 0x0d && part[1] === 0x0a) part = part.subarray(2);
    // 去掉靠近下一个分隔符的 CRLF
    if (part.length >= 2 && part[part.length - 2] === 0x0d && part[part.length - 1] === 0x0a) {
      part = part.subarray(0, part.length - 2);
    }

    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const headerText = part.subarray(0, headerEnd).toString('utf8');
    const body = part.subarray(headerEnd + 4);

    const disposition = /content-disposition:[^\n]*/i.exec(headerText);
    if (!disposition) continue;
    const nameMatch = /name="([^"]*)"/i.exec(disposition[0]);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const filenameMatch = /filename="([^"]*)"/i.exec(disposition[0]);
    const typeMatch = /content-type:\s*([^\r\n;]+)/i.exec(headerText);

    if (filenameMatch) {
      files.push({
        name,
        // 有些浏览器会把文件名按 RFC 5987 编码，这里只取呈现用名，落库不依赖它
        filename: filenameMatch[1] || '未命名.txt',
        contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data: Buffer.from(body),
      });
    } else {
      fields[name] = body.toString('utf8');
    }
  }

  return { fields, files };
}

module.exports = { parseMultipart, getBoundary };
