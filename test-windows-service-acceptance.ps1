param([Parameter(Mandatory = $true)][string]$WinSWExe)

$ErrorActionPreference = 'Stop'
$serviceName = 'AvtoPultOneCAgent'
$root = Join-Path ([IO.Path]::GetTempPath()) ('avtopult-agent-service-' + [Guid]::NewGuid().ToString('N'))
$current = Join-Path $root 'current'
$goodRelease = Join-Path $root 'release-good'
$badRelease = Join-Path $root 'release-bad'
$state = Join-Path $root 'state'
$config = Join-Path $root 'agent-config.json'
$marker = Join-Path $root 'started-version.txt'

function Write-StubRelease([string]$Directory, [string]$Version, [bool]$StayRunning) {
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    $stayRunningLiteral = if ($StayRunning) { 'true' } else { 'false' }
    $escapedMarker = $marker.Replace('\', '\\')
    $escapedReceipt = (Join-Path $state 'heartbeat-receipt.json').Replace('\', '\\')
    $source = @"
import { writeFileSync } from 'node:fs';
if (process.argv.includes('--diagnose')) process.exit(0);
writeFileSync('$escapedMarker', '$Version', 'utf8');
writeFileSync('$escapedReceipt', JSON.stringify({ agentId: 'windows-acceptance', acceptedAt: new Date().toISOString() }), 'utf8');
if (!$stayRunningLiteral) process.exit(23);
setInterval(() => {}, 1000);
"@
    [IO.File]::WriteAllText((Join-Path $Directory 'agent.mjs'), $source, [Text.UTF8Encoding]::new($false))
    $hash = (Get-FileHash -LiteralPath (Join-Path $Directory 'agent.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $Directory 'SHA256SUMS'), "$hash  agent.mjs`n", [Text.UTF8Encoding]::new($false))
}

function Wait-Marker([string]$Expected) {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        if ((Test-Path -LiteralPath $marker) -and ((Get-Content -LiteralPath $marker -Raw) -eq $Expected)) { return }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Service did not start release '$Expected'."
}

New-Item -ItemType Directory -Path $root, $current, $state -Force | Out-Null
try {
    Write-StubRelease $current 'old' $true
    Write-StubRelease $goodRelease 'good' $true
    Write-StubRelease $badRelease 'bad' $false
    $settings = @{
        AVTOPULT_AGENT_ID = 'windows-acceptance'
        AVTOPULT_API_URL = 'https://example.invalid'
        AVTOPULT_AGENT_SECRET = 'test-agent-secret'
        ONE_C_WRITE_URL = 'http://127.0.0.1/hs/avtopult'
        ONE_C_USERNAME = 'test'
        ONE_C_PASSWORD = 'test-one-c-password'
        ONE_C_ODATA_URL = 'http://127.0.0.1/odata/standard.odata'
        ONE_C_ODATA_USERNAME = 'test'
        ONE_C_ODATA_PASSWORD = 'test-odata-password'
        AVTOPULT_AGENT_STATE_DIR = $state
    }
    [IO.File]::WriteAllText($config, ($settings | ConvertTo-Json), [Text.UTF8Encoding]::new($false))

    & (Join-Path $PSScriptRoot 'install-service.ps1') -NodeExe (Get-Command node.exe).Source -AgentDirectory $current -WinSWExe $WinSWExe -ConfigFile $config
    Wait-Marker 'old'

    $installAcl = Get-Acl -LiteralPath $current
    if (-not $installAcl.AreAccessRulesProtected) { throw 'Agent installation directory still inherits permissions.' }
    $allowedInstallerSids = @('S-1-5-18', 'S-1-5-32-544')
    foreach ($rule in $installAcl.Access) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowedInstallerSids) {
            throw "Unexpected installation-directory access rule: $sid"
        }
    }

    $reinstallFailed = $false
    try {
        & (Join-Path $PSScriptRoot 'install-service.ps1') -NodeExe (Get-Command node.exe).Source -AgentDirectory $current -WinSWExe $WinSWExe -ConfigFile $config
    }
    catch { $reinstallFailed = $true }
    if (-not $reinstallFailed) { throw 'A second install replaced the running service instead of requiring update-service.ps1.' }
    $serviceAfterRejectedInstall = Get-Service -Name $serviceName
    $serviceAfterRejectedInstall.Refresh()
    if ($serviceAfterRejectedInstall.Status -ne 'Running') { throw 'Rejected reinstall disrupted the running service.' }

    & (Join-Path $PSScriptRoot 'update-service.ps1') -NodeExe (Get-Command node.exe).Source -CurrentDirectory $current -ReleaseDirectory $goodRelease -ConfigFile $config
    Wait-Marker 'good'

    $failed = $false
    try {
        & (Join-Path $PSScriptRoot 'update-service.ps1') -NodeExe (Get-Command node.exe).Source -CurrentDirectory $current -ReleaseDirectory $badRelease -ConfigFile $config
    }
    catch { $failed = $true }
    if (-not $failed) { throw 'A release whose service exits immediately was accepted.' }
    Wait-Marker 'good'
    $service = Get-Service -Name $serviceName
    $service.Refresh()
    if ($service.Status -ne 'Running') { throw 'The previous service was not restored after the failed update.' }
}
finally {
    if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
        & (Join-Path $PSScriptRoot 'uninstall-service.ps1') -AgentDirectory $current
    }
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}

Write-Host 'Windows service install, update and rollback acceptance passed.' -ForegroundColor Green
