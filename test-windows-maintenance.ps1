$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-maintenance.ps1')

function Assert-Equal($Expected, $Actual, [string]$Message) {
    if ($Expected -ne $Actual) { throw "$Message. Expected '$Expected', got '$Actual'." }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ('avtopult-agent-maintenance-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
try {
    $current = Join-Path $root 'agent'
    $prepared = Join-Path $root 'prepared'
    New-Item -ItemType Directory -Path $current, $prepared | Out-Null
    Set-Content -LiteralPath (Join-Path $current 'version') -Value 'old' -NoNewline
    Set-Content -LiteralPath (Join-Path $current 'service.exe') -Value 'stable-wrapper' -NoNewline
    Set-Content -LiteralPath (Join-Path $prepared 'version') -Value 'new' -NoNewline
    $script:stops = 0
    $script:starts = 0
    $stop = { $script:stops++ }
    $start = { $script:starts++ }
    $healthy = { Assert-Equal 'new' (Get-Content -LiteralPath (Join-Path $current 'version') -Raw) 'new release was not started' }
    $backup = Invoke-AgentPayloadSwap $current $prepared @('service.exe') $stop $start $healthy
    Assert-Equal 1 $script:stops 'successful update stop count'
    Assert-Equal 1 $script:starts 'successful update start count'
    Assert-Equal 'old' (Get-Content -LiteralPath (Join-Path $backup 'version') -Raw) 'rollback copy was not preserved'
    Assert-Equal 'stable-wrapper' (Get-Content -LiteralPath (Join-Path $current 'service.exe') -Raw) 'service wrapper was replaced'

    $rejected = Join-Path $root 'rejected'
    New-Item -ItemType Directory -Path $rejected | Out-Null
    Set-Content -LiteralPath (Join-Path $rejected 'version') -Value 'bad' -NoNewline
    $failed = $false
    try { Invoke-AgentPayloadSwap $current $rejected @('service.exe') $stop $start { throw 'simulated startup failure' } | Out-Null } catch { $failed = $true }
    Assert-Equal $true $failed 'failed release was accepted'
    Assert-Equal 'new' (Get-Content -LiteralPath (Join-Path $current 'version') -Raw) 'failed update did not roll back'

    $config = Join-Path $root 'agent-config.json'
    $next = Join-Path $root 'agent-config.next.json'
    Set-Content -LiteralPath $config -Value 'old-secret' -NoNewline
    Set-Content -LiteralPath $next -Value 'new-secret' -NoNewline
    Invoke-AgentConfigSwap $config $next {} { Assert-Equal 'new-secret' (Get-Content -LiteralPath $config -Raw) 'new config was not activated' }
    Assert-Equal 'new-secret' (Get-Content -LiteralPath $config -Raw) 'successful config rotation was lost'

    $bad = Join-Path $root 'agent-config.bad.json'
    Set-Content -LiteralPath $bad -Value 'bad-secret' -NoNewline
    $failed = $false
    try { Invoke-AgentConfigSwap $config $bad {} { throw 'simulated restart failure' } } catch { $failed = $true }
    Assert-Equal $true $failed 'failed config rotation was accepted'
    Assert-Equal 'new-secret' (Get-Content -LiteralPath $config -Raw) 'failed config rotation did not roll back'
}
finally { Remove-Item -LiteralPath $root -Recurse -Force }

Write-Host 'Windows service maintenance transaction tests passed.' -ForegroundColor Green
