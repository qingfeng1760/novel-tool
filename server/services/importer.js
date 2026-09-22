'use strict';
/**
 * importer.js —— 导入流水线（PRD 模块 7 / 流程 B）。
 *
 * 完整链路：
 *   上传/粘贴 → 编码检测（候选+置信度）→ 三段对照预览（必要时乱码还原）
 *   → 分章预览（可改正则）→ 清洗开关（默认关）→ 章节数校验 → 落库 → 跳详情页
 *
 * 硬规则（PRD 模块 7）：
 *   - 绝不允许在预览不正确的情况下静默采用某个编码 —— 检测不自信时，
 *     commit 会拒绝落库并要求显式指定编码；
 *   - 章节数与标题逐字一致才落库，不一致就报警并保留原文件不动；
 *   - 解不了就明说"这个文件我解不了"，并给出原始编码猜测，绝不产出半乱码成品。
 */

const path = require('path');
const fs = require('fs');
const { ApiError } = require('../lib/errors');
const encoding = require('./encoding');
const chapterize = require('./chapterize');
const cleaner = require('./cleaner');

/** 上传文件的暂存目录：只放"还没确定要导入"的原始字节，不算用户数据 */
const STAGING_DIR = '.staging';

/** 原始文件最多暂存多久（超过就当成用户中途放弃，启动时清掉） */
const STAGING_TTL_MS = 2 * 60 * 60 * 1000;

