@echo off
REM Starts the claude-zed-shim proxy on 127.0.0.1:8124 (override: CLAUDE_ZED_SHIM_PORT).
REM Requires: claude CLI logged in (claude auth login --claudeai).
REM Copy this file (or a shortcut to it) into shell:startup to launch at login.
cd /d "%~dp0"
if not exist dist\cli.js (
  echo Building shim for the first time...
  call npm install
  call npm run build
)
set PORT=8124
if not "%CLAUDE_ZED_SHIM_PORT%"=="" set PORT=%CLAUDE_ZED_SHIM_PORT%
start "claude-zed-shim" /min node dist\cli.js serve --port %PORT%
echo Claude shim starting on http://127.0.0.1:%PORT%
