'use strict';
/**
 * encoding.js —— 编码检测、解码与乱码还原（PRD 模块 7 的核心）。
 *
 * 为什么这块必须做扎实：
 * PRD 说这条是"三条内容路径里最脏的一条"，还专门下了一条硬规则：
 *   **绝不允许在预览不正确的情况下静默采用某个编码**。
 * 所以这里的设计原则是"先给候选和置信度，猜不准就把决定权交回给人"，
 * 而不是随便挑一个能解码的就算了。
 *
 * 检测顺序（重要）：
 *   1. BOM —— 最硬的证据，有就直接用，置信度 0.99；
 *   2. 严格 UTF-8 校验 —— 能通过严格校验的字节流几乎不可能是别的编码
 *      （GBK 双字节里第二字节常落在 0x40-0x7E，但整篇都能构成合法 UTF-8 的概率极低）；
 *   3. 都不成立时才用"逐个候选解码 + 打分"的方式竞争，并用 jschardet 作为参考票。
 *
 * 打分依据：解码结果里中文/全角标点的占比、替换字符（U+FFFD）与控制字符的比例。
 * 这是判断"解得对不对"最直接的信号 —— 解错了就会出现大片看不懂的怪字符。
 */

const iconv = require('iconv-lite');
const jschardet = require('jschardet');

/** 工具对外展示与支持的编码名（PRD 模块 7 明确列出的这 7 种） */
const SUPPORTED_ENCODINGS = [
  'UTF-8',
  'UTF-8 BOM',
  'GBK',
  'GB18030',
  'UTF-16LE',
  'UTF-16BE',
  'BIG5',
];

/** 展示名 → iconv-lite 的编码名 */
const ICONV_NAME = {
  'UTF-8': 'utf8',
  'UTF-8 BOM': 'utf8',
  GBK: 'gbk',
  GB18030: 'gb18030',
  UTF16LE: 'utf16le',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16-be',
  BIG5: 'big5',
};

/** 打分时只看这些长度的样本：10 MB 的文件没必要全扫一遍 */
const SAMPLE_HEAD = 64 * 1024;
const SAMPLE_TAIL = 16 * 1024;

const BOM = {
  'UTF-8 BOM': Buffer.from([0xef, 0xbb, 0xbf]),
  'UTF-16LE': Buffer.from([0xff, 0xfe]),
  'UTF-16BE': Buffer.from([0xfe, 0xff]),
};

// ------------------------------------------------------------------ 基础

/** 去掉开头的 BOM 字符（解码之后是 U+FEFF） */
function stripBom(text) {
  if (typeof text === 'string' && text.charCodeAt(0) === 0xfeff) return text.slice(1);
  return text;
}

/** 判断字节流是否有 BOM，返回 'UTF-8 BOM' / 'UTF-16LE' / 'UTF-16BE' / null */
function detectBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return 'UTF-8 BOM';
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return 'UTF-16LE';
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return 'UTF-16BE';
  return null;
}

/** 严格 UTF-8 校验：只要有一个非法序列就不算 UTF-8 */
function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, SAMPLE_HEAD));
    // 中段再抽查一次，避免"文件头是 ASCII、正文是 GBK"被误判
    if (buffer.length > SAMPLE_HEAD * 2) {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(SAMPLE_HEAD, SAMPLE_HEAD * 2));
    }
    return true;
  } catch (err) {
    return false;
  }
}

/** 无 BOM 的 UTF-16 特征：每隔一个字节就是 0x00 */
function guessUtf16(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.length < 16) return null;
  let evenZero = 0;
  let oddZero = 0;
  const pairs = Math.floor(sample.length / 2);
  for (let i = 0; i < pairs; i++) {
    if (sample[i * 2] === 0) evenZero++;
    if (sample[i * 2 + 1] === 0) oddZero++;
  }
  const evenRatio = evenZero / pairs;
  const oddRatio = oddZero / pairs;
  if (oddRatio > 0.3) return 'UTF-16LE'; // 低位在后 → 小端
  if (evenRatio > 0.3) return 'UTF-16BE';
  return null;
}

