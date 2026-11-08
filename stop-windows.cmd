@echo off
set PORT=8124
if not "%CLAUDE_ZED_SHIM_PORT%"=="" set PORT=%CLAUDE_ZED_SHIM_PORT%
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue; if ($conns) { $conns | ForEach-Object { Stop-Process -Id ($_.OwningProcess) -Force }; Write-Host 'Claude shim stopped.' } else { Write-Host 'No process running on port' %PORT% '.' }"