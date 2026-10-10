[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$PlatformExe,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$InfoBase,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$Cfe,

    [string]$UserName = $env:AVTOPULT_1C_USER,
    [string]$Password = $env:AVTOPULT_1C_PASSWORD,
    [string]$ExtensionName = 'AvtoPult',

    [Parameter(Mandatory = $true)]
    [ValidateSet('I-CONFIRM-TEST-INFOBASE')]
    [string]$EnvironmentAcknowledgement
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content (Join-Path $root 'extension-project-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$platformVersion = (Get-Item $PlatformExe).VersionInfo.ProductVersion
if (-not $platformVersion.StartsWith($manifest.platformVersion)) {
    throw "Expected 1C platform $($manifest.platformVersion), got $platformVersion"
}
if ($manifest.extensionName -ne $ExtensionName) {
    throw "Extension name must be '$($manifest.extensionName)'"
}
$artifact = [IO.Path]::GetFullPath($Cfe)
$expectedHashFile = "$artifact.sha256"
if (-not (Test-Path $expectedHashFile -PathType Leaf)) {
    throw "Missing checksum file: $expectedHashFile"
}
$expectedHash = ((Get-Content $expectedHashFile -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
$actualHash = (Get-FileHash $artifact -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $expectedHash) { throw 'CFE checksum mismatch' }

$logs = Join-Path (Split-Path -Parent $artifact) 'install-logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$auth = @()
if (-not [string]::IsNullOrWhiteSpace($UserName)) { $auth += @('/N', $UserName) }
if (-not [string]::IsNullOrWhiteSpace($Password)) { $auth += @('/P', $Password) }
$common = @('DESIGNER', '/S', $InfoBase, '/DisableStartupDialogs') + $auth

function Invoke-Designer([string]$Name, [string[]]$Arguments) {
    $log = Join-Path $logs "$Name.log"
    & $PlatformExe @common @Arguments '/Out' $log '-NoTruncate'
    if ($LASTEXITCODE -ne 0) {
        throw "1C Designer step '$Name' failed with exit code $LASTEXITCODE. Log: $log"
    }
}

Invoke-Designer '01-load-cfe' @('/LoadCfg', $artifact, '-Extension', $ExtensionName, '/UpdateDBCfg')
Invoke-Designer '02-check-applicability' @('/CheckCanApplyConfigurationExtensions', '-Extension', $ExtensionName)
Invoke-Designer '03-check-modules' @('/CheckModules', '-Server', '-ExternalConnectionServer', '-ExtendedModulesCheck', '-Extension', $ExtensionName)
Invoke-Designer '04-check-config' @('/CheckConfig', '-ConfigLogIntegrity', '-IncorrectReferences', '-Server', '-ExternalConnectionServer', '-HandlersExistence', '-ExtendedModulesCheck', '-Extension', $ExtensionName)

Write-Host "Installed and checked $ExtensionName in the explicitly confirmed test infobase"
Write-Host "CFE SHA-256: $actualHash"