/** 取一段样本（头 + 尾），兼顾性能与代表性 */
function sampleBuffer(buffer) {
  if (buffer.length <= SAMPLE_HEAD + SAMPLE_TAIL) return buffer;
  return Buffer.concat([buffer.subarray(0, SAMPLE_HEAD), buffer.subarray(buffer.length - SAMPLE_TAIL)]);
}

// ------------------------------------------------------------------ 打分

/**
 * 常用汉字表（按现代汉语使用频率取前 500 左右）。
 *
 * 为什么需要它：
 * 只看"解出来有多少汉字"是不够的 —— 编码读错时同样会解出**一大堆汉字**，
 * 只不过都是生僻字。例如 UTF-8 的中文被当成 GBK 读，会得到「莽卢卢盲赂聙」这类
 * 通篇是汉字、却一个常用字都没有的结果。用"常用字占比"才能真正把它们分开。
 */
const COMMON_HANZI = new Set(
  (
    '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托队'
  ).split('')
);

/** 判断一个字符是不是"常用汉字" */
function isCommonHanzi(ch) {
  return COMMON_HANZI.has(ch);
}

/**
 * 给一段解码结果打分（越高越像"正常的中文正文"）。
 * @returns {{score:number, badRatio:number, cjkRatio:number, familiarRatio:number}}
 */
function scoreText(text) {
  if (!text) return { score: -50, badRatio: 1, cjkRatio: 0, familiarRatio: 0 };
  let total = 0;
  let good = 0;
  let bad = 0;
  let cjk = 0;
  let common = 0;

  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i);
    if (code > 0xffff) i++; // 代理对，按一个字符算
    total++;

    if (code === 0xfffd || code === 0x0000) {
      bad++;
      continue;
    }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      bad++;
      continue;
    }
    if (code >= 0xe000 && code <= 0xf8ff) {
      bad++; // 私用区，正常正文里不该出现
      continue;
    }

    good++;
    if (code >= 0x4e00 && code <= 0x9fff) {
      cjk++;
      if (isCommonHanzi(text[i])) common++;
    } else if (code >= 0x3000 && code <= 0x303f) {
      cjk++; // 中文标点
    }
  }

  const badRatio = bad / total;
  const cjkRatio = cjk / total;
  // 常用字占"汉字总数"的比例：真中文通常 40% 以上，读错编码得到的生僻字堆通常不到 10%
  const familiarRatio = cjk > 0 ? common / cjk : 0;

  // 干净程度 + 中文占比 + 常用字熟悉度；坏字符重罚
  const score = (good / total) * 40 + cjkRatio * 25 + familiarRatio * 35 * (cjkRatio > 0.02 ? 1 : 0) - badRatio * 120;
  return { score, badRatio, cjkRatio, familiarRatio };
}

/** 候选偏好次序：解出完全相同内容时留更常用的那个名字（中文小说绝大多数是 GBK） */
const CANDIDATE_PREFERENCE = ['GBK', 'GB18030', 'BIG5', 'UTF-16LE', 'UTF-16BE', 'UTF-8'];

function preferRank(name) {
  const at = CANDIDATE_PREFERENCE.indexOf(name);
  return at === -1 ? 99 : at;
}

/**
 * 把候选之间的分差换算成 0~1 的置信度。
 * 分差越大、第二名越破，就越有把握。
 */
function toConfidence(best, second, candidateCount) {
  const other = second ? second.score : best.score - 30;
  const gap = best.score - other;
  let confidence = 0.5 + (Math.min(gap, 30) / 30) * 0.47; // 0.5 ~ 0.97
  // 第二名本身就一身坏字符，等于没有竞争对手
  if (second && second.badRatio > 0.02) confidence = Math.min(0.97, confidence + 0.08);
  // 解出来的东西本身很脏（大片替换字符）时，不管分差多大都不该自信
  if (best.badRatio > 0.02) confidence = Math.min(confidence, 0.45);
  // 只有一个候选、而且解得很干净 —— 那基本就是它了
  if (candidateCount === 1 && best.badRatio < 0.02) confidence = Math.max(confidence, 0.9);
  return Math.round(confidence * 1000) / 1000;
}

