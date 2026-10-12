[CmdletBinding()]
param(
    [string]$ApiUrl,
    [string]$OneCBaseUrl,
    [string]$ReadUser,
    [string]$WriteUser,
    [string]$NodeExe,
    [switch]$AllowLocalHttp,
    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$agentDirectory = $PSScriptRoot
$configFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json'
if (-not $NodeExe) { $NodeExe = Join-Path $agentDirectory 'runtime/node.exe' }

# Preflight never enrolls, claims work or changes an existing service.
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as Administrator.'
}
if (Get-Service -Name AvtoPultOneCAgent -ErrorAction SilentlyContinue) {
    throw 'Service already exists. Use diagnose-agent.ps1 or update-service.ps1; nothing was changed.'
}
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) {
    throw 'Node.js 22.20+ (major 22) is required. Install it before setup; nothing was changed.'
}
$root = [IO.Path]::GetFullPath($agentDirectory).TrimEnd('\') + '\'
$listedFiles = @{}
foreach ($line in Get-Content -LiteralPath (Join-Path $root 'SHA256SUMS') -Encoding UTF8) {
    if ($line -notmatch '^([a-fA-F0-9]{64})  (.+)$') { throw 'Invalid checksum manifest.' }
    $hash = $Matches[1]
    $relative = $Matches[2]
    $file = [IO.Path]::GetFullPath((Join-Path $root $relative))
    if (-not $file.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Checksum manifest points outside the package.'
    }
    if ($listedFiles.ContainsKey($relative)) { throw 'Duplicate checksum entry.' }
    $listedFiles[$relative] = $true
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne $hash) {
        throw "Package checksum mismatch: $relative"
    }
}
foreach ($required in @('agent.mjs', 'WinSW-x64.exe', 'configure-environment.ps1', 'agent-maintenance.ps1', 'install-service.ps1', 'diagnose-agent.ps1', 'setup-agent.ps1')) {
    if (-not $listedFiles.ContainsKey($required)) { throw "Package manifest is missing: $required" }
}
if ($NodeExe -eq (Join-Path $agentDirectory 'runtime/node.exe') -and -not $listedFiles.ContainsKey('runtime/node.exe')) {
    throw 'Bundled runtime is missing from checksum manifest.'
}
if ((Get-FileHash -LiteralPath (Join-Path $root 'WinSW-x64.exe') -Algorithm SHA256).Hash -ne '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da') {
    throw 'Untrusted WinSW binary.'
}
Write-Host 'Package and runtime: OK. This does NOT confirm native 1C acceptance.'
$runtimeVersion = & $NodeExe -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or $runtimeVersion -notmatch '^22\.(\d+)\.\d+$' -or [int]$Matches[1] -lt 20) {
    throw 'Unsupported Node.js. Use version 22.20+ within major 22.'
}
if ($PreflightOnly) { return }

if (-not (Test-Path -LiteralPath $configFile)) {
    if (-not $ApiUrl) { $ApiUrl = Read-Host 'AvtoPult HTTPS API URL ending in /api/v1/' }
    if (-not $OneCBaseUrl) { $OneCBaseUrl = Read-Host '1C publication URL (example: http://127.0.0.1/mkcopy)' }
    $cloud = [Uri]$ApiUrl
    $base = [Uri]$OneCBaseUrl
    if (-not $cloud.IsAbsoluteUri -or $cloud.Scheme -ne 'https' -or -not $cloud.AbsolutePath.EndsWith('/api/v1/')) {
        throw 'Use an absolute HTTPS API URL ending in /api/v1/.'
    }
    if (-not $base.IsAbsoluteUri -or $base.Scheme -notin @('http', 'https') -or $base.UserInfo -or $base.Query -or $base.Fragment) {
        throw 'Use a 1C HTTP(S) publication URL without credentials, query or fragment.'
    }
    if ($base.Scheme -eq 'http' -and -not $AllowLocalHttp) {
        throw 'HTTP needs explicit -AllowLocalHttp on a trusted local/VPN network.'
    }
    if (-not $ReadUser) { $ReadUser = Read-Host '1C read-only username (non-empty password required)' }
    if (-not $WriteUser) { $WriteUser = Read-Host '1C writer username (non-empty password required)' }
    $publication = $OneCBaseUrl.TrimEnd('/')
    & (Join-Path $root 'configure-environment.ps1') -ApiUrl $ApiUrl `
        -OneCWriteUrl "$publication/hs/avtopult/v1/" -OneCUsername $WriteUser `
        -OneCODataUrl "$publication/odata/standard.odata/" -OneCODataUsername $ReadUser `
        -AllowLocalHttp:$AllowLocalHttp
} else {
    Write-Host 'Resuming with the existing protected configuration. No new enrollment code is consumed.'
}

$previous = $env:AVTOPULT_AGENT_CONFIG_FILE
try {
    $env:AVTOPULT_AGENT_CONFIG_FILE = $configFile
    $settings = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($settings.ONE_C_ALLOW_WRITES -ne '0') {
        throw 'Initial setup requires ONE_C_ALLOW_WRITES=0. Existing configuration was preserved.'
    }
    $settings = $null
    $output = & $NodeExe (Join-Path $root 'agent.mjs') --diagnose
    $diagnosticExit = $LASTEXITCODE
    $report = $output | ConvertFrom-Json
    $report.checks | Select-Object name, status, detail | Format-Table -AutoSize
    if ($diagnosticExit -ne 0 -or -not $report.ok) {
        throw 'Pre-install diagnostics failed. Service NOT installed; config preserved. Fix the reported endpoint (1C 404 needs extension/publication), then rerun setup.'
    }
} finally {
    $env:AVTOPULT_AGENT_CONFIG_FILE = $previous
}
& (Join-Path $root 'install-service.ps1') -NodeExe $NodeExe -AgentDirectory $agentDirectory
& (Join-Path $root 'diagnose-agent.ps1') -NodeExe $NodeExe -AgentDirectory $agentDirectory
Write-Host 'Service installed and diagnostics passed. Writes remain disabled. Native 1C business scenarios are NOT yet accepted.'
