@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Instala Node.js 22 o posterior y vuelve a abrir esta ventana.
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0gemini-pc.cjs"
) else (
  node "%~dp0gemini-pc.cjs" %*
)
if errorlevel 1 pause