// ------------------------------------------------------------------ 解码

/**
 * 按指定编码解码。
 * @param {Buffer} buffer
 * @param {string} encoding 展示名（SUPPORTED_ENCODINGS 之一）
 */
function decode(buffer, encoding) {
  const name = ICONV_NAME[encoding];
  if (!name) {
    const { ApiError } = require('../lib/errors');
    throw new ApiError(
      'UNSUPPORTED_ENCODING',
      `工具不支持「${encoding}」这种编码。`,
      `目前可用的是：${SUPPORTED_ENCODINGS.join('、')}。`,
      400
    );
  }
  let text = iconv.decode(buffer, name);
  if (encoding === 'UTF-8 BOM') text = stripBom(text);
  return text;
}

/**
 * 检测编码。
 * @returns {{
 *   encoding:string, confidence:number, confident:boolean,
 *   bom:string|null, candidates:Array<{encoding:string,score:number,confidence:number,badRatio:number,note:string}>,
 *   note:string
 * }}
 */
function detect(buffer) {
  if (!buffer || buffer.length === 0) {
    return {
      encoding: 'UTF-8',
      confidence: 0,
      confident: false,
      bom: null,
      candidates: [],
      note: '文件是空的，没有内容可以识别。',
    };
  }

  const bom = detectBom(buffer);
  if (bom) {
    return {
      encoding: bom,
      confidence: 0.99,
      confident: true,
      bom,
      candidates: [{ encoding: bom, score: 100, confidence: 0.99, badRatio: 0, note: '文件开头有字节顺序标记，可以确定' }],
      note: '文件开头带了编码标记，已经确定编码。',
    };
  }

  if (isValidUtf8(buffer)) {
    return {
      encoding: 'UTF-8',
      confidence: 0.98,
      confident: true,
      bom: null,
      candidates: [
        { encoding: 'UTF-8', score: 100, confidence: 0.98, badRatio: 0, note: '整段内容都符合 UTF-8 规则' },
      ],
      note: '内容符合 UTF-8 规则，按 UTF-8 读取。',
    };
  }

  const utf16 = guessUtf16(buffer);
  const pool = ['GB18030', 'GBK', 'BIG5', 'UTF-16LE', 'UTF-16BE'];
  const sample = sampleBuffer(buffer);

  /** 给一个编码名打分 */
  function scoreEncoding(name) {
    let text = '';
    try {
      text = decode(sample, name);
    } catch (err) {
      text = '';
    }
    return { encoding: name, text, ...scoreText(text) };
  }

  const scored = [];
  /** 解码结果 → 已收录候选的下标。用来合并"两种编码解出一模一样内容"的情况 */
  const seenTexts = new Map();

  function push(item) {
    if (!item.text) {
      scored.push(item);
      return;
    }
    if (seenTexts.has(item.text)) {
      // 同一段字节用两种编码解出完全一样的内容（典型：GBK 是 GB18030 的子集）。
      // 这时它们本质上是同一个答案，必须合并，否则会出现"两个候选分不出高下"，
      // 置信度被无谓地压低。
      const at = seenTexts.get(item.text);
      if (preferRank(item.encoding) < preferRank(scored[at].encoding)) scored[at] = item;
      return;
    }
    scored.push(item);
    seenTexts.set(item.text, scored.length - 1);
  }

  for (const name of pool) push(scoreEncoding(name));

  // jschardet 只当"参考票"：它的结果并进候选，分数按同样的规则算，不直接采信
  let jschardetGuess = null;
  try {
    const guess = jschardet.detect(sample);
    if (guess && guess.encoding) {
      const normalized = normalizeJschardetName(guess.encoding);
      jschardetGuess = { encoding: guess.encoding, normalized, confidence: guess.confidence || 0 };
      if (normalized && !scored.some((s) => s.encoding === normalized)) {
        push(scoreEncoding(normalized));
      }
    }
  } catch (err) {
    /* jschardet 挂了不影响主流程 */
  }

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const second = scored[1] || null;
  const confidence = toConfidence(best, second, scored.length);

  const candidates = scored.map((item, i) => ({
    encoding: item.encoding,
    score: Math.round(item.score * 10) / 10,
    confidence: i === 0 ? confidence : Math.max(0, Math.round((confidence - i * 0.2) * 1000) / 1000),
    badRatio: Math.round(item.badRatio * 10000) / 10000,
    familiarRatio: Math.round(item.familiarRatio * 1000) / 1000,
    note: describeCandidate(item, i === 0),
  }));

  return {
    encoding: best.encoding,
    confidence,
    confident: confidence >= 0.75,
    bom: null,
    candidates,
    utf16Hint: utf16,
    jschardet: jschardetGuess,
    note:
      confidence >= 0.75
        ? `按 ${best.encoding} 读取的可能性最大。`
        : '没能确定编码，请对照预览选一个看起来正常的。',
  };
}

