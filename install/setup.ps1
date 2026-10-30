<#
.SYNOPSIS
  Install DeepSeek Harness with the multimodal and memory packages, plus a `dsh-mm` command (Windows).

.DESCRIPTION
  Installs missing prerequisites with winget (Git, Node.js LTS, FFmpeg, Poppler; LibreOffice with -WithOffice),
  clones DeepSeek Harness at the base commit, applies dsh-patches, installs dependencies, and adds
  dsh-mm to your user PATH. Re-running is safe: it resets the managed checkout and re-applies the patches.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install\setup.ps1
  powershell -ExecutionPolicy Bypass -File install\setup.ps1 -WithOffice
#>
param(
  [string]$InstallDir = (Join-Path $env:USERPROFILE '.dsh-mm'),
  [switch]$WithOffice,
  [switch]$SkipSystemTools
)
$ErrorActionPreference = 'Stop'
$BaseCommit = 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3'
$Upstream = 'https://github.com/deepseek-ai/deepseek-harness.git'
$PnpmVersion = '11.28.5'
$Here = $PSScriptRoot
$Repo = Split-Path -Parent $Here
$Dsh = Join-Path $InstallDir 'deepseek-harness'
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

Step 'Checking Git, Node.js >= 24.9 and pnpm'
if (-not (Have 'git')) { Winget-Install 'Git.Git' }
if (-not (Have 'git')) { throw 'Git is required; open a new terminal after installing it and re-run' }
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

Step "Preparing DeepSeek Harness at $Dsh"
New-Item -ItemType Directory -Force -Path $InstallDir, $Bin | Out-Null
if (-not (Test-Path (Join-Path $Dsh '.git'))) {
  # LF checkout so the patches apply byte for byte; long paths for deep node_modules trees.
  git clone --filter=blob:none --no-checkout -c core.autocrlf=false -c core.longpaths=true $Upstream $Dsh; Assert-Ok 'git clone'
}
# Only needed when the base commit is no longer on a branch tip the clone fetched.
try { git -C $Dsh fetch -q origin $BaseCommit 2>$null } catch { }
git -C $Dsh checkout -q -f -B multimodal $BaseCommit; Assert-Ok 'git checkout'
$patches = Get-ChildItem (Join-Path $Repo 'dsh-patches') -Filter '*.patch' | Sort-Object Name | ForEach-Object { $_.FullName }
git -C $Dsh -c user.name=dsh-mm -c user.email=dsh-mm@localhost am -q @patches; Assert-Ok 'applying dsh-patches'

Step 'Installing dependencies (a few minutes the first time)'
Push-Location $Dsh
try {
  pnpm install --frozen-lockfile; Assert-Ok 'pnpm install'
  Step 'Building (about 3 minutes)'
  $env:NODE_OPTIONS = '--max-old-space-size=8192'
  pnpm run build:artifacts; Assert-Ok 'build'
} finally { Pop-Location }

Step 'Writing the plugin overlay and the dsh-mm launcher'
$dshFwd = $Dsh -replace '\\', '/'
$dataFwd = $InstallDir -replace '\\', '/'
$overlay = Join-Path $InstallDir 'overlay.yml'
$text = (Get-Content -Raw (Join-Path $Here 'overlay.yml.in')).Replace('@DSH@', $dshFwd).Replace('@DATA@', $dataFwd)
[IO.File]::WriteAllText($overlay, $text)
Copy-Item (Join-Path $Here 'dsh-mm.mjs') (Join-Path $Bin 'dsh-mm.mjs') -Force
[IO.File]::WriteAllText((Join-Path $Bin 'dsh-mm.json'), (@{ dsh = $Dsh; overlay = $overlay } | ConvertTo-Json))
[IO.File]::WriteAllText((Join-Path $Bin 'dsh-mm.cmd'), "@node `"%~dp0dsh-mm.mjs`" %*`r`n")
Add-UserPath $Bin

if (-not $env:DEEPSEEK_API_KEY -and -not [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY', 'User')) {
  $secure = Read-Host 'DeepSeek API key (leave empty to set DEEPSEEK_API_KEY yourself)' -AsSecureString
  $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  if ($key) { [Environment]::SetEnvironmentVariable('DEEPSEEK_API_KEY', $key, 'User') }
}

Step 'Done'
Write-Host '  Open a NEW terminal, then in any project folder:'
Write-Host '    dsh-mm                                  (Web UI in your browser)'
Write-Host '    dsh-mm headless "summarize report.pdf"'
