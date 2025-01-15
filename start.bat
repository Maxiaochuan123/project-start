@echo off
title Server
color 07
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