[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BackupDirectory,
    [string]$AgentDirectory,
    [string]$ConfigFile,
    [string]$DeploymentDirectory = 'C:\ProgramData\AvtoPult\Deployment',
    [ValidateRange(10, 600)][int]$HeartbeatTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-deployment.ps1')
Assert-ProductionAdministrator
$deploymentRoot = Set-ProductionDirectoryAcl $DeploymentDirectory
$settings = Get-ProductionSettings $deploymentRoot
if ([string]::IsNullOrWhiteSpace($AgentDirectory)) { $AgentDirectory = $settings.agentDirectory }
if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = $settings.configFile }
$reports = Set-ProductionDirectoryAcl (Join-Path $deploymentRoot 'reports')
$startedAt = [DateTime]::UtcNow
$reportPath = Join-Path $reports ("restore-$($startedAt.ToString('yyyyMMdd-HHmmssfff')).json")
$resultPath = Join-Path $reports ("restore-result-$([Guid]::NewGuid().ToString('N')).json")
try {
    $AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
    $BackupDirectory = (Resolve-Path -LiteralPath $BackupDirectory).Path
    $ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
    $expectedParent = (Split-Path -Parent $AgentDirectory).TrimEnd('\')
    $actualParent = (Split-Path -Parent $BackupDirectory).TrimEnd('\')
    $expectedPrefix = (Split-Path -Leaf $AgentDirectory) + '.previous.'
    $backupName = Split-Path -Leaf $BackupDirectory
    if ($actualParent -ne $expectedParent -or -not $backupName.StartsWith($expectedPrefix)) {
        throw 'BackupDirectory is not a rollback copy created for this agent installation.'
    }
    . (Join-Path $AgentDirectory 'agent-maintenance.ps1')
    Test-AgentReleaseChecksums $BackupDirectory
    $node = Join-Path $AgentDirectory 'runtime\node.exe'
    $updater = Join-Path $AgentDirectory 'update-service.ps1'
    & $updater -NodeExe $node -CurrentDirectory $AgentDirectory -ReleaseDirectory $BackupDirectory `
        -ConfigFile $ConfigFile -HeartbeatTimeoutSeconds $HeartbeatTimeoutSeconds -ResultFile $resultPath
    if (-not $?) { throw 'Agent restore command failed.' }
    $result = Get-Content -LiteralPath $resultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-ProductionReport $reportPath @{
        operation = 'restore'
        status = 'succeeded'
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTime]::UtcNow.ToString('o')
        restoredFrom = $BackupDirectory
        replacedVersionBackup = $result.backupDirectory
        sourceRevision = $result.sourceRevision
    }
    Write-Host "Agent restore succeeded. Report: $reportPath" -ForegroundColor Green
}
catch {
    Write-ProductionReport $reportPath @{
        operation = 'restore'
        status = 'failed'
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTime]::UtcNow.ToString('o')
        restoredFrom = $BackupDirectory
        error = $_.Exception.Message
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $resultPath) { Remove-Item -LiteralPath $resultPath -Force }
}
