[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
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
$stagingRoot = Set-ProductionDirectoryAcl (Join-Path $deploymentRoot 'staging')
$startedAt = [DateTime]::UtcNow
$reportPath = Join-Path $reports ("deploy-$($startedAt.ToString('yyyyMMdd-HHmmssfff')).json")
$staging = Join-Path $stagingRoot ([Guid]::NewGuid().ToString('N'))
$release = $null
$updateResult = Join-Path $reports ("update-$([Guid]::NewGuid().ToString('N')).json")
try {
    $AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
    $ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
    $release = Expand-VerifiedAgentArchive -Archive $Archive -ExpectedSha256 $ExpectedSha256 -Destination $staging
    $node = Join-Path $AgentDirectory 'runtime\node.exe'
    $updater = Join-Path $AgentDirectory 'update-service.ps1'
    if (-not (Test-Path -LiteralPath $node -PathType Leaf) -or -not (Test-Path -LiteralPath $updater -PathType Leaf)) {
        throw 'Installed agent is missing its runtime or update command.'
    }
    & $updater -NodeExe $node -CurrentDirectory $AgentDirectory -ReleaseDirectory $staging `
        -ConfigFile $ConfigFile -HeartbeatTimeoutSeconds $HeartbeatTimeoutSeconds -ResultFile $updateResult
    if (-not $?) { throw 'Agent update command failed.' }
    $result = Get-Content -LiteralPath $updateResult -Raw -Encoding UTF8 | ConvertFrom-Json
    Write-ProductionReport $reportPath @{
        operation = 'deploy'
        status = 'succeeded'
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTime]::UtcNow.ToString('o')
        sourceRevision = $release.sourceRevision
        archiveSha256 = $release.archiveSha256
        backupDirectory = $result.backupDirectory
        agentDirectory = $AgentDirectory
    }
    Write-Host "Production deployment succeeded. Report: $reportPath" -ForegroundColor Green
}
catch {
    Write-ProductionReport $reportPath @{
        operation = 'deploy'
        status = 'failed'
        startedAt = $startedAt.ToString('o')
        completedAt = [DateTime]::UtcNow.ToString('o')
        sourceRevision = $(if ($null -ne $release) { $release.sourceRevision } else { $null })
        error = $_.Exception.Message
        agentDirectory = $AgentDirectory
    }
    throw
}
finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
    if (Test-Path -LiteralPath $updateResult) { Remove-Item -LiteralPath $updateResult -Force }
}
