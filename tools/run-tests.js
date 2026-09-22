'use strict';
/**
 * run-tests.js —— 统一跑全部阶段测试并给出中文汇总。
 *
 * 为什么不用 `node --test tests/`：
 *   1. 那样会把 tests/helpers/ 下的工具文件也当成测试文件扫进去；
 *   2. 我们希望"全部完成后再跑一次所有测试"这件事有一份可读的中文报告，
 *      而不只是 TAP 输出。
 *
 * 用法：
 *   node tools/run-tests.js            跑全部
 *   node tools/run-tests.js s3 s4      只跑 S3 与 S4
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');

/** 按阶段号排序，保证输出顺序和开发顺序一致 */
function listStageTests() {
  return fs
    .readdirSync(TESTS_DIR)
    .filter((name) => /^s\d+-.*\.test\.js$/.test(name))
    .sort((a, b) => {
      const na = Number(/^s(\d+)/.exec(a)[1]);
      const nb = Number(/^s(\d+)/.exec(b)[1]);
      return na - nb;
    })
    .map((name) => ({
      stage: 'S' + Number(/^s(\d+)/.exec(name)[1]),
      file: name,
      full: path.join(TESTS_DIR, name),
    }));
}

function runOne(file) {
  const result = spawnSync(process.execPath, ['--test', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const pass = Number((/# pass (\d+)/.exec(output) || [])[1] || 0);
  const fail = Number((/# fail (\d+)/.exec(output) || [])[1] || 0);
  const tests = Number((/# tests (\d+)/.exec(output) || [])[1] || 0);
  const failures = output
    .split('\n')
    .filter((line) => /^not ok /.test(line))
    .map((line) => line.replace(/^not ok \d+ - /, '').trim());
  const errorLines = output
    .split('\n')
    .filter((line) => /^\s*(error|AssertionError|TypeError|ReferenceError)\b/.test(line.trim()))
    .slice(0, 6);

  return { pass, fail, tests, failures, errorLines, code: result.status, output };
}

function main() {
  const wanted = process.argv.slice(2).map((s) => s.toUpperCase().replace(/^S/, ''));
  let stages = listStageTests();
  if (wanted.length) {
    stages = stages.filter((s) => wanted.includes(s.stage.replace(/^S/, '')));
  }

  if (!stages.length) {
    console.log('没有找到任何测试文件。');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log('小说工具 · 阶段测试总览');
  console.log('='.repeat(60));

  let totalPass = 0;
  let totalFail = 0;
  let totalTests = 0;
  const broken = [];

  for (const stage of stages) {
    const r = runOne(stage.full);
    totalPass += r.pass;
    totalFail += r.fail;
    totalTests += r.tests;
    const mark = r.fail === 0 && r.code === 0 ? '通过' : '未通过';
    console.log(
      `${stage.stage.padEnd(4)} ${stage.file.padEnd(30)} ${String(r.pass).padStart(3)} 通过 / ${String(
        r.fail
      ).padStart(3)} 失败  [${mark}]`
    );
    if (r.fail > 0 || r.code !== 0) {
      broken.push({ stage: stage.stage, file: stage.file, ...r });
    }
  }

  console.log('='.repeat(60));
  console.log(`合计：${totalTests} 个用例，${totalPass} 通过，${totalFail} 失败`);
  console.log('');

  if (broken.length) {
    for (const b of broken) {
      console.log(`---- ${b.stage} ${b.file} 失败明细 ----`);
      for (const name of b.failures) console.log('  未通过：' + name);
      for (const line of b.errorLines) console.log('  ' + line);
      console.log('');
    }
    console.log('有测试未通过，请先修复再继续。');
    process.exitCode = 1;
    return;
  }

  console.log('全部阶段测试通过。');
  process.exitCode = 0;
}

if (require.main === module) main();

module.exports = { listStageTests, runOne };