function describeCandidate(item, isBest) {
  if (item.badRatio > 0.02) return '解出来有明显的坏字符，基本可以排除';
  if (item.cjkRatio > 0.02 && item.familiarRatio < 0.1) return '虽然都是汉字，但几乎全是生僻字，读不通';
  if (item.cjkRatio > 0.2) return isBest ? '解出来是最通顺的中文' : '也能解出中文，但通顺程度不如上一个';
  if (item.cjkRatio > 0.02) return '只解出零星汉字';
  return '基本解不出中文';
}

/** 把 jschardet 的编码名对齐到我们支持的 7 种 */
function normalizeJschardetName(name) {
  const key = String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const map = {
    UTF8: 'UTF-8',
    GB2312: 'GBK',
    GBK: 'GBK',
    GB18030: 'GB18030',
    BIG5: 'BIG5',
    UTF16LE: 'UTF-16LE',
    UTF16BE: 'UTF-16BE',
    SHIFTJIS: null,
    EUCJP: null,
    ASCII: 'UTF-8',
  };
  return map[key] === undefined ? null : map[key];
}

// ------------------------------------------------------------------ 乱码判定与还原

/** 常见乱码特征。命中哪条就说明大概率是"读错编码"造成的 */
const MOJIBAKE_SIGNS = [
  { re: /锟斤拷/, label: '出现了「锟斤拷」' },
  { re: /\uFFFD/, label: '出现了无法解码的替换字符' },
  { re: /(?:[\u00C0-\u00FF][\u0080-\u00BF]){2,}/, label: '大片西欧扩展字符，像是 UTF-8 被当成西欧编码读了' },
  { re: /(?:[\u00A1-\u00FF]{4,})/, label: '连续出现西欧字符' },
  { re: /[\uE000-\uF8FF]{2,}/, label: '出现了私用区字符' },
];

/**
 * 「不可逆」的判定阈值。
 * 替换字符 U+FFFD 意味着**原始字节已经在那次错误的解码里丢掉了**，
 * 无论怎么反推都拿不回来 —— 出现得比较多时就必须明说"解不了"，
 * 而不是产出一个看起来像中文、实际是二次乱码的成品。
 * 少量（比如刚好切在半个字符上）不算，免得误伤一个 99% 正常的文件。
 */
const FFFD_FATAL_MIN_COUNT = 3;
const FFFD_FATAL_RATIO = 0.002;

/**
 * 判断文本看起来是否像乱码。
 * @returns {{mojibake:boolean, fatal:boolean, signs:string[], fffdCount:number}}
 */
function inspectMojibake(text) {
  const value = String(text || '');
  const signs = [];
  let fatal = false;

  const fffdCount = (value.match(/\uFFFD/g) || []).length;
  if (fffdCount >= FFFD_FATAL_MIN_COUNT || fffdCount / Math.max(1, value.length) > FFFD_FATAL_RATIO) {
    fatal = true;
  }
  // 「锟斤拷」是 U+FFFD 被再用 GBK 读一遍的产物，同样是不可逆的
  if (/锟斤拷/.test(value)) fatal = true;

  for (const sign of MOJIBAKE_SIGNS) {
    if (sign.re.test(value)) signs.push(sign.label);
  }

  return { mojibake: signs.length > 0, fatal, signs, fffdCount };
}

