@echo off
title Cyberbaser - Docs
REM Double-click to start the Astro Starlight docs dev server (runs inside WSL).
REM Close the window or Ctrl+C to stop.
echo.
echo  ================================================================
echo   Cyberbaser - Documentation (Astro + Starlight)
echo.
echo   Docs:  http://localhost:4321/cyberbaser/
echo.
echo   Ctrl+C to stop. Window stays open after exit.
echo  ================================================================
echo.
wsl --cd "%~dp0docs" -- bash -lc "bun run dev:host"
echo.
echo (server stopped)
pause
