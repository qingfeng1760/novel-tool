'use strict';
/**
 * routes/importRoute.js —— 模块 7「导入与编码修复」的接口实现。
 *
 * 接口清单（PRD 模块 7）：
 *   POST /api/import/upload            上传 TXT（multipart），返回 task_id
 *   POST /api/import/paste             粘贴正文导入
 *   POST /api/import/analyze           编码检测：候选 + 置信度
 *   POST /api/import/recover           按反向映射链尝试还原乱码
 *   GET  /api/import/preview           三段对照预览（切编码即时刷新）
 *   GET  /api/import/rules             内置分章规则
 *   POST /api/import/preview-chapterize 分章结果预览
 *   POST /api/import/clean-preview     清洗开关效果预览
 *   POST /api/import/commit            校验通过后落库
 *
 * 注意 GET /preview 用查询参数拿字节：前端只需把 upload_id 带上，
 * 不必把 10 MB 的正文在 URL 或请求体里搬来搬去。
 */

const { ApiError } = require('../lib/errors');

module.exports = {
  mount(router, ctx) {
    const importer = ctx.importer;

    router.post('/api/import/upload', async (c) => {
      const contentType = c.headers['content-type'] || '';

      // 主路径：标准 multipart 表单
      if (contentType.includes('multipart/form-data')) {
        const { fields, files } = await c.multipart();
        const file = files.find((f) => f.name === 'file') || files[0];
        if (!file) {
          throw new ApiError(
            'NO_FILE',
            '这次请求里没有带上文件。',
            '请重新选择 TXT 文件后再上传。',
            400
          );
        }
        const result = importer.handleUpload({
          buffer: file.data,
          filename: file.filename,
          content_type: file.contentType,
        });
        // 表单里可以顺带指定书名等，回给前端拼后续的 commit
        return { ...result, fields };
      }

      // 兼容路径：直接把字节当请求体发过来（前端用 FileReader 读到 ArrayBuffer 时更省事）
      const buffer = await c.buffer();
      const filename = decodeURIComponent(c.headers['x-filename'] || '未命名.txt');
      if (!buffer.length) {
        throw new ApiError('EMPTY_UPLOAD', '上传的文件是空的。', '请换一个内容非空的 TXT 文件。', 400);
      }
      return importer.handleUpload({ buffer, filename });
    });

    router.post('/api/import/paste', async (c) => {
      const body = await c.json();
      return importer.handlePaste(body);
    });

    router.post('/api/import/analyze', async (c) => {
      const body = await readPayload(c, importer);
      return importer.analyze(body);
    });

    router.post('/api/import/recover', async (c) => {
      const body = await readPayload(c, importer);
      return importer.recover(body);
    });

    router.get('/api/import/preview', (c) => {
      const payload = {
        upload_id: c.q('upload_id'),
        encoding: c.q('encoding'),
        text: undefined,
        segment_chars: c.qNum('segment_chars', 300),
        compare: c.q('compare') !== 'false',
      };
      if (!payload.upload_id) {
        throw new ApiError(
          'NO_UPLOAD',
          '不知道要预览哪一份内容。',
          '请先选择文件上传，然后再看预览。',
          400
        );
      }
      // GET 时用原始编码名（编码名里的短横线在 URL 里要能安全传递）
      payload.encoding = payload.encoding ? payload.encoding.replace(/\+/g, ' ') : undefined;
      return importer.preview(payload);
    });

    router.get('/api/import/rules', () => importer.rules());

    router.post('/api/import/preview-chapterize', async (c) => {
      const body = await readPayload(c, importer);
      return importer.previewChapterize(body);
    });

    router.post('/api/import/clean-preview', async (c) => {
      const body = await readPayload(c, importer);
      return importer.cleanPreview(body);
    });

    router.post('/api/import/commit', async (c) => {
      const body = await readPayload(c, importer);
      return importer.commit(body);
    });
  },
};

/**
 * 读请求体并把输入归一：
 *   - multipart（前端可以直接把文件和参数一起发过来，省一次暂存往返）
 *   - JSON（upload_id / data_base64 / text）
 */
async function readPayload(c, importer) {
  const contentType = c.headers['content-type'] || '';

  if (contentType.includes('multipart/form-data')) {
    const { fields, files } = await c.multipart();
    const file = files.find((f) => f.name === 'file') || files[0];
    const body = { ...fields };

    // 表单里传进来的布尔/数字都是字符串，这里统一转一下，免得服务端拿到 "false" 当 true
    for (const key of ['segment_chars', 'limit', 'max_line_length']) {
      if (body[key] !== undefined) body[key] = Number(body[key]);
    }
    for (const key of ['compare', 'allow_mojibake', 'force_encoding']) {
      if (body[key] !== undefined) body[key] = body[key] === 'true' || body[key] === '1';
    }
    for (const key of ['clean', 'expected']) {
      if (typeof body[key] === 'string' && body[key]) {
        try {
          body[key] = JSON.parse(body[key]);
        } catch (err) {
          throw new ApiError(
            'BAD_FORM_JSON',
            `表单里的 ${key} 不是合法的格式。`,
            '请刷新页面重新操作一次。',
            400
          );
        }
      }
    }

    if (file) {
      // multipart 直传文件时：先暂存，拿到 upload_id 再走同一条链路，
      // 这样前面的接口（analyze/preview）都不用重复传大文件
      body.upload_id = body.upload_id || importer.saveUpload(file.data, file.filename, file.contentType);
    }
    if (!body.upload_id && !body.text && !body.data_base64) {
      throw new ApiError(
        'NO_CONTENT',
        '这次没有拿到要处理的正文。',
        '请重新选择文件或粘贴正文。',
        400
      );
    }
    return body;
  }

  return c.json();
}
