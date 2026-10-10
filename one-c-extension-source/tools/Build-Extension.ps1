[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$PlatformExe,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$InfoBase,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Container })]
    [string]$ExportedProject,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputCfe,

    [string]$UserName = $env:AVTOPULT_1C_USER,
    [string]$Password = $env:AVTOPULT_1C_PASSWORD,
    [string]$ExtensionName = 'AvtoPult',

    [Parameter(Mandatory = $true)]
    [ValidateSet('I-CONFIRM-NON-PRODUCTION-BUILD-INFOBASE')]
    [string]$EnvironmentAcknowledgement
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'extension-project-manifest.json'
$validatorPath = Join-Path $root 'extension-project-contract.mjs'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$platformVersion = (Get-Item $PlatformExe).VersionInfo.ProductVersion
if (-not $platformVersion.StartsWith($manifest.platformVersion)) {
    throw "Expected 1C platform $($manifest.platformVersion), got $platformVersion"
}

if ($manifest.extensionName -ne $ExtensionName) {
    throw "Extension name must be '$($manifest.extensionName)'"
}

& node $validatorPath $ExportedProject
if ($LASTEXITCODE -ne 0) { throw 'Exported extension project validation failed' }

foreach ($module in $manifest.commonModules) {
    $source = Join-Path $root "src/CommonModules/$($module.sourceDirectory)/Module.bsl"
    $target = Join-Path $ExportedProject "CommonModules/$($module.name)/Ext/Module.bsl"
    if (-not (Test-Path $source -PathType Leaf)) { throw "Missing source module: $source" }
    Copy-Item $source $target -Force
}

foreach ($service in $manifest.httpServices) {
    $source = Join-Path $root "src/HTTPServices/$service/Module.bsl"
    $target = Join-Path $ExportedProject "HTTPServices/$service/Ext/Module.bsl"
    if (-not (Test-Path $source -PathType Leaf)) { throw "Missing HTTP service source: $source" }
    Copy-Item $source $target -Force
}

$output = [IO.Path]::GetFullPath($OutputCfe)
$outputDirectory = Split-Path -Parent $output
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
$logs = Join-Path $outputDirectory 'logs'
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

Invoke-Designer '01-load' @('/LoadConfigFromFiles', $ExportedProject, '-Extension', $ExtensionName)
Invoke-Designer '02-check-modules' @('/CheckModules', '-Server', '-ExternalConnectionServer', '-ExtendedModulesCheck', '-Extension', $ExtensionName)
Invoke-Designer '03-check-config' @('/CheckConfig', '-ConfigLogIntegrity', '-IncorrectReferences', '-Server', '-ExternalConnectionServer', '-HandlersExistence', '-ExtendedModulesCheck', '-Extension', $ExtensionName)
Invoke-Designer '04-check-applicability' @('/CheckCanApplyConfigurationExtensions', '-Extension', $ExtensionName)
Invoke-Designer '05-dump-cfe' @('/DumpCfg', $output, '-Extension', $ExtensionName)

if (-not (Test-Path $output -PathType Leaf) -or (Get-Item $output).Length -eq 0) {
    throw "Designer did not create a non-empty CFE: $output"
}

$hash = (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -Path "$output.sha256" -Value "$hash  $([IO.Path]::GetFileName($output))" -Encoding ascii
Write-Host "Built $output"
Write-Host "SHA-256: $hash"
