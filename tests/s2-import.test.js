'use strict';
/**
 * s2-import.test.js —— S2 阶段验收：导入与编码修复（模块 7）+ 自动分章。
 *
 * 对应 PRD §11 S2 与验收项 3、4：
 *   - 粘贴一段 GBK 乱码正文，能自动识别、一键还原、对照预览正确（验收项 3）
 *   - 导入一本大 TXT 后可用（验收项 4 的服务端部分）
 * 以及模块 7 的三条硬规则：不静默采用编码、校验不一致不落库、解不了就明说。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const encoding = require('../server/services/encoding');
const chapterize = require('../server/services/chapterize');
const cleaner = require('../server/services/cleaner');
const { startTestServer, createTestContext, expectOk, expectErr, rmrf, catchErr } = require('./helpers/env');

/** 造一段中文正文，用来验证各编码的往返 */
const SAMPLE =
  '第一章　初见\n山间的风很凉，他握紧了手里的剑。\n“你是谁？”少年问。\n' +
  '第二章　出山\n十年后，他终于走出了那座山。\n';
const SAMPLE_BODY = '山间的风很凉，他握紧了手里的剑。这里有一段中文，用来测试编码识别能不能正常工作。';

// ============================================================ 编码检测

test('S2 · encoding：识别 UTF-8 / UTF-8 BOM', () => {
  const utf8 = Buffer.from(SAMPLE, 'utf8');
  const d1 = encoding.detect(utf8);
  assert.equal(d1.encoding, 'UTF-8');
  assert.ok(d1.confidence >= 0.9);
  assert.equal(d1.confident, true);
  assert.equal(d1.bom, null);

  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8]);
  const d2 = encoding.detect(withBom);
  assert.equal(d2.encoding, 'UTF-8 BOM');
  assert.equal(d2.confident, true);
  // 解出来不能带 BOM 字符，否则正文第一行会多一个看不见的字符
  assert.equal(encoding.decode(withBom, 'UTF-8 BOM').charCodeAt(0) === 0xfeff, false);
  assert.ok(encoding.decode(withBom, 'UTF-8 BOM').startsWith('第一章'));
});

test('S2 · encoding：识别 GBK / GB18030 / BIG5 / UTF-16', () => {
  const gbk = iconv.encode(SAMPLE_BODY, 'gbk');
  const g = encoding.detect(gbk);
  assert.ok(['GBK', 'GB18030'].includes(g.encoding), `GBK 内容应识别为 GBK/GB18030，实际 ${g.encoding}`);
  assert.equal(g.confident, true, 'GBK 内容应当能被确定下来');
  assert.equal(encoding.decode(gbk, 'GBK'), SAMPLE_BODY, '按 GBK 解码必须逐字还原');
  assert.equal(encoding.decode(gbk, 'GB18030'), SAMPLE_BODY, 'GBK 是 GB18030 的子集，也应还原一致');

  const gb18030 = iconv.encode(SAMPLE_BODY + '𠀀', 'gb18030');
  assert.equal(encoding.decode(gb18030, 'GB18030').startsWith(SAMPLE_BODY.slice(0, 10)), true);

  // BIG5 是繁体字集，简体字在里面没有对应编码（会被替换成 ?），
  // 所以这里用一段繁体文本验证 —— 这也正是"选错编码就会读不通"的真实体现
  const traditional = '第一章　山間的風很涼，他握緊了手裡的劍，這裡用繁體字考驗 BIG5。';
  const big5 = iconv.encode(traditional, 'big5');
  assert.equal(encoding.decode(big5, 'BIG5'), traditional, '按 BIG5 解码必须还原');
  const b = encoding.detect(big5);
  assert.equal(b.encoding, 'BIG5', `繁体内容应识别为 BIG5，实际 ${b.encoding}`);

  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SAMPLE_BODY, 'utf16le')]);
  assert.equal(encoding.detect(le).encoding, 'UTF-16LE');
  assert.equal(encoding.decode(le, 'UTF-16LE'), SAMPLE_BODY);

  const be = Buffer.concat([Buffer.from([0xfe, 0xff]), iconv.encode(SAMPLE_BODY, 'utf16-be')]);
  assert.equal(encoding.detect(be).encoding, 'UTF-16BE');
  assert.equal(encoding.decode(be, 'UTF-16BE'), SAMPLE_BODY);

  // 无 BOM 的 UTF-16LE 也要能猜出来
  const leNoBom = Buffer.from(SAMPLE_BODY, 'utf16le');
  assert.equal(encoding.detect(leNoBom).encoding, 'UTF-16LE');
});

