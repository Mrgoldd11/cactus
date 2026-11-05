@echo off
rem Запуск редактора модов Kenshi (режим разработки). Окно консоли не закрывать, пока работаете.
chcp 65001 >nul
cd /d "%~dp0"
call pnpm.cmd desktop
if errorlevel 1 pause
