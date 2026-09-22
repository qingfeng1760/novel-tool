'use strict';
/**
 * browser.js —— 打开系统默认浏览器。
 *
 * 为什么不用第三方库：
 * 需求只说"服务起来后自动打开默认浏览器"，三个平台各一条命令就够了，
 * 为此装一个 open 包不划算。
 *
 * 注意：测试环境里必须能关掉（NOVEL_TOOL_NO_BROWSER=1），
 * 否则跑测试会不停地弹浏览器窗口。
 */

const { spawn } = require('child_process');

function openBrowser(url, options = {}) {
  if (process.env.NOVEL_TOOL_NO_BROWSER === '1' && !options.force) {
    return { opened: false, reason: '测试环境已禁用自动开浏览器' };
  }

  let command;
  let args;

  if (process.platform === 'win32') {
    // `start` 是 cmd 的内建命令，前面那个空字符串是 start 的"窗口标题"占位参数，
    // 少了它，带引号的 URL 会被 start 当成标题而不是地址。
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { opened: true, command, args };
  } catch (err) {
    // 打不开浏览器不算致命错误：控制台里已经打印了地址，用户自己复制也能用
    return { opened: false, reason: err.message };
  }
}

module.exports = { openBrowser };
