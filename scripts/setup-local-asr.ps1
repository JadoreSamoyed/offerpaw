param([string]$Python, [switch]$SkipSmoke, [switch]$Start)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $taskCandidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs/Python/Python312/python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs/Python/Python311/python.exe')
    )
    $taskCommand = Get-Command python -ErrorAction SilentlyContinue
    if ($taskCommand -and $taskCommand.Source -notmatch 'WindowsApps') { $taskCandidates += $taskCommand.Source }
    $Python = $taskCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $Python) { throw 'Install Python 3.10-3.13 (64-bit), then use -Python C:/path/to/python.exe' }
$taskVenv = Join-Path $taskRoot '.cache/asr/venv'
$taskRuntime = Join-Path $taskVenv 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $taskRuntime)) {
    & $Python -m venv $taskVenv
    if ($LASTEXITCODE -ne 0) { throw 'Unable to create local ASR Python environment' }
}
& $taskRuntime -m pip install --disable-pip-version-check -r (Join-Path $taskRoot 'services/asr-local/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'ASR Python dependency installation failed' }
& $taskRuntime (Join-Path $taskRoot 'services/asr-local/download_model.py')
if ($LASTEXITCODE -ne 0) { throw 'ASR model download/verification failed' }
if (-not $SkipSmoke) {
    & $taskRuntime -X utf8 (Join-Path $taskRoot 'services/asr-local/smoke_test.py')
    if ($LASTEXITCODE -ne 0) { throw 'ASR real inference smoke test failed' }
}
Write-Host "Local ASR installed. Run: & '$taskRuntime' '$taskRoot/services/asr-local/server.py'"
if ($Start) {
    & $taskRuntime -X utf8 (Join-Path $taskRoot 'services/asr-local/server.py')
    exit $LASTEXITCODE
}
