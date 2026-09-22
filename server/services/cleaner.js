'use strict';
/**
 * cleaner.js —— 正文清洗（PRD 模块 7 的"清洗开关"）。
 *
 * 两条纪律：
 *   1. **默认全部关闭**（PRD 明确要求）。清洗是不可逆的内容改动，
 *      宁可让用户自己开，也不能替他做决定；
 *   2. 每一次剔除都**必须留下可抽查的记录**（reason + 原文片段）。
 *      PRD 模块 2 的抓取报告要求"列出被剔除的片段让我抽查"，
 *      导入这条路上同理 —— 用户得能核对工具到底删了什么。
 */

/** 正文里不该出现的句子结尾 —— 用来避免把正文行误判成广告行 */
const HAS_SENTENCE = /[。！？；]["'）)]?$/;

/**
 * 疑似广告 / 导航行的特征表。
 * 每条都尽量写窄一些：宁可漏删（用户可以自己手动删），也不要误删正文。
 */
const AD_PATTERNS = [
  { id: 'url', re: /^\s*(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:com|net|cn|org|cc|info|xyz)(?:\/|\s|$))/i, label: '网址' },
  { id: 'site-push', re: /(?:本站|请记住本站|记住本书|收藏本站|最新网址|无弹窗|全文阅读|手机阅读|手机版阅读|txt下载|免费下载|首发)/, label: '站点推广语' },
  { id: 'site-name', re: /(?:笔趣|顶点|飘天|新笔趣|笔趣阁|书趣阁|顶点小说|全本小说|爱阅|言情小说吧)/, label: '站点名称' },
  { id: 'group', re: /(?:书友群|读者群|QQ群|qq群|加群|微信公众号|扫码关注|关注公众号)/, label: '加群/关注' },
  { id: 'beg', re: /(?:求收藏|求推荐票|求月票|求打赏|求订阅|投推荐票|求张月票|感谢打赏|谢谢打赏)/, label: '求票求赏' },
  { id: 'page', re: /^\s*[（(]?(?:本章未完|未完待续|待续|下一章|上一章)[)）…]*\s*$/, label: '翻页提示' },
  { id: 'pager-number', re: /^\s*第?\s*\d+\s*[\/／]\s*\d+\s*页\s*$/, label: '页码' },
  { id: 'external-link', re: /^\s*(?:阅读|点击|请到|详见).{0,12}(?:链接|网址|网站)/, label: '外链引导' },
];

/** 半角 → 全角标点（只在"夹在汉字之间"时替换，避免把 3.14 变成 3。14） */
const HALF_TO_FULL = {
  ',': '，',
  '.': '。',
  '!': '！',
  '?': '？',
  ':': '：',
  ';': '；',
};

/** 这个字符算不算"汉字环境"（汉字、中文标点、全角字符、日韩文字） */
function isCjkLike(ch) {
  if (!ch) return false;
  const code = ch.codePointAt(0);
  return (
    (code >= 0x3400 && code <= 0x9fff) || // 汉字
    (code >= 0x3000 && code <= 0x303f) || // 中文标点
    (code >= 0xff00 && code <= 0xffef) || // 全角字符
    (code >= 0x2000 && code <= 0x206f) // 通用标点（含省略号）
  );
}

/** 数字或拉丁字母：判断"3.14"这类不该被改写的场景 */
function isWordLike(ch) {
  return Boolean(ch) && /[0-9A-Za-z]/.test(ch);
}

/**
 * 统一全角 / 半角标点。
 *
 * 判定规则（宁可少改，不要改错）：
 *   半角标点要转换成全角，必须满足其一：
 *     ① 前一个非空白字符是汉字；或
 *     ② 前一个是数字/字母，且后一个非空白字符是汉字（例如「3.14,很接近」里的逗号）。
 *   这样「3.14」「1,000」「Hello, world」都不会被误伤。
 */
