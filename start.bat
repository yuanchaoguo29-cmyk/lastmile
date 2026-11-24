@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo   最后一公里 . LastMile
echo   ----------------------------------------
echo   正在启动，浏览器会自动打开...
echo   关闭这个窗口就停止服务。
echo.
start "" http://localhost:3000/#/c
node --env-file-if-exists=.env server/index.js
pause