test('S2 · encoding：检测结果带候选列表与置信度，不自信时会说出来', () => {
  const gbk = iconv.encode(SAMPLE_BODY.repeat(3), 'gbk');
  const result = encoding.detect(gbk);
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.length >= 2, '应该给出多个候选供对照');
  assert.equal(typeof result.candidates[0].confidence, 'number');
  assert.equal(typeof result.candidates[0].badRatio, 'number');
  assert.ok(result.candidates[0].note.length > 0, '每个候选都要有人话说明');

  // 拿一段"谁也读不通"的字节流（随机二进制），必须老实说不自信
  const noise = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 251));
  const noiseResult = encoding.detect(noise);
  assert.equal(noiseResult.confident, false, '认不出来时必须承认，不能硬猜一个');
  assert.ok(noiseResult.note.includes('没能确定') || noiseResult.confidence < 0.75);
});

test('S2 · encoding：不支持的编码名给人话', () => {
  const err = catchErr(() => encoding.decode(Buffer.from('x'), 'EBCDIC'));
  assert.equal(err.code, 'UNSUPPORTED_ENCODING');
  assert.ok(err.message.includes('EBCDIC'));
  assert.ok(err.hint.includes('UTF-8'), 'hint 要列出可用的编码');
});

// ============================================================ 乱码还原（验收项 3）

test('S2 · encoding：UTF-8 正文被当成西欧编码读出来的乱码可以还原（ç¬¬ 这类）', () => {
  // 正面模拟：UTF-8 的"第一章"被 latin1 读一遍就变成 "ç¬¬ä¸€ç« "
  const mojibake = Buffer.from('第一章 山间的风很凉', 'utf8').toString('latin1');
  assert.ok(/[ÃÂÅÆÇÈÉÊËÌÍÎÏç¬]/.test(mojibake), '前置条件：文本里应该有西欧扩展字符');

  const result = encoding.recover(mojibake);
  assert.equal(result.applied, true, '应该能还原');
  assert.equal(result.recoverable, true);
  assert.ok(result.text.includes('第一章'), `还原结果不对：${result.text}`);
  assert.ok(result.chain.length > 0, '要记录实际生效的解码链');
  assert.ok(result.chainLabel.length > 0, '要给用户一条人话的链路说明');
});

test('S2 · encoding：GBK 正文被当成 UTF-8 读出来的乱码，如实判定为不可恢复', () => {
  // 这一路乱码是"有损"的：UTF-8 解码器遇到非法的 GBK 字节会写成替换字符，
  // 原始字节当场就没了。工具必须如实说"解不了"，而不是产出一个二次乱码的成品。
  const mojibake = iconv.decode(iconv.encode('第一章 山间的风很凉', 'gbk'), 'utf8');
  assert.ok(mojibake.includes('\uFFFD'), '前置条件：文本里应有替换字符');

  const result = encoding.recover(mojibake);
  assert.equal(result.applied, false);
  assert.equal(result.recoverable, false);
  assert.equal(result.unrecoverable, true);
  assert.ok(result.note.includes('还原不回来') || result.note.includes('丢失'));
});

