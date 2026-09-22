'use strict';
/**
 * chapterize.js —— 自动分章（PRD 模块 7、模块 4）。
 *
 * 设计取舍：
 *   1. 只认"整行就是一个章节头"的行。正文里出现"他翻到第三章"这种句子极其常见，
 *      如果做全文匹配，就会把正文切成碎片。所以匹配后还要过两道闸：
 *      ① 整行长度不能太长；② 标题部分不能带句末标点（。！？；）。
 *   2. 第一行章节头之前的内容绝不丢弃 —— 很多 TXT 开头是"内容简介 / 作者的话"，
 *      直接扔掉会让用户莫名其妙少一段。所以它会被单独存成「卷首」。
 *   3. 一条都匹配不到时不猜、不硬切，老老实实返回"整篇一章"，
 *      由界面提示用户去用自定义正则（PRD 要求分章规则可配置）。
 */

const { ApiError } = require('../lib/errors');

/** 中文数字 + 阿拉伯数字（含全角数字） */
const NUM = '[0-9０-９零〇一二三四五六七八九十百千万两]';

/** 章节头主体：第X章 / 第X节 / Chapter N / 序章一类 */
const HEAD =
  `第\\s*${NUM}{1,12}\\s*[章回节卷篇集部]` +
  '|Chapter\\s*\\d{1,5}' +
  '|(?:序章|序言|自序|楔子|引子|前言|后记|尾声|终章|大结局|外篇|番外(?:篇)?)';

/** 默认规则：允许行首带 Markdown 井号，也允许"第 1 章：标题"这类分隔符 */
const DEFAULT_PATTERN = `^\\s*(?:#{1,4}\\s*)?(${HEAD})\\s*[：:、.．\\-—]?\\s*(.*?)\\s*$`;

/** 整行超过这个长度就不当章节头（正文句子误伤的主要防线） */
const DEFAULT_MAX_LINE_LENGTH = 60;
/** 标题部分（去掉"第X章"之后）允许的最大长度 */
const MAX_TITLE_LENGTH = 45;

/** 内置分章规则（PRD 明确要求含「第X章」「第X节」「Chapter N」「序章/番外/尾声」） */
const RULES = [
  {
    id: 'default',
    label: '通用规则（推荐）',
    description: '识别「第X章」「第X回」「第X节」「Chapter N」「序章 / 楔子 / 番外 / 尾声」等常见章节头。',
    pattern: DEFAULT_PATTERN,
  },
  {
    id: 'chapter-only',
    label: '只认「第X章」',
    description: '只把「第X章」当章节头，适合回目、小节标题很多的文本。',
    pattern: `^\\s*(?:#{1,4}\\s*)?(第\\s*${NUM}{1,12}\\s*章)\\s*[：:、.．\\-—]?\\s*(.*?)\\s*$`,
  },
  {
    id: 'with-number',
    label: '阿拉伯数字编号',
    description: '识别「1. 标题」「001、标题」这类纯数字编号的章节头。',
    pattern: '^\\s*(\\d{1,4})\\s*[.．、:：]\\s*(\\S.{0,44})\\s*$',
  },
  {
    id: 'markdown',
    label: 'Markdown 标题',
    description: '识别「# 标题」「## 标题」这类 Markdown 标题行。',
    pattern: '^\\s*(#{1,4})\\s+(\\S.{0,44})\\s*$',
  },
];

const DEFAULT_RULE_ID = 'default';

/** 句末标点：标题里出现这些基本可以断定是正文而不是章节名 */
const SENTENCE_END = /[。！？；…]$/;

/** 编译自定义正则，语法错误时给出人话 */
function compilePattern(pattern, flags = '') {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new ApiError(
      'BAD_CHAPTER_PATTERN',
      '这个分章规则写得不对，工具没法按它切分。',
      '请检查括号和特殊符号是否配对，或者直接用内置规则。',
      400
    );
  }
}

/** 取一条规则；支持传 ruleId 或直接传自定义 pattern */
function resolveRule(options = {}) {
  if (options.pattern) {
    return {
      id: 'custom',
      label: '自定义规则',
      description: '按你填写的规则分章。',
      pattern: options.pattern,
      regex: compilePattern(options.pattern, options.flags || ''),
    };
  }
  const rule = RULES.find((r) => r.id === (options.ruleId || DEFAULT_RULE_ID));
  if (!rule) {
    throw new ApiError(
      'UNKNOWN_CHAPTER_RULE',
      '没有这个分章规则。',
      `可选的是：${RULES.map((r) => r.label).join('、')}。`,
      400
    );
  }
  return { ...rule, regex: compilePattern(rule.pattern, rule.flags || '') };
}

/**
 * 判断一行是不是章节头。
 * @returns {{isTitle:boolean, title:string}|null}
 */