function unifyPunctuation(text) {
  let changed = 0;
  const chars = [...text];

  for (let i = 0; i < chars.length; i++) {
    const replacement = HALF_TO_FULL[chars[i]];
    if (!replacement) continue;

    // 往前找第一个非空白字符
    let prev = i - 1;
    while (prev >= 0 && /\s/.test(chars[prev])) prev--;
    const prevChar = prev >= 0 ? chars[prev] : null;

    // 往后找第一个非空白字符
    let next = i + 1;
    while (next < chars.length && /\s/.test(chars[next])) next++;
    const nextChar = next < chars.length ? chars[next] : null;

    const prevIsCjk = isCjkLike(prevChar);
    const prevIsWord = isWordLike(prevChar);
    const nextIsCjk = isCjkLike(nextChar);
    const nextIsEnd = nextChar === null;

    const shouldConvert =
      (prevIsCjk && (nextIsCjk || nextIsEnd)) || // 汉字夹着标点
      (prevIsWord && nextIsCjk); // 数字/字母后面直接接汉字

    if (!shouldConvert) continue;
    chars[i] = replacement;
    changed++;
  }

  let out = chars.join('');
  // 省略号统一成中文的"……"（三个及以上的点号 / 两段以上的句号）
  const beforeEllipsis = out;
  out = out.replace(/\.{3,}/g, '……').replace(/。{2,}/g, '……').replace(/…{3,}/g, '……');
  if (beforeEllipsis !== out) changed++;

  return { text: out, changed };
}

/**
 * 判断某一行是不是疑似广告行。
 * @returns {string|null} 命中的原因（中文），没命中返回 null
 */
function detectAdLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // 太长、且以句号结尾的行，基本是正文；不让广告特征词去误伤它
  if (trimmed.length > 80 && HAS_SENTENCE.test(trimmed)) return null;
  for (const pattern of AD_PATTERNS) {
    if (pattern.re.test(trimmed)) {
      // 站点推广语这类特征词可能出现在正文叙述里，加一道长度闸
      if (trimmed.length > 60 && pattern.id !== 'url') continue;
      return pattern.label;
    }
  }
  return null;
}

/**
 * 执行清洗。
 * @param {string} text
 * @param {{blankLines?:boolean, indent?:boolean, punctuation?:boolean, adLines?:boolean}} switches
 * @returns {{text:string, changedChars:number, stats:Object, removals:Array, removalsTruncated:boolean}}
 */
function clean(text, switches = {}) {
  const enabled = {
    blankLines: switches.blankLines === true,
    indent: switches.indent === true,
    punctuation: switches.punctuation === true,
    adLines: switches.adLines === true,
  };

  const source = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  const beforeLength = source.length;
  let working = source;
  const removals = [];
  const REMOVAL_LIMIT = 200;

  // 1. 去掉疑似广告行（先做，后面的空行处理才不会算错）
  if (enabled.adLines) {
    const kept = [];
    const lines = working.split('\n');
    for (const line of lines) {
      const reason = detectAdLine(line);
      if (reason) {
        if (removals.length < REMOVAL_LIMIT) {
          removals.push({ reason, line, snippet: line.trim().slice(0, 80) });
        }
        // 整行剔除，连带占位换行一起拿掉
        continue;
      }
      kept.push(line);
    }
    working = kept.join('\n');
  }

  // 2. 去掉行首多余空白
  if (enabled.indent) {
    working = working
      .split('\n')
      .map((line) => line.replace(/^[ \t\u3000]+/, ''))
      .join('\n');
  }

  // 3. 去掉空行冗余：连续 3 个以上换行压成 2 个（段落之间保留一个空行）
  if (enabled.blankLines) {
    working = working.replace(/\n{3,}/g, '\n\n');
  }

  // 4. 统一全角 / 半角标点
  let punctuationChanged = 0;
  if (enabled.punctuation) {
    const result = unifyPunctuation(working);
    working = result.text;
    punctuationChanged = result.changed;
  }

  const afterLength = working.length;

  return {
    text: working,
    /** 改动字符数（长度差 + 标点替换数），界面上要显示"改了多少字符" */
    changedChars: Math.abs(beforeLength - afterLength) + punctuationChanged,
    stats: {
      adLinesRemoved: removals.length,
      punctuationChanged,
      lengthBefore: beforeLength,
      lengthAfter: afterLength,
    },
    removals,
    removalsTruncated: removals.length >= REMOVAL_LIMIT,
  };
}

/** 取三段文本片段（清洗前后对照预览用） */
function segments(text, size = 300) {
  const value = String(text == null ? '' : text);
  const out = [{ label: '开头', text: value.slice(0, size) }];
  if (value.length > size * 4) {
    const mid = Math.floor(value.length / 2);
    out.push({ label: '中间', text: value.slice(mid, mid + size) });
  }
  if (value.length > size * 3) {
    out.push({ label: '结尾', text: value.slice(-size) });
  }
  return out;
}

module.exports = {
  AD_PATTERNS,
  HALF_TO_FULL,
  detectAdLine,
  unifyPunctuation,
  clean,
  segments,
};
