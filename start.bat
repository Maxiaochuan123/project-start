@echo off
title Server
color 07

:: 设置默认的 Node.js 版本（使用最新版本）
call nvm use 18.20.4

echo Starting server...
node server.js
if errorlevel 1 goto error
goto end

:error
color 0c
echo Server failed to start
pause
exit /b 1

:end
pause