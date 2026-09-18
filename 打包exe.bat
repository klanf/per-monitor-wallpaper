@echo off
REM ==================================================================
REM  One-click build: electron-wallpaper -> Windows exe
REM  Same as:  python tools\build-exe.py
REM
REM  Extra args are passed through, for example:
REM     打包exe.bat --portable          only the portable single file
REM     打包exe.bat --setup --zip       installer + zip for sharing
REM     打包exe.bat --dir               unpacked folder only (fast check)
REM     打包exe.bat --open              open dist folder when done
REM
REM  NOTE: keep this file pure ASCII. cmd parses .bat as ANSI(GBK) and
REM  UTF-8 CJK comments can swallow line breaks and break the commands.
REM ==================================================================
setlocal
cd /d "%~dp0"

set "PY=C:\Users\MyPC\.workbuddy\binaries\python\envs\default\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

"%PY%" "tools\build-exe.py" %*
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (echo [OK] build finished.) else (echo [FAILED] exit code %RC%)
pause
endlocal & exit /b %RC%
