'use strict';
/**
 * backup-cli.js —— 供 备份.bat 调用的命令行入口。
 *
 * 为什么不让 bat 自己调 powershell 压缩：
 * Windows 的 Compress-Archive 会漏掉点开头的目录（比如 .trash），
 * 而且行为在不同系统版本上不一致。既然服务端已经有打包逻辑，
 * 让 bat 直接复用它，导出的包和设置页"整库导出"出来的完全一致。
 */

const { createContext } = require('./context');

async function main() {
  const ctx = createContext();
  try {
    const result = await ctx.backup.exportZip();
    console.log('');
    console.log('备份完成：' + result.file);
    console.log('共打包 ' + result.fileCount + ' 个文件，大小 ' + formatSize(result.size));
    console.log('');
    process.exitCode = 0;
  } catch (err) {
    console.error('');
    console.error('备份失败：' + (err && err.message ? err.message : String(err)));
    console.error('请确认没有其他程序正在占用 data 目录，然后重试。');
    console.error('');
    process.exitCode = 1;
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' 字节';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

if (require.main === module) {
  main();
}

module.exports = { main, formatSize };
