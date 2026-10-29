# Relay bootstrap for Windows.
#   .\scripts\bootstrap.ps1          start with the mock backend (no GPU needed)
#   .\scripts\bootstrap.ps1 -Gpu     start with the real models on an NVIDIA GPU
#   .\scripts\bootstrap.ps1 -Down    stop everything
#
# NOTE: this file is ASCII-only and saved with a UTF-8 BOM on purpose.
# Windows PowerShell 5.1 decodes BOM-less .ps1 files using the system ANSI code
# page, which corrupts non-ASCII text and produces confusing parser errors.

param([switch]$Gpu, [switch]$Down)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Info($m) { Write-Host "    $m" -ForegroundColor DarkGray }
function Fail($m) { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

if ($Down) {
    docker compose --profile gpu down
    Write-Host "stopped" -ForegroundColor Green
    exit 0
}

Step "1/6  Checking Docker"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Fail "Docker not found. Install Docker Desktop, reboot, then run this again."
}
docker info 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
    Fail "Docker Desktop is not running. Start it, wait for the whale icon to stop animating, then run this again."
}
Info "docker OK"

if ($Gpu) {
    Step "1b   Checking GPU"
    if (-not (Get-Command nvidia-smi -ErrorAction SilentlyContinue)) {
        Fail "nvidia-smi not found. Install the NVIDIA driver (CUDA 12.8 or newer)."
    }
    $smi = nvidia-smi | Out-String
    $m = [regex]::Match($smi, "CUDA Version:\s*(\d+\.\d+)")
    if (-not $m.Success) { Fail "Could not read the CUDA version from nvidia-smi." }
    $cuda = [double]$m.Groups[1].Value
    if ($cuda -lt 12.8) {
        Fail "Driver reports CUDA $cuda. Blackwell cards (RTX 50 series) need 12.8 or newer. Update the NVIDIA driver."
    }
    docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "Docker cannot reach the GPU. In Docker Desktop, use the WSL2 backend and enable WSL integration under Settings > Resources."
    }
    Info "CUDA $cuda, Docker can reach the GPU"
}

Step "2/6  Writing .env"
if (Test-Path .env) {
    Info ".env already exists, keeping it"
} else {
    $chars = [char[]]((48..57) + (97..122))
    $token = -join (1..32 | ForEach-Object { $chars | Get-Random })
    (Get-Content .env.example) -replace "^RELAY_ADMIN_TOKEN=.*", "RELAY_ADMIN_TOKEN=$token" |
        Set-Content .env -Encoding ASCII
    Info "created .env with a random admin token"
}
$adminMatch = Select-String -Path .env -Pattern "^RELAY_ADMIN_TOKEN=(.*)$"
if (-not $adminMatch) { Fail "RELAY_ADMIN_TOKEN missing from .env" }
$admin = $adminMatch.Matches[0].Groups[1].Value.Trim()

Step "3/6  Building and starting containers"
Info "First run downloads images and installs dependencies. Expect 5-15 minutes."
if ($Gpu) { docker compose --profile gpu up --build -d } else { docker compose up --build -d }
if ($LASTEXITCODE -ne 0) { Fail "docker compose failed. Scroll up for the error." }

Step "4/6  Waiting for the gateway"
$ready = $false
for ($i = 0; $i -lt 90; $i++) {
    try {
        $r = Invoke-RestMethod "http://localhost:8000/readyz" -TimeoutSec 2
        if ($r.ready) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 2
    Write-Host -NoNewline "."
}
Write-Host ""
if (-not $ready) {
    docker compose logs --tail 40 gateway
    Fail "Gateway did not become ready within 3 minutes. Its log is above."
}
Info "gateway ready"
if ($Gpu) { Info "GPU worker is downloading ~5GB of models: docker compose logs -f worker-gpu" }

Step "5/6  Creating an API key and sending a test request"
$key = (Invoke-RestMethod -Method Post "http://localhost:8000/admin/keys" `
    -Headers @{ "X-Admin-Token" = $admin } -ContentType "application/json" `
    -Body '{"name":"bootstrap","rpm_limit":120}').key

$body = '{"messages":[{"role":"user","content":"hello"}],"max_tokens":20}'
$deadline = (Get-Date).AddMinutes(20)
$resp = $null
while ($null -eq $resp) {
    try {
        $resp = Invoke-RestMethod -Method Post "http://localhost:8000/v1/chat/completions" `
            -Headers @{ Authorization = "Bearer $key" } -ContentType "application/json" `
            -Body $body -TimeoutSec 240
    } catch {
        if ($Gpu -and (Get-Date) -lt $deadline) {
            Write-Host -NoNewline "."
            Start-Sleep -Seconds 10
        } else {
            Write-Host ""
            docker compose logs --tail 30 worker
            Fail "Test request failed: $($_.Exception.Message)"
        }
    }
}
Write-Host ""
$text = $resp.choices[0].message.content
$len = [Math]::Min(60, $text.Length)
Info "reply:  $($text.Substring(0, $len))..."
Info "TTFT $($resp.relay.ttft_ms) ms | queued $($resp.relay.queue_wait_ms) ms | worker $($resp.relay.worker_id)"

Step "6/6  Ready"
Write-Host ""
Write-Host "    Console    http://localhost:3000    (paste both values below into the left panel)"
Write-Host "    API docs   http://localhost:8000/docs"
Write-Host "    Grafana    http://localhost:3001"
Write-Host ""
Write-Host "    admin token:  $admin"
Write-Host "    API key:      $key" -ForegroundColor Yellow
Write-Host "                  ^ shown once only, save it now"
Write-Host ""
Write-Host "    logs:  docker compose logs -f"
Write-Host "    stop:  .\scripts\bootstrap.ps1 -Down"
Write-Host ""
try { Set-Clipboard -Value $key; Info "API key copied to the clipboard" } catch { }
Start-Process "http://localhost:3000"