module.exports = function createImporterService(ctx) {
  const io = ctx.storage;

  // ---------------------------------------------------------------- 暂存区

  function stagingRel(uploadId) {
    return path.posix.join(STAGING_DIR, `${uploadId}.bin`);
  }
  function stagingMetaRel(uploadId) {
    return path.posix.join(STAGING_DIR, `${uploadId}.json`);
  }

  function saveUpload(buffer, filename, contentType) {
    const uploadId = io.generateId('up');
    io.ensureDir(STAGING_DIR);
    io.writeBuffer(stagingRel(uploadId), buffer);
    io.writeJson(stagingMetaRel(uploadId), {
      upload_id: uploadId,
      filename: filename || '未命名.txt',
      content_type: contentType || 'application/octet-stream',
      size: buffer.length,
      created_at: new Date().toISOString(),
    });
    return uploadId;
  }

  function readUpload(uploadId) {
    const buffer = io.readBuffer(stagingRel(uploadId));
    if (!buffer) {
      throw new ApiError(
        'UPLOAD_EXPIRED',
        '这次上传的内容已经过期了，工具找不到它。',
        '请重新选择文件上传一次。',
        410
      );
    }
    return buffer;
  }

  function uploadMeta(uploadId) {
    return io.readJson(stagingMetaRel(uploadId), null);
  }

  function dropUpload(uploadId) {
    io.remove(stagingRel(uploadId));
    io.remove(stagingMetaRel(uploadId));
  }

  /** 启动时清掉残留的暂存文件（用户中途关窗口留下的） */
  function cleanupStaging(now = Date.now()) {
    let removed = 0;
    for (const name of io.listDir(STAGING_DIR)) {
      const rel = path.posix.join(STAGING_DIR, name);
      if (name.endsWith('.json')) {
        const meta = io.readJson(rel, null);
        const created = meta && meta.created_at ? new Date(meta.created_at).getTime() : 0;
        if (!created || now - created > STAGING_TTL_MS) {
          const base = name.replace(/\.json$/, '');
          dropUpload(base);
          removed++;
        }
      } else if (name.endsWith('.bin')) {
        const base = name.replace(/\.bin$/, '');
        if (!io.exists(stagingMetaRel(base))) {
          io.remove(rel);
          removed++;
        }
      }
    }
    return removed;
  }

  // ---------------------------------------------------------------- 输入归一

  /**
   * 把各种输入统一成 { text, encoding, buffer, detection }。
   * 支持三种来源：已暂存的上传、前端直传的 base64、直接粘贴的文本。
   */
  function resolveSource(payload = {}) {
    const requested = payload.encoding || payload.encoding_name;

    // 1. 直接粘贴的文本：本来就是字符串，没有"编码"问题
    if (typeof payload.text === 'string') {
      return {
        kind: 'text',
        buffer: null,
        text: payload.text,
        encoding: 'UTF-8',
        detection: null,
        from_text: true,
      };
    }

    // 2. 取字节流：暂存文件优先，其次 base64
    let buffer = null;
    let meta = null;
    if (payload.upload_id) {
      buffer = readUpload(payload.upload_id);
      meta = uploadMeta(payload.upload_id);
    } else if (payload.data_base64) {
      buffer = Buffer.from(String(payload.data_base64), 'base64');
    } else if (payload.data) {
      buffer = Buffer.isBuffer(payload.data) ? payload.data : Buffer.from(payload.data);
    }

    if (!buffer) {
      throw new ApiError(
        'NO_CONTENT',
        '这次没有拿到要导入的内容。',
        '请重新选择文件，或者把正文粘贴进来。',
        400
      );
    }

    const detection = encoding.detect(buffer);
    // 用户明确指定了就听用户的；否则用检测结果（检测不自信时也要用它先把预览显示出来）
    const chosen = requested || detection.encoding;
    if (!encoding.SUPPORTED_ENCODINGS.includes(chosen)) {
      throw new ApiError(
        'UNSUPPORTED_ENCODING',
        `工具不支持「${chosen}」这种编码。`,
        `目前可用的是：${encoding.SUPPORTED_ENCODINGS.join('、')}。`,
        400
      );
    }

    const text = encoding.decode(buffer, chosen);
    return {
      kind: 'file',
      buffer,
      text,
      encoding: chosen,
      detection,
      meta,
      from_text: false,
      /** 用户是不是明确指定了编码（决定 commit 时要不要卡"猜不准不许落库"） */
      explicit_encoding: Boolean(requested),
    };
  }

  // ---------------------------------------------------------------- 各步骤

  /** 编码检测：候选、置信度、是否乱码、能不能还原 */
  function analyze(payload = {}) {
    const source = resolveSource(payload);
    const signs = encoding.inspectMojibake(source.text);
    const recovery = signs.mojibake ? encoding.recover(source.text) : null;

    return {
      encoding: source.encoding,
      detection: source.detection,
      from_text: source.from_text,
      size: source.buffer ? source.buffer.length : Buffer.byteLength(source.text, 'utf8'),
      hasBom: source.detection ? Boolean(source.detection.bom) : false,
      /** 检测不自信时，界面必须让用户自己选，不能偷偷替他决定 */
      needs_user_choice: Boolean(source.detection && !source.detection.confident && !source.explicit_encoding),
      mojibake: signs,
      recovery,
      meta: source.meta,
    };
  }

  /** 乱码一键还原 */
  function recover(payload = {}) {
    const source = resolveSource(payload);
    const result = encoding.recover(source.text);

    // 原始编码猜测有两个来源：
    //   1. 有字节流时，用检测出来的候选（最可靠）；
    //   2. 只有粘贴文本时，从乱码的长相反推（猜得没那么准，但比"未知"有用）。
    const fromDetection = source.detection
      ? source.detection.candidates.map((c) => c.encoding)
      : [];
    const fromText = encoding.guessOriginalEncodings(source.text);
    const guess = [...new Set([...fromDetection, ...fromText])].slice(0, 3);

    return {
      ...result,
      original_encoding: source.encoding,
      original_guess: guess,
    };
  }

  /** 三段对照预览：同一段字节按不同编码解出来对比，切编码即时刷新 */
  function preview(payload = {}) {
    const source = resolveSource(payload);
    const requested = payload.encoding;

    let encodingName = source.encoding;
    if (requested && encoding.SUPPORTED_ENCODINGS.includes(requested)) encodingName = requested;

    // 没有字节流（纯粘贴文本）时，只能对文本本身取三段
    const segments = source.buffer
      ? encoding.previewSegments(source.buffer, encodingName, { segmentChars: payload.segment_chars || 300 })
      : cleaner.segments(source.text, payload.segment_chars || 300);

    // 顺便把"换成别的编码会变成什么样"的第一段也给出来，方便用户对照着选
    const alternatives = [];
    if (source.buffer && payload.compare !== false) {
      const list = (source.detection && source.detection.candidates.length
        ? source.detection.candidates.map((c) => c.encoding)
        : encoding.SUPPORTED_ENCODINGS
      )
        .filter((name) => name !== encodingName)
        .slice(0, 4);
      for (const name of list) {
        let text = '';
        try {
          text = encoding.decode(source.buffer.subarray(0, 240), name);
        } catch (err) {
          text = '';
        }
        alternatives.push({ encoding: name, sample: text.slice(0, 120) });
      }
    }

    const joined = segments.map((s) => s.text).join('\n');
    return {
      encoding: encodingName,
      detection: source.detection,
      segments,
      alternatives,
      mojibake: encoding.inspectMojibake(joined),
      totalChars: source.text.replace(/\s/g, '').length,
    };
  }

  /** 内置分章规则列表（模块 7 / 模块 4 共用） */
  function rules() {
    return {
      rules: chapterize.RULES.map((r) => ({
        id: r.id,
        label: r.label,
        description: r.description,
        pattern: r.pattern,
      })),
      default: chapterize.DEFAULT_RULE_ID,
      maxLineLength: chapterize.DEFAULT_MAX_LINE_LENGTH,
    };
  }

  /** 分章结果预览 */
  function previewChapterize(payload = {}) {
    const source = resolveSource(payload);
    const result = chapterize.previewChapterize(source.text, {
      ruleId: payload.rule_id || payload.ruleId,
      pattern: payload.pattern,
      flags: payload.flags,
      maxLineLength: payload.max_line_length,
      limit: payload.limit,
    });
    return {
      ...result,
      encoding: source.encoding,
      clean: payload.clean ? cleaner.clean(source.text, payload.clean).stats : null,
    };
  }

  /** 清洗开关效果预览 + 改动字符数 */
  function cleanPreview(payload = {}) {
    const source = resolveSource(payload);
    const switches = payload.clean || payload.switches || {};
    const result = cleaner.clean(source.text, switches);
    return {
      changedChars: result.changedChars,
      stats: result.stats,
      removals: result.removals,
      removalsTruncated: result.removalsTruncated,
      before: cleaner.segments(source.text, payload.segment_chars || 300),
      after: cleaner.segments(result.text, payload.segment_chars || 300),
      encoding: source.encoding,
    };
  }

  /**
   * 落库。
   * 顺序（每一步失败都会中断并保留原文件不动）：
   *   解码 → 分章 → 清洗 → 章节数校验 → 建书 → 写章节 → 更新元数据 → 清暂存
   */
  function commit(payload = {}) {
    const source = resolveSource(payload);

    // 关卡 1：检测不自信、用户又没指定编码时，拒绝落库（PRD 硬规则）
    if (
      source.detection &&
      !source.detection.confident &&
      !source.explicit_encoding &&
      payload.force_encoding !== true
    ) {
      throw new ApiError(
        'ENCODING_NOT_CONFIRMED',
        `没能确定这份内容的编码（最像 ${source.detection.encoding}，但把握不大）。`,
        '请先在预览里挑一个读起来正常的编码，再点导入。',
        409
      );
    }

    if (source.detection && source.detection.bom !== undefined) {
      // 说明：这里只做读取，不做修改，保留这行是为了让 BOM 的处理路径一目了然
    }

    // 关卡 2：乱码不可恢复时不允许落库
    const signs = encoding.inspectMojibake(source.text);
    if (signs.fatal && payload.allow_mojibake !== true) {
      const guess = [
        ...new Set([
          ...(source.detection ? source.detection.candidates.map((c) => c.encoding) : []),
          ...encoding.guessOriginalEncodings(source.text),
        ]),
      ]
        .slice(0, 3)
        .join('、');
      throw new ApiError(
        'MOJIBAKE_UNRECOVERABLE',
        '这个文件我解不了：内容里有已经丢失掉的字符（出现了「锟斤拷」这类标记）。',
        `它原本可能是 ${guess} 中的一种。请换一份原始文件，不要复制已经被别的程序显示坏了的文本。`,
        422
      );
    }

    // 分章
    const chaptered = chapterize.chapterize(source.text, {
      ruleId: payload.rule_id || payload.ruleId,
      pattern: payload.pattern,
      flags: payload.flags,
      maxLineLength: payload.max_line_length,
    });

    // 清洗（默认不开）
    let chapters = chaptered.chapters;
    let cleanResult = null;
    const switches = payload.clean || payload.switches;
    if (switches && Object.values(switches).some(Boolean)) {
      chapters = chapters.map((ch) => {
        const cleaned = cleaner.clean(ch.content, switches);
        return { ...ch, content: cleaned.text, char_count: cleaned.text.replace(/\s/g, '').length };
      });
      cleanResult = cleaner.clean(source.text, switches);
    }

    if (!chapters.length) {
      throw new ApiError(
        'NOTHING_TO_IMPORT',
        '这份内容里没有任何可以导入的文字。',
        '请确认文件不是空的，或者换一个 TXT 文件再试。',
        400
      );
    }

    // 关卡 3：章节数与标题逐字校验（PRD 硬规则）
    const verify = chapterize.verifyChapters(chapters, payload.expected);
    if (!verify.ok) {
      throw new ApiError(
        'CHAPTER_VERIFY_FAILED',
        `转换前后的章节对不上，已经停下来没有写入：${verify.problems[0]}`,
        '你的原始文件没有被改动。请重新做一次分章预览，然后再导入。',
        409
      );
    }

    // 建书
    const filename = (source.meta && source.meta.filename) || payload.filename || '';
    const fallbackTitle = filename
      ? filename.replace(/\.[^.]*$/, '')
      : chapters[0] && !chapters[0].is_preface
        ? chapters[0].title
        : '未命名导入';
    const title = String(payload.title || '').trim() || fallbackTitle;

    const { book, created } = ctx.library.create(
      {
        title,
        author: payload.author || '',
        tags: payload.tags || [],
        source_site: payload.source_site || 'local',
        source_kind: 'local',
        intro: payload.intro || '',
        fetch_status: '完成',
        status: '未读',
      },
      { onExists: payload.on_exists || 'return' }
    );

    // 写章节
    ctx.library.writeChapters(
      book.book_id,
      chapters.map((ch) => ({
        index: ch.index,
        title: ch.title,
        content: ch.content,
        is_ok: true,
        origin: 'import',
      })),
      { origin: 'import' }
    );

    const saved = ctx.library.patch(book.book_id, {
      fetch_status: '完成',
      source_kind: 'local',
    });

    // 全文索引增量更新（S6 提供；这里用可选调用，保证 S2 阶段不依赖 S6 也能跑）
    if (ctx.search && typeof ctx.search.indexBook === 'function') {
      try {
        ctx.search.indexBook(book.book_id);
      } catch (err) {
        // 索引只是加速器，坏了不该挡住导入这件正事
        console.error('[索引更新失败，不影响导入]', err.message);
      }
    }

    // 落库成功才清暂存
    if (payload.upload_id) dropUpload(payload.upload_id);

    return {
      book: saved,
      created,
      chapterCount: chapters.length,
      matched_rule: chaptered.rule,
      matched_titles: chaptered.matched,
      clean: cleanResult
        ? { changedChars: cleanResult.changedChars, stats: cleanResult.stats, removals: cleanResult.removals.slice(0, 50) }
        : null,
      encoding: source.encoding,
      title,
    };
  }

  /**
   * 上传接口的落点：存字节 + 立刻做一次编码检测，返回 task_id 供轮询/串联后续步骤。
   */
  function handleUpload(payload = {}) {
    const buffer = payload.buffer || Buffer.alloc(0);
    if (!buffer.length) {
      throw new ApiError('EMPTY_UPLOAD', '上传的文件是空的。', '请换一个内容非空的 TXT 文件。', 400);
    }

    const filename = payload.filename || '未命名.txt';
    const task = ctx.tasks.create({
      type: 'import',
      title: `导入《${filename.replace(/\.[^.]*$/, '')}》`,
      total: 1,
      payload: { filename },
    });
    ctx.tasks.update(task.id, { status: 'running', message: '正在识别编码…' });

    const uploadId = saveUpload(buffer, filename, payload.content_type);
    const detection = encoding.detect(buffer);
    const text = encoding.decode(buffer, detection.encoding);
    const signs = encoding.inspectMojibake(text);

    ctx.tasks.bump(task.id, { done: 1, total: 1 });
    ctx.tasks.finish(task.id, { message: '编码已识别，等待确认后导入。' });

    return {
      task_id: task.id,
      upload_id: uploadId,
      filename,
      size: buffer.length,
      encoding: detection.encoding,
      confidence: detection.confidence,
      confident: detection.confident,
      needs_user_choice: !detection.confident,
      candidates: detection.candidates,
      bom: detection.bom,
      mojibake: signs,
      /** 直接给一段开头预览，用户不用再点一次就能看出编码对不对 */
      sample: text.slice(0, 400),
      task: ctx.tasks.get(task.id),
    };
  }

  /** 粘贴正文导入（与文件导入共用同一条落库链路） */
  function handlePaste(payload = {}) {
    if (typeof payload.text !== 'string' || !payload.text.trim()) {
      throw new ApiError('EMPTY_PASTE', '粘贴框里还没有内容。', '请先复制正文再粘贴进来。', 400);
    }
    return commit({ ...payload, text: payload.text });
  }

  return {
    STAGING_DIR,
    STAGING_TTL_MS,
    saveUpload,
    readUpload,
    uploadMeta,
    dropUpload,
    cleanupStaging,
    resolveSource,
    analyze,
    recover,
    preview,
    rules,
    previewChapterize,
    cleanPreview,
    commit,
    handleUpload,
    handlePaste,
    // 让路由层能直接用三段预览/清洗的能力
    segments: cleaner.segments,
  };
};

module.exports.STAGING_DIR = STAGING_DIR;
// 启动时清理暂存目录要用到（context 层调用）
module.exports.cleanupStagingDir = function cleanupStagingDir(dataDir) {
  const dir = path.join(dataDir, STAGING_DIR);
  if (!fs.existsSync(dir)) return 0;
  const names = fs.readdirSync(dir);
  fs.rmSync(dir, { recursive: true, force: true });
  return names.length;
};