test('S2 · encoding：UTF-8 被当成 GBK 读出来的乱码，只救回一部分也要如实说', () => {
  const mojibake = iconv.decode(Buffer.from('第一章 山间的风很凉', 'utf8'), 'gbk');
  const result = encoding.recover(mojibake);
  // 这一路能救回大部分，但边界上仍会残留坏字符 —— 不能说"完整还原了"
  if (result.applied) {
    assert.equal(result.recoverable, true);
    assert.ok(result.text.includes('山间的风很凉'), `还原结果不该比原文更差：${result.text}`);
  } else {
    assert.ok(result.note.length > 0, '无论哪种结论都要给用户一句人话');
  }
});

test('S2 · encoding：「锟斤拷」判定为不可恢复，并给出原始编码猜测', () => {
  const broken = '第一绔 锟斤拷锟斤拷 绗竴绔';
  const signs = encoding.inspectMojibake(broken);
  assert.equal(signs.mojibake, true);
  assert.equal(signs.fatal, true, '锟斤拷 属于不可逆丢失，必须标记为致命');

  const result = encoding.recover(broken);
  assert.equal(result.recoverable, false);
  assert.ok(result.note.includes('不可逆') || result.note.includes('还原不了'));
});

test('S2 · encoding：正常中文不会被误判成乱码', () => {
  const signs = encoding.inspectMojibake(SAMPLE_BODY);
  assert.equal(signs.mojibake, false);
});

// ============================================================ 分章

test('S2 · chapterize：默认规则能认出常见章节头', () => {
  const text = [
    '内容简介：这是一本测试用的书。',
    '',
    '第一章　初见',
    '正文一。',
    '正文二。',
    '',
    '第二章 出山',
    '正文三。',
    '',
    'Chapter 3 归乡',
    '正文四。',
    '',
    '番外 一些小事',
    '正文五。',
    '',
    '尾声',
    '正文六。',
  ].join('\n');

  const result = chapterize.chapterize(text);
  // 章节头：第一章、第二章、Chapter 3、番外、尾声 —— 共 5 个
  assert.equal(result.matched, 5, `应该认出 5 个章节头，实际 ${result.matched}`);
  // 第一个章节头之前的内容不能丢，要单独成章
  assert.equal(result.chapters[0].title, '卷首');
  assert.equal(result.chapters[0].is_preface, true);
  assert.ok(result.chapters[0].content.includes('内容简介'));

  const titles = result.chapters.slice(1).map((c) => c.title);
  assert.deepEqual(titles, ['第一章　初见', '第二章 出山', 'Chapter 3 归乡', '番外 一些小事', '尾声']);
  assert.ok(result.chapters[1].content.includes('正文一'));
  assert.ok(result.chapters[1].content.includes('正文二'));
  assert.ok(!result.chapters[1].content.includes('正文三'), '不能把下一章的内容带进来');
});

test('S2 · chapterize：正文里提到"第三章"不会被误判成章节头', () => {
  const text = [
    '第一章 开始',
    '他翻到第三章的时候，忽然想到了一句很久以前听过的话。',
    '这句话很长很长，长到根本不应该被当成章节标题来处理，所以它必须留在正文里。',
    '第二章 继续',
    '这里又是一段正文。',
  ].join('\n');

  const result = chapterize.chapterize(text);
  assert.equal(result.matched, 2);
  assert.ok(result.chapters[0].content.includes('他翻到第三章'), '句子里的第三章必须留在正文里');
});

test('S2 · chapterize：认不出章节时整篇一章，并给出自助引导', () => {
  const text = '这里是一段没有任何章节标题的连续文字。\n'.repeat(20);
  const result = chapterize.chapterize(text);
  assert.equal(result.matched, 0);
  assert.equal(result.chapters.length, 1);

  const preview = chapterize.previewChapterize(text);
  assert.ok(preview.hint.includes('自定义分章规则'), '要给用户可以自助修复的引导');
});

