@echo off
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

node "server\backup-cli.js"

echo.
pause
