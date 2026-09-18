@echo off
rem Recording-mode launcher for the wallpaper app, with CDP port 9222.
rem NOTE 1: ELECTRON_RUN_AS_NODE must be cleared first - the outer env injects it;
rem         if present (even =0), Electron degrades to pure Node and crashes.
rem NOTE 2: do NOT add --enable-logging - it pops a console window into the recording.
rem NOTE 3: CalculateNativeWinOcclusion MUST stay disabled. Under streaming/recording
rem         setups Chromium's native occlusion detection misfires ("window fully
rem         covered"), freezing the compositor: panel/menu animations stick on their
rem         first frame (info panel stuck at translateX(-404px), invisible) and input
rem         dispatch gets swallowed. Root cause #2 of the 2026-09-13 take losses.
rem Keep this file ASCII-only: cmd parses .bat in the ANSI codepage, and UTF-8
rem Chinese comment bytes can swallow the following newline and kill the start line.
set ELECTRON_RUN_AS_NODE=
cd /d D:\workbuddy\2026-09-10-17-57-11\electron-wallpaper
start "electron-wallpaper" /b node_modules\electron\dist\electron.exe . --remote-debugging-port=9222 --disable-features=CalculateNativeWinOcclusion