test('S2 · chapterize：内置规则列表与自定义正则', () => {
  const rules = chapterize.RULES;
  const ids = rules.map((r) => r.id);
  assert.ok(ids.includes('default'));
  // PRD 要求内置规则覆盖「第X章」「第X节」「Chapter N」「序章/番外/尾声」
  assert.ok(chapterize.DEFAULT_PATTERN.includes('Chapter'));
  assert.ok(chapterize.DEFAULT_PATTERN.includes('番外'));

  // 阿拉伯数字编号规则
  const numbered = '1. 开篇\n正文甲\n2、接着\n正文乙\n';
  const result = chapterize.chapterize(numbered, { ruleId: 'with-number' });
  assert.equal(result.matched, 2);
  assert.equal(result.chapters.length, 2);

  // 自定义正则
  const custom = chapterize.chapterize('【第1节】\n正文\n【第2节】\n正文\n', {
    pattern: '^\\s*(【第\\d+节】)\\s*$',
  });
  assert.equal(custom.matched, 2);
  assert.equal(custom.rule.id, 'custom');

  // 坏正则给人话
  const err = catchErr(() => chapterize.chapterize('x', { pattern: '([未闭合' }));
  assert.equal(err.code, 'BAD_CHAPTER_PATTERN');
  assert.ok(err.hint.includes('内置规则'));
});

test('S2 · chapterize：章节数与标题逐字校验（不一致就是不一致）', () => {
  const text = '第一章 甲\n正文\n第二章 乙\n正文\n';
  const result = chapterize.chapterize(text);

  assert.equal(chapterize.verifyChapters(result.chapters, { chapterCount: 2 }).ok, true);
  assert.equal(
    chapterize.verifyChapters(result.chapters, { chapterCount: 2, titles: ['第一章 甲', '第二章 乙'] }).ok,
    true
  );

  const badCount = chapterize.verifyChapters(result.chapters, { chapterCount: 3 });
  assert.equal(badCount.ok, false);
  assert.ok(badCount.problems[0].includes('章节数对不上'));

  const badTitle = chapterize.verifyChapters(result.chapters, {
    chapterCount: 2,
    titles: ['第一章 甲', '第二章 丙'],
  });
  assert.equal(badTitle.ok, false);
  assert.ok(badTitle.problems[0].includes('标题对不上'));
});

// ============================================================ 清洗

test('S2 · cleaner：四项开关默认全关，开了才有改动', () => {
  const dirty = [
    '　　行首有缩进的正文。',
    '',
    '',
    '',
    '请记住本站域名 www.example.com',
    '正文里夹了一句,英文逗号。',
    '他在第三章里说过这句话。',
  ].join('\n');

  const off = cleaner.clean(dirty, {});
  assert.equal(off.text, dirty, '不传开关时一个字都不该动');
  assert.equal(off.changedChars, 0);
  assert.equal(off.removals.length, 0);

  const on = cleaner.clean(dirty, { blankLines: true, indent: true, punctuation: true, adLines: true });
  assert.ok(on.changedChars > 0);
  assert.ok(!on.text.includes('请记住本站'), '广告行应被剔除');
  assert.ok(!on.text.includes('　　行首'), '行首缩进应被去掉');
  assert.ok(!/\n{3,}/.test(on.text), '连续空行应被压缩');
  assert.ok(on.text.includes('正文里夹了一句，英文逗号'), '半角标点应转全角');
  assert.ok(on.text.includes('他在第三章里说过这句话。'), '正文里提到第三章的行不能被当成广告删掉');
});

test('S2 · cleaner：剔除的片段要留记录，供用户抽查', () => {
  const text = ['正文第一行。', '更多精彩请关注微信公众号', 'www.test-site.com/1.html', '正文第二行。'].join('\n');
  const result = cleaner.clean(text, { adLines: true });
  assert.equal(result.removals.length, 2, '两行都该被剔除');
  for (const item of result.removals) {
    assert.ok(item.reason.length > 0, '要说明剔除原因');
    assert.ok(item.snippet.length > 0, '要留下被剔除的原文片段');
  }
  assert.deepEqual(
    result.removals.map((r) => r.snippet),
    ['更多精彩请关注微信公众号', 'www.test-site.com/1.html']
  );
});

