@echo off
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

node "server\index.js"

echo.
echo   小说工具已经退出。数据都已保存在 data 目录里，不会丢。
echo.
pause
