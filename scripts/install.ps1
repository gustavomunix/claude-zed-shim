# Installs the claude-zed-shim proxy on Windows: installs/builds the project
# and (optionally) registers a per-account entry in the Startup shell:startup.
#
# Usage:
#   .\scripts\install.ps1                          # install deps + build (no startup)
#   .\scripts\install.ps1 -Startup                 # same, registered at password-on
#   .\scripts\install.ps1 -Startup -Port 8125 -ConfigDir "$HOME\.claude-account2" -ProviderId claude-code-luciana
#   .\scripts\install.ps1 -Startup -Port 8124 -ProviderId claude-code-mletras
#   .\scripts\install.ps1 -Uninstall -Port 8125
param(
    [int]$Port = 8124,
    [string]$ConfigDir = "",
    [string]$ProviderId = "claude-code",
    [switch]$Startup,
    [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$generatedCmd = Join-Path $root "serve-$Port.generated.cmd"
$shortcutName = "claude-zed-shim-$Port.lnk"
$shortcut = Join-Path "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" $shortcutName

if ($Uninstall) {
    foreach ($candidate in @($shortcut, $generatedCmd)) {
        if (Test-Path $candidate) {
            Remove-Item $candidate -Force
            Write-Host "Removed $candidate"
        }
    }
    Write-Host "Uninstalled claude-zed-shim on port $Port"
    return
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "node not found in PATH"
}

Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root "node_modules"))) {
        npm install --no-audit --no-fund
    }
    npm run build
} finally {
    Pop-Location
}

if (-not $Startup) {
    Write-Host "Built. To run now:"
    Write-Host "  node dist\cli.js serve --port $Port  (add --config-dir / --provider-id as needed)"
    Write-Host "Run again with -Startup to register at password-on."
    return
}

$cliArgs = "serve --port $Port"
if ($ConfigDir.Trim()) { $cliArgs = "$cliArgs --config-dir `"$($ConfigDir.Trim())`"" }
$cliArgs = "$cliArgs --provider-id $ProviderId"

$cmdContent = "@echo off`r`ncd /d `"$root`"`r`nstart `"`" /min node dist\cli.js $cliArgs`r`n"
Set-Content -Path $generatedCmd -Value $cmdContent -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($shortcut)
$lnk.TargetPath = "$env:ComSpec"
$lnk.Arguments = "/c `"$generatedCmd`""
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7
$lnk.Save()

Write-Host "Registered claude-zed-shim on port $Port at password-on (shortcut: $shortcut)."
Write-Host "Remove later with: .\scripts\install.ps1 -Uninstall -Port $Port"