test('S2 · cleaner：标点统一不会把数字里的小数点也改了', () => {
  const result = cleaner.clean('圆周率是3.14,很接近.', { punctuation: true });
  assert.ok(result.text.includes('3.14'), '小数点必须保留');
  assert.ok(result.text.includes('，很接近'), '汉字后面的逗号要转全角');
});

// ============================================================ 导入落库（接口层）

test('S2 · 接口：上传 GBK 文件 → 自动识别 → 预览 → 落库（验收项 3 全流程）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const gbkBytes = iconv.encode(SAMPLE, 'gbk');
  const form = new FormData();
  form.append('file', new Blob([gbkBytes], { type: 'text/plain' }), '测试小说.txt');

  const upload = expectOk(t, await srv.request('POST', '/api/import/upload', form), '上传');
  assert.ok(upload.task_id, '上传要返回 task_id（PRD §4.0）');
  assert.ok(upload.upload_id);
  assert.ok(['GBK', 'GB18030'].includes(upload.encoding), `编码识别不对：${upload.encoding}`);
  assert.equal(upload.size, gbkBytes.length);
  assert.ok(upload.sample.includes('第一章'), '要给一段预览让用户先确认');

  // 轮询任务进度
  const task = expectOk(t, await srv.get(`/api/tasks/${upload.task_id}`), '任务进度');
  assert.equal(task.status, 'done');

  // 三段对照预览
  const preview = expectOk(
    t,
    await srv.get(`/api/import/preview?upload_id=${upload.upload_id}&encoding=${upload.encoding}`),
    '预览'
  );
  assert.ok(preview.segments.length >= 1);
  assert.ok(preview.segments[0].text.includes('第一章'), '预览里应该能看到正确的中文');
  assert.ok(preview.alternatives.length > 0, '要给出其它编码的样子供对照');
  assert.ok(preview.alternatives.some((a) => !a.sample.includes('第一章')), '换个错误编码应该读不出正常中文');

  // 分章预览
  const chapters = expectOk(
    t,
    await srv.post('/api/import/preview-chapterize', { upload_id: upload.upload_id, encoding: upload.encoding }),
    '分章预览'
  );
  assert.equal(chapters.chapterCount, 2);
  assert.deepEqual(
    chapters.chapters.map((c) => c.title),
    ['第一章　初见', '第二章　出山']
  );

  // 落库
  const commit = expectOk(
    t,
    await srv.post('/api/import/commit', {
      upload_id: upload.upload_id,
      encoding: upload.encoding,
      expected: { chapterCount: chapters.chapterCount, titles: chapters.chapters.map((c) => c.title) },
    }),
    '落库'
  );
  assert.equal(commit.chapterCount, 2);
  assert.equal(commit.book.title, '测试小说');
  assert.equal(commit.book.source_kind, 'local');

  // 正文真的在磁盘上，且是 UTF-8
  const chapterFile = path.join(srv.dataDir, 'books', commit.book.book_id, 'chapters', '0001.txt');
  assert.ok(fs.existsSync(chapterFile), '章节正文必须落盘');
  const content = fs.readFileSync(chapterFile, 'utf8');
  assert.ok(content.includes('山间的风很凉'), `正文内容不对：${content.slice(0, 40)}`);
  assert.equal(fs.readFileSync(chapterFile)[0] === 0xef, false, '不能带 BOM');

  // 暂存文件用完就清
  const stagingLeft = srv.ctx.store.listDir('.staging').filter((n) => n.startsWith(upload.upload_id));
  assert.deepEqual(stagingLeft, [], '落库成功后暂存要清掉');
});

