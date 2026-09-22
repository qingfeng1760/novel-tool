/**
 * tools/make-bat.js —— 生成两个 .bat 启动脚本。
 *
 * 为什么用脚本生成而不是直接手写文件：
 * Windows 的 cmd 默认按系统代码页（简体中文是 GBK/936）解析批处理文件。
 * 如果 .bat 存成 UTF-8，里面的中文提示会变成乱码。
 * 这里用 iconv-lite 明确按 GBK 落盘，保证用户在资源管理器里双击后看到的是正常中文。
 */

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const ROOT = path.resolve(__dirname, '..');

const START_BAT = `@echo off
chcp 936 >nul
title 小说工具
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo   本工具需要先安装 Node.js 20 或更高版本，安装地址：https://nodejs.org
  echo.
  pause
  exit /b 1
)

echo.
echo   正在启动小说工具，稍后会自动打开浏览器……
echo   如果浏览器没有自动打开，请看下面打印出来的地址，手动复制到浏览器里。
echo.

node "server\\index.js"

echo.
echo   小说工具已经退出。数据都已保存在 data 目录里，不会丢。
echo.
pause
`;

const BACKUP_BAT = `@echo off
chcp 936 >nul
title 小说工具 - 备份
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   [错误] 没有找到 Node.js。
  echo   本工具需要先安装 Node.js 20 或更高版本，安装地址：https://nodejs.org
  echo.
  pause
  exit /b 1
)

node "server\\backup-cli.js"

echo.
pause
`;

function writeBat(name, content) {
  const target = path.join(ROOT, name);
  fs.writeFileSync(target, iconv.encode(content.replace(/\n/g, '\r\n'), 'gbk'));
  return target;
}

function main() {
  const a = writeBat('启动.bat', START_BAT);
  const b = writeBat('备份.bat', BACKUP_BAT);
  console.log('已生成：' + a);
  console.log('已生成：' + b);
}

if (require.main === module) main();

module.exports = { main, START_BAT, BACKUP_BAT };
