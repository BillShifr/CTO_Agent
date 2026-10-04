param([Parameter(Mandatory = $true)][string]$AgentDirectory)

$ErrorActionPreference = 'Stop'
$serviceName = 'AvtoPultOneCAgent'
$AgentDirectory = (Resolve-Path $AgentDirectory).Path
$wrapper = Join-Path $AgentDirectory "$serviceName.exe"
if (-not (Test-Path $wrapper -PathType Leaf)) {
    throw "Service wrapper was not found: $wrapper"
}

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
    Write-Host 'AvtoPult 1C Integration Agent is not installed.'
    exit 0
}
if ($service.Status -ne 'Stopped') {
    & $wrapper stop
    if ($LASTEXITCODE -ne 0) { throw 'Failed to stop the agent service.' }
}
& $wrapper uninstall
if ($LASTEXITCODE -ne 0) { throw 'Failed to uninstall the agent service.' }
Write-Host 'AvtoPult 1C Integration Agent was uninstalled. State data was preserved.' -ForegroundColor Green