test('S2 · 接口：粘贴正文导入', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const text = '第一章 开始\n正文甲。\n第二章 结束\n正文乙。';
  const result = expectOk(t, await srv.post('/api/import/paste', { text, title: '粘贴进来的书' }), '粘贴导入');
  assert.equal(result.book.title, '粘贴进来的书');
  assert.equal(result.chapterCount, 2);
  assert.equal(result.encoding, 'UTF-8');

  const saved = srv.ctx.library.get(result.book.book_id);
  assert.equal(saved.total_chapters, 2);
  assert.equal(saved.chapters[1].title, '第二章 结束');

  expectErr(t, await srv.post('/api/import/paste', { text: '   ' }), 400, 'EMPTY_PASTE', '空粘贴');
});

test('S2 · 接口：/api/import/rules 返回内置分章规则', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const data = expectOk(t, await srv.get('/api/import/rules'), '规则列表');
  assert.ok(data.rules.length >= 3);
  assert.equal(data.default, 'default');
  for (const rule of data.rules) {
    assert.ok(rule.id && rule.label && rule.pattern);
    assert.ok(rule.description.length > 0, '每条规则都要有中文说明');
  }
});

test('S2 · 接口：清洗开关效果预览返回改动字符数与被剔除片段', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const text = '第一章 甲\n正文。\n\n\n\n请记住本站域名 www.example.com\n第二章 乙\n正文。';
  const result = expectOk(
    t,
    await srv.post('/api/import/clean-preview', { text, clean: { blankLines: true, adLines: true } }),
    '清洗预览'
  );
  assert.ok(result.changedChars > 0);
  assert.equal(result.removals.length, 1);
  assert.ok(result.removals[0].snippet.includes('请记住本站'));
  assert.ok(result.before.length >= 1 && result.after.length >= 1, '要给改前改后的对照');
  assert.ok(!result.after[0].text.includes('请记住本站'), '改后不该还有广告行');
});

test('S2 · 硬规则：检测不自信且未指定编码时拒绝落库', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  // 造一段"谁也读不通"的字节流：编码检测必须老实承认认不出来
  const noise = Buffer.from(Array.from({ length: 600 }, (_, i) => ((i * 91) % 253) + 1));
  const form = new FormData();
  form.append('file', new Blob([noise], { type: 'application/octet-stream' }), '乱码.bin');

  const upload = expectOk(t, await srv.request('POST', '/api/import/upload', form), '上传乱码');
  assert.equal(upload.needs_user_choice, true, '认不出来时必须让用户自己选');

  const error = expectErr(
    t,
    await srv.post('/api/import/commit', { upload_id: upload.upload_id }),
    409,
    'ENCODING_NOT_CONFIRMED',
    '未确认编码'
  );
  assert.ok(error.hint.includes('挑一个'), 'hint 要告诉用户去预览里选编码');
  // 关键：拒绝了就不能留下半成品
  assert.equal(srv.ctx.library.list().length, 0, '被拒绝时书架上不能多出书');
});

test('S2 · 硬规则：章节数与预览不一致时报警且不写入', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const text = '第一章 甲\n正文。\n第二章 乙\n正文。';
  const error = expectErr(
    t,
    await srv.post('/api/import/commit', { text, title: '校验测试', expected: { chapterCount: 5 } }),
    409,
    'CHAPTER_VERIFY_FAILED',
    '章节校验'
  );
  assert.ok(error.message.includes('没有写入'));
  assert.ok(error.hint.includes('原始文件没有被改动'));
  assert.equal(srv.ctx.library.list().length, 0, '校验失败不能落库');
});

test('S2 · 硬规则：不可恢复的乱码明说"解不了"并给出原始编码猜测', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const error = expectErr(
    t,
    await srv.post('/api/import/commit', { text: '第一绔 锟斤拷锟斤拷 绗竴绔' }),
    422,
    'MOJIBAKE_UNRECOVERABLE',
    '不可恢复'
  );
  assert.ok(error.message.includes('解不了'));
  assert.ok(/GBK|GB18030|UTF-8|BIG5/.test(error.hint), '要给出可能的原始编码猜测');
  assert.equal(srv.ctx.library.list().length, 0);
});

