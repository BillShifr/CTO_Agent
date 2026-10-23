Set-StrictMode -Version Latest

function Assert-ProductionAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this command from an elevated PowerShell session.'
    }
}

function Set-ProductionDirectoryAcl([string]$Path) {
    $directory = New-Item -ItemType Directory -Path $Path -Force
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Protected directory must not be a reparse point: $Path"
    }
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            'FullControl',
            'ContainerInherit,ObjectInherit',
            'None',
            'Allow'
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $directory.FullName -AclObject $acl
    foreach ($entry in Get-ChildItem -LiteralPath $directory.FullName -Force -Recurse) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            throw "Protected tree must not contain a reparse point: $($entry.FullName)"
        }
        if ($entry.PSIsContainer) {
            $entryAcl = New-Object Security.AccessControl.DirectorySecurity
            $entryAcl.SetAccessRuleProtection($true, $false)
            $inheritance = 'ContainerInherit,ObjectInherit'
        }
        else {
            $entryAcl = New-Object Security.AccessControl.FileSecurity
            $entryAcl.SetAccessRuleProtection($true, $false)
            $inheritance = 'None'
        }
        foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
            $identity = New-Object Security.Principal.SecurityIdentifier($sid)
            $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                $identity,
                'FullControl',
                $inheritance,
                'None',
                'Allow'
            )
            $entryAcl.AddAccessRule($rule)
        }
        Set-Acl -LiteralPath $entry.FullName -AclObject $entryAcl
    }
    return $directory.FullName
}

function Test-ProductionDirectoryAcl([string]$Path) {
    $acl = Get-Acl -LiteralPath $Path
    if (-not $acl.AreAccessRulesProtected) { return $false }
    $allowed = @('S-1-5-18', 'S-1-5-32-544')
    foreach ($rule in $acl.Access) {
        $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -eq 'Allow' -and $sid -notin $allowed) { return $false }
    }
    return $true
}

function Read-ProductionSecret([string]$Prompt, [int]$MinimumLength = 1) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($value.Length -lt $MinimumLength) { throw "$Prompt is too short." }
        return $value
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

function Test-ProductionHttpsEndpoint([string]$Uri, [string]$Name) {
    $target = [Uri]$Uri
    if (-not $target.IsAbsoluteUri -or $target.Scheme -ne 'https') {
        throw "$Name must use an absolute HTTPS URL."
    }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Method Head -Uri $target -TimeoutSec 20
        return [pscustomobject]@{ name = $Name; status = 'ok'; detail = "HTTP $($response.StatusCode)" }
    }
    catch {
        $response = $_.Exception.Response
        if ($null -ne $response -and $null -ne $response.StatusCode) {
            $statusCode = [int]$response.StatusCode
            if ($statusCode -ge 200 -and $statusCode -lt 500) {
                return [pscustomobject]@{ name = $Name; status = 'ok'; detail = "HTTP $statusCode" }
            }
        }
        throw "$Name is unavailable: $($_.Exception.Message)"
    }
}

function Expand-VerifiedAgentArchive {
    param(
        [Parameter(Mandatory = $true)][string]$Archive,
        [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
        [Parameter(Mandatory = $true)][string]$Destination
    )
    $archivePath = (Resolve-Path -LiteralPath $Archive).Path
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        throw 'Agent release archive checksum mismatch.'
    }
    if (Test-Path -LiteralPath $Destination) {
        throw 'Release extraction destination already exists.'
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
                throw 'Agent release contains an unsafe archive path.'
            }
            if ($names.ContainsKey($name)) { throw 'Agent release contains a duplicate archive path.' }
            $names[$name] = $true
            $total += $entry.Length
            if ($total -gt 1GB -or $names.Count -gt 10000) {
                throw 'Agent release exceeds extraction limits.'
            }
        }
        foreach ($required in @('agent.mjs', 'agent-maintenance.ps1', 'update-service.ps1', 'SHA256SUMS', 'RELEASE.json', 'runtime\node.exe')) {
            if (-not $names.ContainsKey($required)) { throw "Agent release is missing $required." }
        }
        [IO.Compression.ZipFile]::ExtractToDirectory($archivePath, $Destination)
    }
    finally {
        $zip.Dispose()
    }
    . (Join-Path $Destination 'agent-maintenance.ps1')
    Test-AgentReleaseChecksums $Destination
    $release = Get-Content -LiteralPath (Join-Path $Destination 'RELEASE.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($release.platform -ne 'windows-x64' -or $release.sourceRevision -notmatch '^[a-f0-9]{40}$') {
        throw 'Agent RELEASE.json has an unsupported platform or source revision.'
    }
    return [pscustomobject]@{
        archiveSha256 = $actual
        sourceRevision = $release.sourceRevision
        version = $release.version
    }
}

function Get-ProductionRunnerServiceName([string]$RunnerDirectory) {
    $serviceFile = Join-Path $RunnerDirectory '.service'
    if (-not (Test-Path -LiteralPath $serviceFile -PathType Leaf)) {
        throw 'GitHub runner service marker was not found.'
    }
    $serviceName = (Get-Content -LiteralPath $serviceFile -Raw -Encoding UTF8).Trim()
    if ($serviceName -notmatch '^actions\.runner\.') { throw 'GitHub runner service marker is invalid.' }
    return $serviceName
}

function Get-ProductionSettings([string]$DeploymentDirectory) {
    $settingsPath = Join-Path $DeploymentDirectory 'production-settings.json'
    if (-not (Test-Path -LiteralPath $settingsPath -PathType Leaf)) {
        throw 'Production deployment settings were not found. Run setup-production-runner.ps1.'
    }
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('agentDirectory', 'configFile', 'runnerDirectory')) {
        if ([string]::IsNullOrWhiteSpace($settings.$name) -or -not [IO.Path]::IsPathRooted($settings.$name)) {
            throw "Production deployment setting is invalid: $name"
        }
    }
    return $settings
}

function Write-ProductionReport([string]$Path, [hashtable]$Values) {
    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
    }
    $payload = [ordered]@{}
    foreach ($key in $Values.Keys) { $payload[$key] = $Values[$key] }
    [IO.File]::WriteAllText(
        $Path,
        ($payload | ConvertTo-Json -Depth 8),
        [Text.UTF8Encoding]::new($false)
    )
}
