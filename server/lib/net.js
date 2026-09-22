'use strict';
/**
 * net.js —— 端口选择。
 *
 * 为什么需要：
 * PRD 硬约束要求"只监听 127.0.0.1"，并且 8618 被占用时要"自动顺延空闲端口并打印实际地址"。
 * 这里用"真去 listen 一下看会不会 EADDRINUSE"来判断端口是否可用，
 * 而不是去看系统端口表——后者在 Windows 上既慢又不可靠。
 */

const net = require('net');

const DEFAULT_START_PORT = 8618;
const DEFAULT_HOST = '127.0.0.1';

/** 探测单个端口是否可绑定 */
function tryListen(port, host) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.unref();
    tester.once('error', (err) => {
      tester.close(() => {});
      resolve({ ok: false, code: err.code });
    });
    tester.once('listening', () => {
      tester.close(() => resolve({ ok: true, port }));
    });
    tester.listen(port, host);
  });
}

/**
 * 从 startPort 开始，顺延找出第一个可用端口。
 * @returns {Promise<number>}
 */
async function findFreePort(startPort = DEFAULT_START_PORT, host = DEFAULT_HOST, maxTries = 50) {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    // eslint-disable-next-line no-await-in-loop
    const result = await tryListen(port, host);
    if (result.ok) return port;
  }
  const err = new Error('端口全被占用了');
  err.code = 'NO_FREE_PORT';
  throw err;
}

module.exports = { findFreePort, tryListen, DEFAULT_START_PORT, DEFAULT_HOST };
