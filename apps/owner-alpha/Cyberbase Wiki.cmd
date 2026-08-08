@echo off
rem Double-click launcher for the private owner-alpha Cyberbase wiki.
rem Runs the WSL launcher from this file's own folder, which starts the
rem servers and opens the browser already signed in. Keep this window open
rem while using the wiki; closing it stops the wiki (a running Save job
rem resumes safely on next launch).
title Cyberbase Wiki
set "APPDIR=%~dp0"
wsl.exe bash -lc "cd \"$(wslpath '%APPDIR%')\" && bash bin/launch.sh"
pause
