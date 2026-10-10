Set-StrictMode -Version Latest

function Assert-AgentAdministrator {
    $principal = New-Object Security.Principal.WindowsPrincipal(
        [Security.Principal.WindowsIdentity]::GetCurrent()
    )
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this command from an elevated PowerShell session.'
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

function Invoke-AgentDirectorySwap {
    param(
        [Parameter(Mandatory = $true)][string]$CurrentDirectory,
        [Parameter(Mandatory = $true)][string]$PreparedDirectory,
        [Parameter(Mandatory = $true)][scriptblock]$StopAction,
        [Parameter(Mandatory = $true)][scriptblock]$StartAction,
        [Parameter(Mandatory = $true)][scriptblock]$HealthAction
    )
    $backup = "$CurrentDirectory.previous.$([DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff'))"
    & $StopAction
    try {
        Move-Item -LiteralPath $CurrentDirectory -Destination $backup
        Move-Item -LiteralPath $PreparedDirectory -Destination $CurrentDirectory
        & $StartAction
        & $HealthAction
        return $backup
    }
    catch {
        $failure = $_
        try { & $StopAction } catch { Write-Warning 'Failed to stop the rejected agent release.' }
        if (Test-Path -LiteralPath $CurrentDirectory) {
            Move-Item -LiteralPath $CurrentDirectory -Destination "$CurrentDirectory.failed.$([Guid]::NewGuid().ToString('N'))"
        }
        if (Test-Path -LiteralPath $backup) {
            Move-Item -LiteralPath $backup -Destination $CurrentDirectory
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
