param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$AgentDirectory,
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$ServiceName = 'AvtoPultOneCAgent',
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
$bundle = Join-Path $AgentDirectory 'agent.mjs'
if (-not (Test-Path -LiteralPath $bundle -PathType Leaf)) { throw "Agent bundle was not found: $bundle" }

$acl = Get-Acl -LiteralPath (Split-Path -Parent $ConfigFile)
if (-not $acl.AreAccessRulesProtected) { throw 'Agent state directory still inherits permissions.' }
$allowed = @('S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $acl.Access) {
    $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
    if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed) {
        throw "Unexpected state-directory access rule: $sid"
    }
}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) { throw "Service is not installed: $ServiceName" }
if ($service.Status -ne 'Running') { throw "Service is not running: $($service.Status)" }

$arguments = @($bundle, '--diagnose')
if ($Offline) { $arguments += '--offline' }
$previous = $env:AVTOPULT_AGENT_CONFIG_FILE
$env:AVTOPULT_AGENT_CONFIG_FILE = $ConfigFile
try {
    $output = & $NodeExe @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Agent diagnostics failed.' }
    $report = $output | ConvertFrom-Json
    if (-not $report.ok) { throw 'Agent diagnostics reported a failed check.' }
    $report.checks | Select-Object name, status, detail | Format-Table -AutoSize
}
finally {
    $env:AVTOPULT_AGENT_CONFIG_FILE = $previous
}
