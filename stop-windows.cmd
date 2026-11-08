@echo off
powershell -NoProfile -Command "$conns = Get-NetTCPConnection -LocalPort 8124 -ErrorAction SilentlyContinue; if ($conns) { $conns | ForEach-Object { Stop-Process -Id ($_.OwningProcess) -Force }; Write-Host 'Claude shim stopped.' } else { Write-Host 'No process running on port 8124.' }"
