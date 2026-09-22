'use strict';
/**
 * test-env.js —— 测试用的运行时装配。
 *
 * 核心原则：测试必须跑在"和用户双击 启动.bat 完全相同"的代码路径上，
 * 只把数据目录换成临时目录。这样才能保证测试通过 == 真的能用。
 *
 * 每个测试用独立的临时 data/ ，互不干扰，也不会污染项目里的真实数据。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createContext } = require('../../server/context');
const { createApp } = require('../../server/app');
const { Store, makeBookId, contentHash } = require('../../server/services/store');

/** 建一个独立的临时目录 */
function makeTempDir(prefix = 'tmp') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `novel-tool-${prefix}-`));
}

function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    /* Windows 上偶尔文件被占用，测试清理失败不算错 */
  }
}

/**
 * 起一个测试用服务。
 * 监听 0 端口让系统分配，避免与用户正在运行的 8618 冲突。
 */
async function startTestServer(options = {}) {
  const dataDir = options.dataDir || makeTempDir('data');
  const backupDir = options.backupDir || path.join(makeTempDir('backups'), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const ctx = createContext({ ...options, dataDir, backupDir });
  const { server } = createApp(ctx);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  return {
    ctx,
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    dataDir,
    backupDir,
    /** 发请求并解出 {status, payload} */
    async request(method, apiPath, body, extra = {}) {
      const init = { method, headers: { ...(extra.headers || {}) } };
      if (body !== undefined && body !== null) {
        if (body instanceof FormData) {
          init.body = body;
        } else if (Buffer.isBuffer(body)) {
          init.body = body;
        } else {
          init.headers['Content-Type'] = 'application/json; charset=utf-8';
          init.body = JSON.stringify(body);
        }
      }
      const res = await fetch(`http://127.0.0.1:${port}${apiPath}`, init);
      const text = await res.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch (err) {
        payload = { __raw: text };
      }
      return { status: res.status, payload, headers: res.headers };
    },
    async get(apiPath) {
      return this.request('GET', apiPath);
    },
    async post(apiPath, body) {
      return this.request('POST', apiPath, body);
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** 只装配上下文、不起 HTTP 服务（测纯逻辑用） */
function createTestContext(options = {}) {
  const dataDir = options.dataDir || makeTempDir('data');
  const backupDir = options.backupDir || path.join(makeTempDir('backups'), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const ctx = createContext({ ...options, dataDir, backupDir });
  return { ctx, dataDir, backupDir };
}

/** 断言响应是成功的统一响应体，并返回 data */
function expectOk(t, result, label = '') {
  const assert = require('node:assert/strict');
  assert.equal(
    result.status,
    200,
    `${label} 期望 HTTP 200，实际 ${result.status}：${JSON.stringify(result.payload)}`
  );
  assert.equal(result.payload.ok, true, `${label} 期望 ok:true：${JSON.stringify(result.payload)}`);
  return result.payload.data;
}

/** 断言响应是失败的统一响应体，并返回 error 对象 */
function expectErr(t, result, status, code, label = '') {
  const assert = require('node:assert/strict');
  assert.equal(result.status, status, `${label} 期望 HTTP ${status}，实际 ${result.status}`);
  assert.equal(result.payload.ok, false, `${label} 期望 ok:false`);
  const error = result.payload.error;
  assert.ok(error, `${label} 必须有 error 对象`);
  assert.equal(typeof error.message, 'string', `${label} error.message 必须是字符串`);
  assert.ok(error.message.length > 0, `${label} error.message 不能为空`);
  assert.ok(error.hint !== undefined, `${label} 必须有 hint 字段`);
  if (code) assert.equal(error.code, code, `${label} 错误码应为 ${code}`);
  return error;
}

/**
 * 捕获抛出的异常对象。
 * 为什么需要：node:assert 的 assert.throws 只做断言、**不返回**异常对象，
 * 想检查 err.code / err.hint 就必须自己接住。抽成一个助手避免每处写 try/catch。
 */
function catchErr(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

module.exports = {
  makeTempDir,
  rmrf,
  startTestServer,
  createTestContext,
  expectOk,
  expectErr,
  catchErr,
  Store,
  makeBookId,
  contentHash,
};