/**
 * 只有文本、没有原始字节时，根据乱码长相猜"它原本可能是什么编码"。
 *
 * 为什么需要：
 * 用户常常是"从别的程序里复制了一段已经显示坏了的文字"贴进来，这时候没有字节可查，
 * 但 PRD 模块 7 要求"不可恢复时也要给出原始编码猜测"，所以得从乱码的样子反推。
 */
function guessOriginalEncodings(text) {
  const value = String(text || '');
  const out = [];

  // 「锟斤拷」= U+FFFD 被 GBK 再读一遍的产物：原文几乎肯定是 UTF-8
  if (/锟斤拷/.test(value)) out.push('UTF-8');
  // 大片西欧扩展字符：UTF-8 正文被当成西欧编码（latin1）读了
  if (/(?:[\u00C0-\u00FF][\u0080-\u00BF]){2,}/.test(value)) out.push('UTF-8');
  // 通篇是生僻汉字、却读不通：多半是 UTF-8 字节被当成 GBK 读了
  const scored = scoreText(value);
  if (scored.cjkRatio > 0.3 && scored.familiarRatio < 0.15) {
    out.push('UTF-8');
    out.push('GBK');
  }
  if (scored.cjkRatio > 0.5 && scored.familiarRatio >= 0.15) out.push('GBK');
  if (/[\uFFFD]/.test(value)) out.push('GB18030');

  if (!out.length) out.push('UTF-8', 'GBK');
  return [...new Set(out)].slice(0, 3);
}

/**
 * 反向映射链。
 * 每一环都是"字节被读错"的一种可能，我们把文本重新变回字节、再按另一种编码读一次，
 * 然后挑出解出来最通顺的那一条。这就是"一键还原"的实质。
 */
const RECOVERY_CHAINS = [
  { id: 'none', label: '不做处理', apply: (t) => t },
  {
    id: 'latin1→utf8',
    label: '把内容按西欧编码转回字节，再按 UTF-8 读',
    apply: (t) => Buffer.from(t, 'latin1').toString('utf8'),
  },
  {
    id: 'gbk→utf8',
    label: '把内容按 GBK 转回字节，再按 UTF-8 读',
    apply: (t) => iconv.decode(iconv.encode(t, 'gbk'), 'utf8'),
  },
  {
    id: 'big5→utf8',
    label: '把内容按 BIG5 转回字节，再按 UTF-8 读',
    apply: (t) => iconv.decode(iconv.encode(t, 'big5'), 'utf8'),
  },
  {
    id: 'utf8→gbk',
    label: '把内容按 UTF-8 转回字节，再按 GBK 读',
    apply: (t) => iconv.decode(Buffer.from(t, 'utf8'), 'gbk'),
  },
  {
    id: 'latin1→gbk',
    label: '把内容按西欧编码转回字节，再按 GBK 读',
    apply: (t) => iconv.decode(Buffer.from(t, 'latin1'), 'gbk'),
  },
  {
    id: 'utf8→big5',
    label: '把内容按 UTF-8 转回字节，再按 BIG5 读',
    apply: (t) => iconv.decode(Buffer.from(t, 'utf8'), 'big5'),
  },
];

/**
 * 尝试还原乱码。
 * @param {string} text 已经显示为乱码的文本
 * @returns {{text:string, chain:string[], chainLabel:string, applied:boolean, improved:number,
 *            recoverable:boolean, note:string, candidates:Array}}
 */
