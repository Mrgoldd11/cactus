@echo off
rem Запуск редактора модов Kenshi. Если исходники менялись, сначала пересобирается (несколько секунд).
chcp 65001 >nul
cd /d "%~dp0"
node apps\desktop\scripts\launch.ts
if errorlevel 1 pause
