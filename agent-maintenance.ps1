Set-StrictMode -Version Latest

function Assert-AgentAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this command from an elevated PowerShell session.'
    }
}

function Read-AgentPlainSecret([string]$Prompt, [int]$Minimum) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($value.Length -lt $Minimum) { throw "$Prompt is too short." }
        return $value
    }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Request-AgentEnrollmentCredential([string]$ApiUrl) {
    if (-not $ApiUrl.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'ApiUrl must use HTTPS.'
    }
    $enrollmentCode = Read-AgentPlainSecret 'One-time AvtoPult enrollment code' 16
    $body = $null
    $response = $null
    try {
        $base = [Uri]::new($ApiUrl.TrimEnd('/') + '/')
        $uri = [Uri]::new($base, 'integrations/one-c/agent/v1/enroll')
        $body = @{
            enrollmentCode = $enrollmentCode
            agentName = [Environment]::MachineName
        } | ConvertTo-Json -Compress
        $response = Invoke-WebRequest -UseBasicParsing -Method Post -Uri $uri -ContentType 'application/json; charset=utf-8' -Headers @{ Accept = 'application/json' } -Body $body
        if ($response.Headers['Cache-Control'] -notmatch '(^|,)\s*no-store\s*(,|$)') {
            throw 'Enrollment response is missing Cache-Control: no-store.'
        }
        $credential = $response.Content | ConvertFrom-Json
        if ([string]::IsNullOrWhiteSpace($credential.agentId) -or [string]::IsNullOrWhiteSpace($credential.agentSecret)) {
            throw 'Enrollment response does not contain an agent credential.'
        }
        if ($credential.agentSecret.Length -lt 32) { throw 'Enrolled agent secret is too short.' }
        return $credential
    }
    finally {
        $enrollmentCode = $null
        $body = $null
        $response = $null
    }
}

function Test-AgentReleaseChecksums([string]$ReleaseDirectory) {
    $root = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
    $checksumPath = Join-Path $root 'SHA256SUMS'
    if (-not (Test-Path -LiteralPath $checksumPath -PathType Leaf)) {
        throw 'Release SHA256SUMS was not found.'
    }
    foreach ($line in Get-Content -LiteralPath $checksumPath) {
        if ($line -notmatch '^(?<hash>[a-f0-9]{64})  (?<name>[^\\].+)$') {
            throw 'Release checksum manifest is malformed.'
        }
        $relative = $Matches.name.Replace('/', [IO.Path]::DirectorySeparatorChar)
        if ([IO.Path]::IsPathRooted($relative) -or $relative.Split([IO.Path]::DirectorySeparatorChar) -contains '..') {
            throw 'Release checksum path is unsafe.'
        }
        $path = Join-Path $root $relative
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Release file is missing: $relative"
        }
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Matches.hash) {
            throw "Release checksum mismatch: $relative"
        }
    }
}

function Invoke-AgentPayloadSwap {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentDirectory,
        [Parameter(Mandatory = $true)][string]$PreparedDirectory,
        [Parameter(Mandatory = $true)][string[]]$ProtectedNames,
        [Parameter(Mandatory = $true)][scriptblock]$StopAction,
        [Parameter(Mandatory = $true)][scriptblock]$StartAction,
        [Parameter(Mandatory = $true)][scriptblock]$HealthAction
    )
    $backup = "$CurrentDirectory.previous.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
    $failed = "$CurrentDirectory.failed.$([Guid]::NewGuid().ToString('N'))"
    New-Item -ItemType Directory -Path $backup | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $PreparedDirectory -Force) {
        if ($ProtectedNames -contains $entry.Name) { throw "Release contains protected service file: $($entry.Name)" }
    }
    & $StopAction
    try {
        foreach ($entry in Get-ChildItem -LiteralPath $CurrentDirectory -Force) {
            if ($ProtectedNames -notcontains $entry.Name) { Move-Item -LiteralPath $entry.FullName -Destination $backup }
        }
        foreach ($entry in Get-ChildItem -LiteralPath $PreparedDirectory -Force) {
            Move-Item -LiteralPath $entry.FullName -Destination $CurrentDirectory
        }
        & $StartAction
        & $HealthAction
        return $backup
    }
    catch {
        $failure = $_
        try { & $StopAction } catch { Write-Warning 'Failed to stop the rejected agent release.' }
        New-Item -ItemType Directory -Path $failed | Out-Null
        foreach ($entry in Get-ChildItem -LiteralPath $CurrentDirectory -Force) {
            if ($ProtectedNames -notcontains $entry.Name) { Move-Item -LiteralPath $entry.FullName -Destination $failed }
        }
        if (Test-Path -LiteralPath $backup) {
            foreach ($entry in Get-ChildItem -LiteralPath $backup -Force) {
                Move-Item -LiteralPath $entry.FullName -Destination $CurrentDirectory
            }
            & $StartAction
            & $HealthAction
        }
        throw $failure
    }
}

function Invoke-AgentConfigSwap {
    param(
        [Parameter(Mandatory = $true)][string]$ConfigFile,
        [Parameter(Mandatory = $true)][string]$PreparedFile,
        [Parameter(Mandatory = $true)][scriptblock]$RestartAction,
        [Parameter(Mandatory = $true)][scriptblock]$HealthAction
    )
    $backup = "$ConfigFile.previous"
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    Move-Item -LiteralPath $ConfigFile -Destination $backup
    try {
        Move-Item -LiteralPath $PreparedFile -Destination $ConfigFile
        & $RestartAction
        & $HealthAction
        Remove-Item -LiteralPath $backup -Force
    }
    catch {
        $failure = $_
        if (Test-Path -LiteralPath $ConfigFile) { Remove-Item -LiteralPath $ConfigFile -Force }
        Move-Item -LiteralPath $backup -Destination $ConfigFile
        & $RestartAction
        & $HealthAction
        throw $failure
    }
}
