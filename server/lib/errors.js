'use strict';
/**
 * errors.js —— 统一的错误结构与提示语规范。
 *
 * 为什么这么写：
 * PRD §12 要求"所有面向用户的文案用简体中文、说人话，并且能指导下一步操作"，
 * 不允许出现 `Error: undefined`、堆栈、英文术语裸奔。
 * 所以内部抛错一律用 ApiError，把「给人看的话」和「技术细节」分开：
 *   - message：界面直接展示（必须是人话）
 *   - hint   ：可点击的下一步动作（也是人话）
 *   - code   ：给程序判断用的机器码（不展示给用户）
 */

class ApiError extends Error {
  /**
   * @param {string} code    机器码，例如 'BOOK_NOT_FOUND'
   * @param {string} message 给人看的一句话
   * @param {string} hint    给人看的下一步建议
   * @param {number} status  HTTP 状态码
   */
  constructor(code, message, hint = '', status = 400) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.message = message;
    this.hint = hint;
    this.status = status;
  }

  toPayload() {
    return { code: this.code, message: this.message, hint: this.hint };
  }
}

/** 常用错误的快捷构造，避免每个路由自己编文案导致口径不一致 */
const Errors = {
  badRequest: (message, hint = '请检查输入后重试') =>
    new ApiError('BAD_REQUEST', message, hint, 400),

  notFound: (message, hint = '请返回书架重新选择') =>
    new ApiError('NOT_FOUND', message, hint, 404),

  bookNotFound: (bookId) =>
    new ApiError(
      'BOOK_NOT_FOUND',
      `没有找到这本书（编号 ${bookId}）。`,
      '它可能已被移除，请返回书架刷新列表。',
      404
    ),

  chapterNotFound: (index) =>
    new ApiError(
      'CHAPTER_NOT_FOUND',
      `这本书里没有第 ${index} 章。`,
      '请打开目录重新选择章节。',
      404
    ),

  conflict: (message, hint = '') =>
    new ApiError('CONFLICT', message, hint || '请调整后重试', 409),

  compliance: (message, hint) =>
    new ApiError('COMPLIANCE_REJECTED', message, hint, 403),

  notImplemented: (message = '这个功能在当前版本里还没有开放。', hint = '请等待后续版本更新。') =>
    new ApiError('NOT_IMPLEMENTED', message, hint, 501),

  internal: (message = '工具内部出了点问题。', hint = '请重启工具再试一次；如果一直不行，把这一步的操作告诉开发者。') =>
    new ApiError('INTERNAL_ERROR', message, hint, 500),
};

/**
 * 把任意异常翻译成 ApiError。
 * 这是"绝不出现英文技术术语裸奔"的最后一道保险：未知异常不会把原始堆栈丢给用户。
 */
function toApiError(err) {
  if (err instanceof ApiError) return err;
  const wrapped = Errors.internal();
  wrapped.technical = err && err.message ? String(err.message) : String(err);
  return wrapped;
}

module.exports = { ApiError, Errors, toApiError };
