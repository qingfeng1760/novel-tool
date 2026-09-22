/**
 * api.js —— 前端访问本地服务的唯一通道。
 *
 * 为什么所有请求都从这里走：
 * PRD §4.0 规定后端统一响应体 `{ok:true,data}` / `{ok:false,error:{code,message,hint}}`。
 * 前端只在这里解一次包，其它模块拿到的一定是 data，或者一个带 message/hint 的 Error。
 * 这样就不会出现界面上显示 `undefined`、或者把英文堆栈露给用户的情况。
 */

/** 后端返回的业务错误。message 给用户看，hint 是下一步建议。 */
export class ApiError extends Error {
  constructor({ code, message, hint }) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.hint = hint;
  }
}

async function request(method, path, body, options = {}) {
  const init = { method, headers: {} };

  if (body !== undefined) {
    if (body instanceof FormData) {
      // FormData 让浏览器自己带 boundary，手动设 Content-Type 反而会坏掉
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json; charset=utf-8';
      init.body = JSON.stringify(body);
    }
  }

  let res;
  try {
    res = await fetch(path, init);
  } catch (err) {
    // 服务没起来时 fetch 会直接抛错，这里换成能指导下一步的中文提示
    throw new ApiError({
      code: 'OFFLINE',
      message: '连接不上本地服务。',
      hint: '请确认启动.bat 的窗口还开着；如果关掉了，请重新双击启动.bat。',
    });
  }

  const contentType = res.headers.get('content-type') || '';

  // 二进制下载（导出书 / 导出备份）直接交出 blob
  if (options.raw) {
    if (!res.ok) {
      throw new ApiError({
        code: 'EXPORT_FAILED',
        message: '导出失败了。',
        hint: '请稍后重试。',
      });
    }
    return res.blob();
  }

  if (!contentType.includes('application/json')) {
    throw new ApiError({
      code: 'BAD_RESPONSE',
      message: '本地服务返回了看不懂的内容。',
      hint: '请关掉启动窗口重新双击启动.bat。',
    });
  }

  const payload = await res.json();
  if (!payload || payload.ok !== true) {
    const error = (payload && payload.error) || {};
    throw new ApiError({
      code: error.code || 'UNKNOWN',
      message: error.message || '这一步没能完成。',
      hint: error.hint || '请重试一次。',
    });
  }
  return payload.data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  put: (path, body) => request('PUT', path, body),
  patch: (path, body) => request('PATCH', path, body),
  del: (path, body) => request('DELETE', path, body),
  blob: (path) => request('GET', path, undefined, { raw: true }),
};

/** 拼查询串，自动丢掉空值 */
export function qs(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? '?' + text : '';
}
