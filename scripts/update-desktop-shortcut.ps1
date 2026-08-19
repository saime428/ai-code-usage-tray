$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version
$target = Join-Path $root "dist\AI-Code-Usage-Tray-$version-win-x64.exe"

if (-not (Test-Path -LiteralPath $target)) {
  throw "Build not found: $target"
}

$target = (Resolve-Path -LiteralPath $target).Path
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'AI Code Usage Tray.lnk'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $target
$shortcut.WorkingDirectory = Split-Path $target
$shortcut.IconLocation = "$target,0"
$shortcut.Save()

if ($shell.CreateShortcut($shortcutPath).TargetPath -ne $target) {
  throw "Shortcut target mismatch: $shortcutPath"
}

Write-Host "Desktop shortcut updated: $shortcutPath -> $target"
