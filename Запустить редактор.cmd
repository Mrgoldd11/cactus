@echo off
rem Launches the Kenshi mod editor. If the sources changed, it rebuilds first (a few seconds).
chcp 65001 >nul
cd /d "%~dp0"
node apps\desktop\scripts\launch.ts
if errorlevel 1 pause