function recover(text) {
  const original = String(text == null ? '' : text);
  const before = scoreText(original);

  const results = RECOVERY_CHAINS.map((chain) => {
    let output = original;
    try {
      output = chain.apply(original);
    } catch (err) {
      output = original;
    }
    const { score, badRatio, familiarRatio, cjkRatio } = scoreText(output);
    return { chain, output, score, badRatio, familiarRatio, cjkRatio };
  });

  results.sort((a, b) => b.score - a.score);

  /**
   * 只有"结果干净、而且明显更像正常中文"才算还原成功。
   * 为什么这么严：把一段已经丢了字节的乱码再揉一遍，往往能揉出"满屏汉字"的假象
   * （典型就是二次乱码「锟斤拷」），分数甚至比原文高。不卡这道闸就会把垃圾当成果交给用户。
   */
  const cleanResults = results.filter(
    (r) => r.chain.id !== 'none' && r.badRatio < 0.01 && r.familiarRatio > 0.2
  );
  const best = cleanResults[0] || null;
  const improved = best ? best.score - before.score : 0;
  const applied = Boolean(best) && improved > 3;

  const signs = inspectMojibake(original);
  const unrecoverable = signs.fatal;

  // 有"能改善但结果不干净"的候选时，也要如实告诉用户：只救回来一部分
  const partial = !applied && !unrecoverable ? results.find((r) => r.chain.id !== 'none' && r.score - before.score > 3) : null;

  let note;
  if (applied) {
    note = `按「${best.chain.label}」还原后内容通顺了。`;
  } else if (unrecoverable) {
    note = '这段内容里有已经丢失掉的字符（原始字节在那次错误的解码里就没了），属于不可逆的丢失，任何方式都还原不了。';
  } else if (partial) {
    note = `试了「${partial.chain.label}」，只能救回一部分，剩下的还是坏的。建议直接找原始文本重新复制一次。`;
  } else {
    note = '试遍了各种还原方式都没有明显改善，建议直接找原始文本重新复制一次。';
  }

  return {
    text: applied ? best.output : original,
    chain: applied ? [best.chain.id] : [],
    chainLabel: applied ? best.chain.label : '',
    applied,
    improved: Math.round(improved * 10) / 10,
    recoverable: applied,
    unrecoverable,
    partial: Boolean(partial),
    note,
    candidates: results.slice(0, 4).map((r) => ({
      id: r.chain.id,
      label: r.chain.label,
      score: Math.round(r.score * 10) / 10,
      clean: r.badRatio < 0.01 && r.familiarRatio > 0.2,
      preview: r.output.slice(0, 60),
    })),
  };
}

// ------------------------------------------------------------------ 三段对照预览

/**
 * 取文件头 / 中 / 尾三段，供"改前改后对照预览"（PRD 模块 7）。
 * @param {Buffer} buffer
 * @param {string} encoding
 * @param {{segmentChars?:number, candidates?:string[]}} options
 */
function previewSegments(buffer, encoding, options = {}) {
  const size = options.segmentChars || 300;
  const segments = [];

  /** 按字节区间取出并解码 */
  function sliceAt(byteOffset, label) {
    const bytesPerChar = encoding.startsWith('UTF-16') ? 2 : 1;
    const span = size * bytesPerChar * 2;
    const chunk = buffer.subarray(byteOffset, Math.min(buffer.length, byteOffset + span));
    if (chunk.length === 0) return null;
    let text = '';
    try {
      text = decode(chunk, encoding);
    } catch (err) {
      text = '';
    }
    // 掐头去尾：中间切出来的字节可能正好在半个字符上，两端会带一个坏字符，不影响预览判断
    const trimmed = text.length > size ? text.slice(0, size) : text;
    return { label, text: trimmed };
  }

  const head = sliceAt(0, '文件开头');
  if (head) segments.push(head);

  if (buffer.length > SAMPLE_HEAD) {
    const midStart = Math.max(0, Math.floor(buffer.length / 2) - size);
    const mid = sliceAt(midStart, '文件中间');
    if (mid) segments.push(mid);
  }

  if (buffer.length > size * 4) {
    const tailStart = Math.max(0, buffer.length - size * 3);
    const tail = sliceAt(tailStart, '文件结尾');
    if (tail) segments.push(tail);
  }

  return segments;
}

module.exports = {
  SUPPORTED_ENCODINGS,
  ICONV_NAME,
  BOM,
  COMMON_HANZI,
  stripBom,
  detectBom,
  isValidUtf8,
  guessUtf16,
  scoreText,
  isCommonHanzi,
  decode,
  detect,
  inspectMojibake,
  guessOriginalEncodings,
  RECOVERY_CHAINS,
  recover,
  previewSegments,
  normalizeJschardetName,
};
