# Windows PowerShell 启动 Web 控制台（先结束旧进程，默认开发自动重载）
$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$ConfigPath = if ($env:IP_ANNOUNCE_CONFIG) { $env:IP_ANNOUNCE_CONFIG } else { Join-Path $RootDir "config.yaml" }
$Python = Join-Path $RootDir ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    $Python = "python"
}

if (-not (Test-Path $ConfigPath)) {
    Write-Error "配置文件不存在: $ConfigPath"
    exit 1
}

$Port = if ($env:IP_ANNOUNCE_PORT) { [int]$env:IP_ANNOUNCE_PORT } else { 9010 }

function Stop-IpAnnounceWeb {
    param([int]$ListenPort = 9010)

    $stopped = 0
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'web_app\.py' } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            $stopped++
        }

    Start-Sleep -Milliseconds 600

    Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
            $stopped++
        }

    if ($stopped -gt 0) {
        Write-Host "已结束 $stopped 个占用端口 $ListenPort 的旧 Web 进程"
        Start-Sleep -Milliseconds 400
    }
}

Stop-IpAnnounceWeb -ListenPort $Port

$argsList = @("--config", $ConfigPath)
if ($env:IP_ANNOUNCE_HOST) { $argsList += @("--host", $env:IP_ANNOUNCE_HOST) }
if ($env:IP_ANNOUNCE_PORT) { $argsList += @("--port", $env:IP_ANNOUNCE_PORT) }

if ($env:IP_ANNOUNCE_NO_RELOAD -eq "1") {
    Write-Host "IP_ANNOUNCE_NO_RELOAD=1, reload disabled"
} else {
    $argsList += "--reload"
    Write-Host "Dev mode: auto reload on save (set IP_ANNOUNCE_NO_RELOAD=1 to disable)"
}

& $Python (Join-Path $RootDir "web_app.py") @argsList
