$ErrorActionPreference = "Stop"

if (-not $IsWindows) {
  throw "The Windows installer smoke must run on Windows"
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$packageMetadata = Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$expectedName = "codex-persona-voice-$($packageMetadata.version)-win-x64.exe"
$installer = Join-Path $projectRoot "artifacts/$expectedName"
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  throw "Windows installer is missing: $installer"
}

$smokeRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("cpv-installer-smoke-" + [guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $smokeRoot "app"
$dataRoot = Join-Path $smokeRoot "data"
$previousDataRoot = $env:CODEX_PERSONA_VOICE_DATA_DIR
$uninstaller = $null

try {
  New-Item -ItemType Directory -Path $installRoot, $dataRoot -Force | Out-Null
  $installProcess = Start-Process -FilePath $installer `
    -ArgumentList @("/S", "/D=$installRoot") `
    -PassThru -Wait
  if ($installProcess.ExitCode -ne 0) {
    throw "Silent installer exited with code $($installProcess.ExitCode)"
  }

  $application = Join-Path $installRoot "Codex Persona Voice.exe"
  if (-not (Test-Path -LiteralPath $application -PathType Leaf)) {
    throw "Installed application is missing: $application"
  }
  $uninstaller = Get-ChildItem -LiteralPath $installRoot -Filter "Uninstall*.exe" -File |
    Select-Object -First 1

  $env:CODEX_PERSONA_VOICE_DATA_DIR = $dataRoot
  $applicationProcess = Start-Process -FilePath $application `
    -ArgumentList @("--verify-packaged-renderer") `
    -PassThru
  if (-not $applicationProcess.WaitForExit(45000)) {
    Stop-Process -Id $applicationProcess.Id -Force -ErrorAction SilentlyContinue
    throw "Installed application did not finish renderer verification within 45 seconds"
  }
  if ($applicationProcess.ExitCode -ne 0) {
    $fatalLog = Join-Path $dataRoot "logs/launcher-fatal.log"
    $fatal = if (Test-Path -LiteralPath $fatalLog) { Get-Content $fatalLog -Raw } else { "no fatal log" }
    throw "Installed application renderer verification exited with code $($applicationProcess.ExitCode): $fatal"
  }

  $markerPath = Join-Path $dataRoot "renderer-smoke-ok.json"
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
    throw "Installed application did not write the renderer verification marker"
  }
  $marker = Get-Content $markerPath -Raw | ConvertFrom-Json
  if ($marker.version -ne $packageMetadata.version -or $marker.url -ne "persona://app/index.html") {
    throw "Unexpected renderer verification marker: $(Get-Content $markerPath -Raw)"
  }
  Write-Host "Installed renderer verified: $($marker.version) $($marker.url)"
}
finally {
  if ($null -eq $previousDataRoot) {
    Remove-Item Env:CODEX_PERSONA_VOICE_DATA_DIR -ErrorAction SilentlyContinue
  }
  else {
    $env:CODEX_PERSONA_VOICE_DATA_DIR = $previousDataRoot
  }
  if ($null -ne $uninstaller -and (Test-Path -LiteralPath $uninstaller.FullName)) {
    $uninstallProcess = Start-Process -FilePath $uninstaller.FullName -ArgumentList @("/S") -PassThru -Wait
    if ($uninstallProcess.ExitCode -ne 0) {
      Write-Warning "Silent uninstaller exited with code $($uninstallProcess.ExitCode)"
    }
  }
  Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction SilentlyContinue
}
