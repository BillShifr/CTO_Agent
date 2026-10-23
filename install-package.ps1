[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [string]$Destination = 'C:\one-c-agent',
    [string]$ApiUrl = 'https://cto24.kz/api/v1/',
    [string]$OneCBaseUrl,
    [switch]$AllowLocalHttp,
    [switch]$InstallProductionRunner,
    [string]$RepositoryUrl = 'https://github.com/BillShifr/CTO_Agent',
    [string]$RunnerGroup,
    [switch]$PreflightOnly
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run PowerShell as Administrator.'
}
if (Get-Service AvtoPultOneCAgent -ErrorAction SilentlyContinue) {
    throw 'Service already exists. Use update-service.ps1; nothing was changed.'
}
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $ExpectedSha256) {
    throw 'Archive checksum mismatch. Nothing was installed.'
}
$target = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
if (Test-Path -LiteralPath $target) {
    throw 'Destination already exists. Resume its setup-agent.ps1 or choose a new directory; nothing was overwritten.'
}
$parent = Split-Path -Parent $target
if (-not $parent -or -not (Test-Path -LiteralPath $parent -PathType Container)) {
    throw 'Destination parent must exist.'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $names = @{}
    $total = [long]0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('/', '\')
        if (-not $name -or $name.StartsWith('\') -or $name.Contains(':') -or
            ($name.Split('\') -contains '..') -or ($name.Split('\') -contains '.')) {
            throw 'Unsafe archive path.'
        }
        if ($names.ContainsKey($name)) { throw 'Duplicate archive path.' }
        $names[$name] = $true
        $total += $entry.Length
        if ($total -gt 1GB -or $names.Count -gt 10000) { throw 'Archive exceeds installation limits.' }
    }
    foreach ($required in @('setup-agent.ps1', 'SHA256SUMS', 'RELEASE.json', 'runtime\node.exe')) {
        if (-not $names.ContainsKey($required)) { throw "Missing $required. Use the inner Windows release ZIP, not the GitHub artifact wrapper." }
    }
} finally { $zip.Dispose() }

# A unique sibling directory prevents extraction from overwriting an existing installation.
$staging = Join-Path $parent ('avtopult-install-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $staging | Out-Null
try {
    [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $staging)
    & (Join-Path $staging 'setup-agent.ps1') -PreflightOnly
    if (-not $?) { throw 'Package preflight failed.' }
    if ($PreflightOnly) {
        Write-Host 'Package validated. No configuration or service was created.'
        return
    }
    # Directory.Move fails if another installation created the target while preflight ran.
    [IO.Directory]::Move($staging, $target)
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
try {
    & (Join-Path $target 'setup-agent.ps1') -ApiUrl $ApiUrl -OneCBaseUrl $OneCBaseUrl -AllowLocalHttp:$AllowLocalHttp
    if (-not $?) { throw 'Setup failed.' }
    if ($InstallProductionRunner) {
        & (Join-Path $target 'setup-production-runner.ps1') -RepositoryUrl $RepositoryUrl `
            -RunnerGroup $RunnerGroup -AgentDirectory $target
        if (-not $?) { throw 'Production runner setup failed.' }
    }
} catch {
    Write-Warning "Installation files and protected configuration were preserved. Resume agent setup with $target\setup-agent.ps1; if the agent service is already running, resume runner setup with $target\setup-production-runner.ps1."
    throw
}
