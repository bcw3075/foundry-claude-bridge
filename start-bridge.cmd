@echo off
cd /d "%~dp0"
title Foundry Claude Bridge
:loop
node src\server.mjs
echo Bridge stopped (exit %errorlevel%). Restarting in 10 seconds... Press Ctrl+C to quit.
timeout /t 10 >nul
goto loop
