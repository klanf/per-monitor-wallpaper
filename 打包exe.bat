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

REM ---- deps: fresh clones need node_modules (electron dist is restored by its installer) ----
if not exist "node_modules\electron\dist\electron.exe" (
  echo [INFO] installing dependencies ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [FAILED] npm install failed.
    pause
    endlocal & exit /b 1
  )
)

REM ---- depth model guard: electron-builder SKIPS missing extraResources silently,
REM      which would ship an installer without the depth engine. Fail loudly here. ----
if not exist "models\depth-anything\depth_anything_v2_small.onnx" (
  echo [FAILED] missing model: models\depth-anything\depth_anything_v2_small.onnx
  echo   The ~99MB ONNX is NOT in git. Get it either way:
  echo     1. copy it from another build machine, or
  echo     2. export it:  python tools\export_onnx.py ^<HF model dir^>
  echo        (needs torch + transformers; see tools\export_onnx.py header)
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