function matchTitleLine(line, regex, maxLineLength = DEFAULT_MAX_LINE_LENGTH) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLineLength) return null;

  const hit = regex.exec(trimmed);
  if (!hit) return null;

  // 从第二个捕获组里取"标题部分"（没写捕获组时就用整行）
  const tail = (hit[2] !== undefined ? hit[2] : '').trim();
  if (tail.length > MAX_TITLE_LENGTH) return null;
  if (SENTENCE_END.test(tail)) return null;
  if (tail && /[。！？；…]{1}/.test(tail)) return null;

  return { isTitle: true, title: trimmed };
}

/**
 * 分章。
 * @param {string} text
 * @param {{ruleId?:string, pattern?:string, flags?:string, maxLineLength?:number}} options
 * @returns {{chapters:Array<{index:number,title:string,content:string,char_count:number,is_preface?:boolean}>,
 *            matched:number, rule:{id:string,label:string,pattern:string}, totalChars:number}}
 */
function chapterize(text, options = {}) {
  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const rule = resolveRule(options);
  const maxLineLength = options.maxLineLength || DEFAULT_MAX_LINE_LENGTH;
  const lines = source.split('\n');

  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const hit = matchTitleLine(lines[i], rule.regex, maxLineLength);
    if (hit) hits.push({ lineIndex: i, title: hit.title });
  }

  /** 收尾：把一段行区间拼成章节 */
  const build = (title, from, to, extra = {}) => {
    const content = lines.slice(from, to).join('\n').replace(/^\n+|\n+$/g, '');
    return {
      title,
      content,
      char_count: content.replace(/\s/g, '').length,
      ...extra,
    };
  };

  const raw = [];
  if (hits.length === 0) {
    // 一条都没认出来：绝不硬切，先整篇作为一章，让界面提示用户换规则
    raw.push(build('全文', 0, lines.length));
  } else {
    // 第一个章节头之前的内容单独成章，避免"卷首/简介"被悄悄丢掉
    const leading = lines.slice(0, hits[0].lineIndex).join('\n').trim();
    if (leading) {
      raw.push(build('卷首', 0, hits[0].lineIndex, { is_preface: true }));
    }
    for (let i = 0; i < hits.length; i++) {
      const start = hits[i].lineIndex;
      const end = i + 1 < hits.length ? hits[i + 1].lineIndex : lines.length;
      raw.push(build(hits[i].title, start, end));
    }
  }

  const chapters = raw.map((item, i) => ({
    index: i + 1,
    title: item.title,
    content: item.content,
    char_count: item.char_count,
    is_preface: Boolean(item.is_preface),
  }));

  return {
    chapters,
    matched: hits.length,
    rule: { id: rule.id, label: rule.label, pattern: rule.pattern },
    totalChars: source.replace(/\s/g, '').length,
  };
}

/** 分章预览（不返回正文，只给标题与开头片段，避免大文件把响应撑爆） */
function previewChapterize(text, options = {}) {
  const result = chapterize(text, options);
  const limit = options.limit || 0;
  const chapters = (limit > 0 ? result.chapters.slice(0, limit) : result.chapters).map((ch) => ({
    index: ch.index,
    title: ch.title,
    char_count: ch.char_count,
    is_preface: Boolean(ch.is_preface),
    preview: ch.content.slice(0, 60),
  }));
  return {
    chapters,
    chapterCount: result.chapters.length,
    matched: result.matched,
    rule: result.rule,
    totalChars: result.totalChars,
    /** 认不出章节时界面要给出可自助修复的引导 */
    hint:
      result.matched === 0
        ? '这份内容里没认出章节标题，会被当作一整章导入。你可以在下面自定义分章规则，或者直接导入后在详情页手工调章。'
        : '',
  };
}

/**
 * 章节数校验（PRD 模块 7 硬规则）。
 * 转换前后的章节数与标题必须逐字一致，不一致就报错、保留原文件不动。
 */
function verifyChapters(chapters, expected) {
  const problems = [];
  if (!expected) return { ok: true, problems };
  const expectCount = Number(expected.chapterCount);
  if (Number.isFinite(expectCount) && expectCount !== chapters.length) {
    problems.push(`章节数对不上：预览时是 ${expectCount} 章，现在要写入 ${chapters.length} 章。`);
  }
  if (Array.isArray(expected.titles)) {
    if (expected.titles.length !== chapters.length) {
      problems.push(`标题条数对不上：预览时是 ${expected.titles.length} 条，现在是 ${chapters.length} 条。`);
    } else {
      for (let i = 0; i < chapters.length; i++) {
        if (String(chapters[i].title) !== String(expected.titles[i])) {
          problems.push(
            `第 ${i + 1} 章的标题对不上：预览时是「${expected.titles[i]}」，现在是「${chapters[i].title}」。`
          );
          break;
        }
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

module.exports = {
  RULES,
  DEFAULT_RULE_ID,
  DEFAULT_PATTERN,
  DEFAULT_MAX_LINE_LENGTH,
  resolveRule,
  compilePattern,
  matchTitleLine,
  chapterize,
  previewChapterize,
  verifyChapters,
};
