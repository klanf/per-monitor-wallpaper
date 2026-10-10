@echo off
REM ==================================================================
REM  One-click build: electron-wallpaper -> Windows NSIS installer
REM  Now pure npm/electron-builder (r27): no Python anywhere in the
REM  build chain. Same as:  npm run dist
REM
REM  Extra args are passed through to electron-builder, for example:
REM     build-exe.bat --dir          unpacked folder only (fast check)
REM     build-exe.bat --portable     portable single file
REM
REM  NOTE: keep this file pure ASCII. cmd parses .bat as ANSI(GBK) and
REM  UTF-8 CJK comments can swallow line breaks and break the commands.
REM ==================================================================
setlocal
cd /d "%~dp0"

set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

where npm >nul 2>nul
if errorlevel 1 (
  echo [FAILED] npm not found in PATH. Install Node.js first.
  pause
  endlocal & exit /b 1
)

call npm run dist -- %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [OK] build finished. Installer in dist\ folder.
  explorer dist
) else (
  echo [FAILED] exit code %RC%
)
pause
endlocal & exit /b %RC%
