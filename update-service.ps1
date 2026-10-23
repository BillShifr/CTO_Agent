param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$CurrentDirectory,
    [Parameter(Mandatory = $true)][string]$ReleaseDirectory,
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$ServiceName = 'AvtoPultOneCAgent',
    [ValidateRange(10, 600)][int]$HeartbeatTimeoutSeconds = 90,
    [string]$ResultFile
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-maintenance.ps1')
Assert-AgentAdministrator
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$CurrentDirectory = (Resolve-Path -LiteralPath $CurrentDirectory).Path
$ReleaseDirectory = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
if ($CurrentDirectory -eq $ReleaseDirectory) { throw 'ReleaseDirectory must differ from CurrentDirectory.' }
if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
    $ResultFile = [IO.Path]::GetFullPath($ResultFile)
    $resultParent = Split-Path -Parent $ResultFile
    if (-not (Test-Path -LiteralPath $resultParent -PathType Container)) {
        throw 'ResultFile parent directory does not exist.'
    }
}
Test-AgentReleaseChecksums $ReleaseDirectory

$parent = Split-Path -Parent $CurrentDirectory
$prepared = Join-Path $parent ('.OneCAgent.next.' + [Guid]::NewGuid().ToString('N'))
Copy-Item -LiteralPath $ReleaseDirectory -Destination $prepared -Recurse
$wrapperName = "$ServiceName.exe"
$protectedNames = @($wrapperName, "$ServiceName.xml", 'logs')
& $NodeExe --check (Join-Path $prepared 'agent.mjs')
if ($LASTEXITCODE -ne 0) { throw 'New agent bundle failed the Node.js syntax check.' }
$previousConfig = $env:AVTOPULT_AGENT_CONFIG_FILE
$env:AVTOPULT_AGENT_CONFIG_FILE = $ConfigFile
try {
    & $NodeExe (Join-Path $prepared 'agent.mjs') --diagnose --offline | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'New agent bundle failed offline diagnostics.' }
}
finally { $env:AVTOPULT_AGENT_CONFIG_FILE = $previousConfig }

$stop = { & (Join-Path $CurrentDirectory $wrapperName) stop; if ($LASTEXITCODE -ne 0) { throw 'Failed to stop agent service.' } }
$script:agentServiceStartedAt = [DateTime]::MinValue
$start = {
    $script:agentServiceStartedAt = [DateTime]::UtcNow
    & (Join-Path $CurrentDirectory $wrapperName) start
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start agent service.' }
}
$health = {
    $service = Get-Service -Name $ServiceName
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    Start-Sleep -Seconds 5
    $service.Refresh()
    if ($service.Status -ne 'Running') { throw 'Updated agent did not remain running.' }
    Wait-AgentAcceptedHeartbeat -ConfigFile $ConfigFile -StartedAt $script:agentServiceStartedAt `
        -TimeoutSeconds $HeartbeatTimeoutSeconds | Out-Null
}
$backup = Invoke-AgentPayloadSwap $CurrentDirectory $prepared $protectedNames $stop $start $health
if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
    $release = Get-Content -LiteralPath (Join-Path $CurrentDirectory 'RELEASE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    [IO.File]::WriteAllText(
        $ResultFile,
        (@{
            backupDirectory = $backup
            sourceRevision = $release.sourceRevision
            completedAt = [DateTime]::UtcNow.ToString('o')
        } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
}
Write-Host "Agent update succeeded. Rollback copy: $backup" -ForegroundColor Green