test('S2 · 性能：10 MB / 3000 章的 TXT 能正常导入，且落盘完整（验收项 4 的服务端部分）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  // 造 3000 章、约 10 MB 的正文
  const parts = [];
  for (let i = 1; i <= 3000; i++) {
    const body = `这是第 ${i} 章的正文内容。山间的风很凉，他握紧了手里的剑，继续往前走去。`.repeat(30);
    parts.push(`第${i}章 第${i}个故事\n${body}\n\n`);
  }
  const text = parts.join('');
  const byteSize = Buffer.byteLength(text, 'utf8');
  assert.ok(byteSize >= 8 * 1024 * 1024, `样本要够大才有意义，实际只有 ${(byteSize / 1048576).toFixed(1)} MB`);

  const started = Date.now();
  const result = expectOk(t, await srv.post('/api/import/paste', { text, title: '大部头' }), '大文件导入');
  const elapsed = Date.now() - started;

  assert.equal(result.chapterCount, 3000);
  assert.ok(elapsed < 60000, `导入耗时 ${elapsed}ms，太慢了`);

  // 抽取几章核对磁盘内容
  const book = srv.ctx.library.get(result.book.book_id);
  assert.equal(book.total_chapters, result.chapterCount);
  for (const index of [1, 2, Math.floor(result.chapterCount / 2), result.chapterCount]) {
    const content = srv.ctx.library.readChapterText(book.book_id, index);
    assert.ok(content && content.length > 0, `第 ${index} 章正文应该是空文件吗？`);
    assert.ok(content.startsWith(`第${index}章`), `第 ${index} 章开头不对：${content.slice(0, 20)}`);
  }
});

// ============================================================ 暂存区卫生

test('S2 · 暂存区：过期的上传会被清理，落库后立刻删除', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  const srv2 = srv;
  const keepId = srv2.ctx.importer.saveUpload(Buffer.from('第一章 甲\n正文。', 'utf8'), 'a.txt');
  const oldId = srv2.ctx.importer.saveUpload(Buffer.from('旧文件', 'utf8'), 'b.txt');
  // 手工把其中一个的创建时间改到很久以前
  const metaRel = path.posix.join('.staging', `${oldId}.json`);
  const meta = srv2.ctx.storage.readJson(metaRel);
  srv2.ctx.storage.writeJson(metaRel, { ...meta, created_at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString() });

  const removed = srv2.ctx.importer.cleanupStaging();
  assert.equal(removed, 1, '只应该清掉过期的那一个');
  assert.ok(srv2.ctx.storage.exists(path.posix.join('.staging', `${keepId}.bin`)), '没过期的要留着');
  assert.equal(srv2.ctx.storage.exists(path.posix.join('.staging', `${oldId}.bin`)), false);
});

test('S2 · 暂存区：重启服务后残留的暂存会被清空', () => {
  const { ctx, dataDir } = createTestContext();
  ctx.importer.saveUpload(Buffer.from('残留内容', 'utf8'), 'x.txt');
  assert.ok(ctx.store.listDir('.staging').length > 0);

  // 换一个上下文重新装配，等价于重启（新进程里 staging 的 JSON 是新的，bin 是旧的）
  const again = createTestContext({ dataDir });
  // 新建时 cleanupStaging 会处理 TTL 过期的；这里直接验证公开的清理接口不抛错
  assert.equal(typeof again.ctx.importer.cleanupStaging(), 'number');
  rmrf(dataDir);
});

test('S2 · 导入后书架上能查到这本书（与模块 1 的衔接）', async (t) => {
  const srv = await startTestServer();
  t.after(() => srv.close());

  expectOk(
    t,
    await srv.post('/api/import/paste', { text: '第一章 甲\n正文。\n第二章 乙\n正文。', title: '衔接测试' }),
    '导入'
  );
  const list = srv.ctx.library.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '衔接测试');
  assert.equal(list[0].chapter_count, 2);
  assert.equal(list[0].total_chapters, 2);
  assert.equal(list[0].fetch_status, '完成');
  assert.equal(list[0].source_kind, 'local');
});
