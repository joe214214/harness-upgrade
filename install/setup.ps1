<#
.SYNOPSIS
  Install the upgraded DeepSeek Harness in deepseek-harness\ (dependencies + build) and a `dsh-mm` command (Windows).

.DESCRIPTION
  Installs missing prerequisites with winget (Node.js LTS, FFmpeg, Poppler; LibreOffice with -WithOffice),
  installs dependencies and builds the harness in place, and adds dsh-mm to your user PATH.
  Everything else lives in one folder, -Root (default: the folder that contains this repository):
    <Root>\data      memory, speech models, the co-canvas browser profile, and the dsh-mm launcher
    <Root>\dsh-home  DSH sessions, settings and logs (DSH_HOME, set by dsh-mm only)
  The pnpm package store stays in its usual shared location. Re-running is safe.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\setup.ps1
  powershell -ExecutionPolicy Bypass -File install\setup.ps1 -WithOffice
  powershell -ExecutionPolicy Bypass -File install\setup.ps1 -Root D:\dsh
#>
param(
  [string]$Root = '',
  [switch]$WithOffice,
  [switch]$SkipSystemTools
)
$ErrorActionPreference = 'Stop'
$PnpmVersion = '11.28.5'
$Here = $PSScriptRoot
$Repo = Split-Path -Parent $Here
$Dsh = Join-Path $Repo 'deepseek-harness'
if (-not $Root) { $Root = Split-Path -Parent $Repo }
$Root = [IO.Path]::GetFullPath($Root)
$InstallDir = Join-Path $Root 'data'
$DshHome = Join-Path $Root 'dsh-home'
$Bin = Join-Path $InstallDir 'bin'

function Step($Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Have($Command) { [bool](Get-Command $Command -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}
function Add-UserPath($Dir) {
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @($current -split ';' | Where-Object { $_ })
  if ($parts -notcontains $Dir) {
    [Environment]::SetEnvironmentVariable('Path', (($parts + $Dir) -join ';'), 'User')
  }
  if (($env:Path -split ';') -notcontains $Dir) { $env:Path = "$env:Path;$Dir" }
}
function Winget-Install($Id) {
  if (-not (Have 'winget')) { throw "winget is not available; install $Id manually and re-run" }
  Write-Host "  installing $Id"
  # winget exits non-zero when the package is already installed; the Have checks below decide.
  winget install --id $Id --exact --silent --accept-source-agreements --accept-package-agreements | Out-Host
  Refresh-Path
}
# Native commands are called directly (so flags like -g reach them unchanged), then checked.
function Assert-Ok($What) { if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" } }

Step 'Checking Node.js >= 24.9 and pnpm'
$nodeOk = $false
if (Have 'node') {
  $v = [version]((node --version).TrimStart('v'))
  $nodeOk = $v -ge [version]'24.9.0'
}
if (-not $nodeOk) { Winget-Install 'OpenJS.NodeJS.LTS' }
if (-not (Have 'node')) { throw 'Node.js is required; open a new terminal after installing it and re-run' }
$v = [version]((node --version).TrimStart('v'))
if ($v -lt [version]'24.9.0') { throw "Node.js 24.9 or newer is required; found $v" }
if (-not (Have 'pnpm')) {
  Step "Installing pnpm $PnpmVersion"
  npm install -g "pnpm@$PnpmVersion"; Assert-Ok 'installing pnpm'
  Refresh-Path
}

if (-not $SkipSystemTools) {
  Step 'Checking media tools'
  if (-not (Have 'ffmpeg') -or -not (Have 'ffprobe')) { Winget-Install 'Gyan.FFmpeg' }
  if (-not (Have 'pdftoppm')) {
    Winget-Install 'oschwartz10612.Poppler'
    if (-not (Have 'pdftoppm')) {
      # The Poppler package is a portable zip; put its bin folder on PATH.
      $found = Get-ChildItem (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages') -Recurse -Filter 'pdftoppm.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($found) { Add-UserPath $found.DirectoryName }
    }
  }
  if ($WithOffice -and -not (Have 'soffice')) {
    Winget-Install 'TheDocumentFoundation.LibreOffice'
    $office = Join-Path $env:ProgramFiles 'LibreOffice\program'
    if (Test-Path (Join-Path $office 'soffice.exe')) { Add-UserPath $office }
  }
  foreach ($tool in 'pdfinfo', 'pdftotext', 'pdftoppm', 'ffmpeg', 'ffprobe') {
    if (-not (Have $tool)) { Write-Warning "$tool is still missing; the tools that need it report this when called" }
  }
  if (-not (Have 'soffice')) { Write-Host '  optional: re-run with -WithOffice so read_document can open .docx/.pptx/.xlsx' }
}

New-Item -ItemType Directory -Force -Path $InstallDir, $Bin, $DshHome | Out-Null

Step 'Installing dependencies (a few minutes the first time)'
Push-Location $Dsh
try {
  # CI=true stops lefthook from installing git hooks into this (outer) repository.
  $env:CI = 'true'
  pnpm install --frozen-lockfile; Assert-Ok 'pnpm install'
  Remove-Item Env:CI
  Step 'Building (about 3 minutes)'
  $env:NODE_OPTIONS = '--max-old-space-size=8192'
  pnpm run build:artifacts; Assert-Ok 'build'
} finally { Pop-Location }

Step 'Writing the plugin overlay and the dsh-mm launcher'
$dshFwd = $Dsh -replace '\\', '/'
$dataFwd = $InstallDir -replace '\\', '/'
$overlay = Join-Path $InstallDir 'overlay.yml'
# Co-canvas opens a visible window of the Microsoft Edge that ships with Windows, so no browser download is needed;
# the user marks the page directly in that window.
$text = (Get-Content -Raw (Join-Path $Here 'overlay.yml.in')).Replace('@DSH@', $dshFwd).Replace('@DATA@', $dataFwd).Replace('@BROWSER@', "        channel: msedge`n        headless: false")
[IO.File]::WriteAllText($overlay, $text)
Copy-Item (Join-Path $Here 'dsh-mm.mjs') (Join-Path $Bin 'dsh-mm.mjs') -Force
[IO.File]::WriteAllText((Join-Path $Bin 'dsh-mm.json'), (@{ dsh = $Dsh; overlay = $overlay; home = $DshHome } | ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $Bin 'dsh-mm.cmd'), "@node `"%~dp0dsh-mm.mjs`" %*`r`n")
Add-UserPath $Bin

if (-not $env:DEEPSEEK_API_KEY -and -not [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')) {
  $secure = Read-Host 'DeepSeek API key (leave empty to set DEEPSEEK_API_KEY yourself)' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ($key) { [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $key, 'User') }
}

Step 'Done'
Write-Host "  Harness: $Repo"
Write-Host "  Data:    $InstallDir"
Write-Host "  DSH:     $DshHome"
Write-Host '  Open a NEW terminal, then in any project folder:'
Write-Host '    dsh-mm                                  (Web UI in your browser)'
Write-Host '    dsh-mm headless "summarize report.pdf"'
