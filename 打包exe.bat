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

REM ---- depth model: auto-download if missing (r36) ----
REM Source: onnx-community/depth-anything-v2-small fp32 (HF). Verified against
REM our own export on 2026-10-10: predicted_depth pixel-identical (CORR=1.0000,
REM MAD=0/255), same output name and dims. SHA256 below pins what we test.
if exist "models\depth-anything\depth_anything_v2_small.onnx" goto :havemodel

echo [INFO] depth model missing. Downloading ~99MB (onnx-community fp32, HF mirror)...
if not exist "models\depth-anything" mkdir "models\depth-anything"
set "MTMP=models\depth-anything\model.onnx.tmp"
set "MURL1=https://hf-mirror.com/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
set "MURL2=https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"

where curl.exe >nul 2>nul
if errorlevel 1 goto :dl_ps1

curl.exe -L --fail --retry 2 -o "%MTMP%" "%MURL1%"
if errorlevel 1 goto :dl_hf
goto :dl_check

:dl_ps1
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri $env:MURL1 -OutFile $env:MTMP"
if errorlevel 1 goto :dl_hf
goto :dl_check

:dl_hf
echo [INFO] mirror failed, trying huggingface.co ...
where curl.exe >nul 2>nul
if errorlevel 1 (
  powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol='Tls12'; Invoke-WebRequest -Uri $env:MURL2 -OutFile $env:MTMP"
  if errorlevel 1 goto :dl_fail
) else (
  curl.exe -L --fail --retry 2 -o "%MTMP%" "%MURL2%"
  if errorlevel 1 goto :dl_fail
)
goto :dl_check

:dl_check
certutil -hashfile "%MTMP%" SHA256 | findstr /i "afb6a5c28f3b6bf1618c6e43f02073ef9dfdc70e937502d51603e57b0a1df10c" >nul
if errorlevel 1 goto :dl_corrupt
move /y "%MTMP%" "models\depth-anything\depth_anything_v2_small.onnx" >nul
echo [OK] depth model downloaded and verified.
goto :havemodel

:dl_corrupt
echo [FAILED] downloaded model failed SHA256 check (incomplete download). Delete and retry.
del /q "%MTMP%" 2>nul
pause
endlocal & exit /b 1

:dl_fail
echo [FAILED] could not download the depth model. Get it manually:
echo   1. browser: https://hf-mirror.com/onnx-community/depth-anything-v2-small
echo      (file onnx/model.onnx -^> rename to models\depth-anything\depth_anything_v2_small.onnx)
echo   2. copy models\depth-anything\depth_anything_v2_small.onnx from another build machine
echo   3. export from weights yourself:  python tools\export_onnx.py ^<HF model dir^>
del /q "%MTMP%" 2>nul
pause
endlocal & exit /b 1

:havemodel

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
