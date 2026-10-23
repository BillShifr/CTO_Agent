[CmdletBinding()]
param(
    [string]$AgentDirectory,
    [string]$RunnerDirectory,
    [string]$ConfigFile,
    [string]$DeploymentDirectory = 'C:\ProgramData\AvtoPult\Deployment',
    [switch]$Offline,
    [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-deployment.ps1')
Assert-ProductionAdministrator
$settings = Get-ProductionSettings $DeploymentDirectory
if ([string]::IsNullOrWhiteSpace($AgentDirectory)) { $AgentDirectory = $settings.agentDirectory }
if ([string]::IsNullOrWhiteSpace($RunnerDirectory)) { $RunnerDirectory = $settings.runnerDirectory }
if ([string]::IsNullOrWhiteSpace($ConfigFile)) { $ConfigFile = $settings.configFile }
$checks = [Collections.Generic.List[object]]::new()
$startedAt = [DateTime]::UtcNow

function Add-Check([string]$Name, [string]$Status, [string]$Detail) {
    $checks.Add([pscustomobject]@{ name = $Name; status = $Status; detail = $Detail })
}

function Invoke-Check([string]$Name, [scriptblock]$Action) {
    try {
        $detail = & $Action
        Add-Check $Name 'ok' ([string]$detail)
    }
    catch {
        Add-Check $Name 'failed' $_.Exception.Message
    }
}

Invoke-Check 'agent-service' {
    $service = Get-CimInstance Win32_Service -Filter "Name='AvtoPultOneCAgent'"
    if ($null -eq $service) { throw 'Service is not installed.' }
    if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto') {
        throw "state=$($service.State), startMode=$($service.StartMode)"
    }
    "state=$($service.State), startMode=$($service.StartMode)"
}
Invoke-Check 'runner-service' {
    $serviceName = Get-ProductionRunnerServiceName $RunnerDirectory
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
    if ($null -eq $service) { throw 'Service is not installed.' }
    if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto') {
        throw "state=$($service.State), startMode=$($service.StartMode)"
    }
    "name=$serviceName, state=$($service.State), startMode=$($service.StartMode)"
}
Invoke-Check 'agent-directory-acl' {
    if (-not (Test-ProductionDirectoryAcl $AgentDirectory)) { throw 'Unexpected write access or inherited ACL.' }
    'restricted to SYSTEM and Administrators'
}
Invoke-Check 'runner-directory-acl' {
    if (-not (Test-ProductionDirectoryAcl $RunnerDirectory)) { throw 'Unexpected write access or inherited ACL.' }
    'restricted to SYSTEM and Administrators'
}
Invoke-Check 'deployment-directory-acl' {
    if (-not (Test-ProductionDirectoryAcl $DeploymentDirectory)) { throw 'Unexpected write access or inherited ACL.' }
    'restricted to SYSTEM and Administrators'
}
Invoke-Check 'runner-policy' {
    $policy = Get-Content -LiteralPath (Join-Path $DeploymentDirectory 'runner-policy.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($policy.workflowRef -notmatch '/\.github/workflows/deploy-agent\.yml@refs/heads/main$') {
        throw 'Runner policy is not pinned to deploy-agent.yml on main.'
    }
    $policy.workflowRef
}
Invoke-Check 'agent-release' {
    $release = Get-Content -LiteralPath (Join-Path $AgentDirectory 'RELEASE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($release.sourceRevision -notmatch '^[a-f0-9]{40}$') { throw 'Invalid source revision.' }
    "version=$($release.version), revision=$($release.sourceRevision)"
}
Invoke-Check 'heartbeat' {
    $settings = Get-Content -LiteralPath $ConfigFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $receiptPath = Join-Path $settings.AVTOPULT_AGENT_STATE_DIR 'heartbeat-receipt.json'
    $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $acceptedAt = [DateTime]::Parse($receipt.acceptedAt).ToUniversalTime()
    if ($receipt.agentId -ne $settings.AVTOPULT_AGENT_ID) { throw 'Heartbeat belongs to another agent.' }
    if ([DateTime]::UtcNow - $acceptedAt -gt [TimeSpan]::FromMinutes(10)) { throw 'Last accepted heartbeat is older than 10 minutes.' }
    "acceptedAt=$($acceptedAt.ToString('o'))"
}
Invoke-Check 'free-space' {
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($AgentDirectory).TrimEnd(':\'))
    if ($drive.Free -lt 2GB) { throw "Only $($drive.Free) bytes are free." }
    "$($drive.Free) bytes free"
}

if (-not $Offline) {
    foreach ($endpoint in @(
        @{ uri = 'https://github.com/'; name = 'github' },
        @{ uri = 'https://api.github.com/'; name = 'github-api' }
    )) {
        Invoke-Check $endpoint.name { (Test-ProductionHttpsEndpoint $endpoint.uri $endpoint.name).detail }
    }
}

Invoke-Check 'agent-diagnostics' {
    $node = Join-Path $AgentDirectory 'runtime\node.exe'
    $arguments = @('-NodeExe', $node, '-AgentDirectory', $AgentDirectory, '-ConfigFile', $ConfigFile)
    if ($Offline) { $arguments += '-Offline' }
    & (Join-Path $AgentDirectory 'diagnose-agent.ps1') @arguments | Out-String
}

$failed = @($checks | Where-Object status -eq 'failed').Count
if ([string]::IsNullOrWhiteSpace($ReportPath)) {
    $reportDirectory = Set-ProductionDirectoryAcl (Join-Path $DeploymentDirectory 'reports')
    $ReportPath = Join-Path $reportDirectory ("diagnostics-$($startedAt.ToString('yyyyMMdd-HHmmssfff')).json")
}
Write-ProductionReport $ReportPath @{
    operation = 'diagnostics'
    status = $(if ($failed -eq 0) { 'succeeded' } else { 'failed' })
    startedAt = $startedAt.ToString('o')
    completedAt = [DateTime]::UtcNow.ToString('o')
    machine = [Environment]::MachineName
    checks = @($checks)
}
$checks | Format-Table -AutoSize
Write-Host "Diagnostic report: $ReportPath"
if ($failed -gt 0) { throw "$failed production diagnostic check(s) failed." }
