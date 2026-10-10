[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$PlatformExe,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$BaseConfigurationCf,

    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Container })]
    [string]$ExportedProject,

    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $root 'extension-project-manifest.json'
$validatorPath = Join-Path $root 'extension-project-contract.mjs'
$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$baseConfiguration = [IO.Path]::GetFullPath($BaseConfigurationCf)
if ([IO.Path]::GetExtension($baseConfiguration) -ne '.cf') {
    throw 'Base configuration must be a .cf file'
}
& node $validatorPath $ExportedProject
if ($LASTEXITCODE -ne 0) { throw 'Exported extension project validation failed' }
$platformVersion = (Get-Item $PlatformExe).VersionInfo.ProductVersion
if (-not $platformVersion.StartsWith($manifest.platformVersion)) {
    throw "Expected 1C platform $($manifest.platformVersion), got $platformVersion"
}

$output = [IO.Path]::GetFullPath($OutputDirectory)
$package = Join-Path $output 'AvtoPult-extension-package'
$archive = Join-Path $output 'AvtoPult-extension-package.zip'
$workspace = Join-Path ([IO.Path]::GetTempPath()) "avtopult-extension-$([guid]::NewGuid().ToString('N'))"
$fileInfoBase = Join-Path $workspace 'build-infobase'
$workingProject = Join-Path $workspace 'extension-project'
$stagingPackage = Join-Path $workspace 'package'
$bootstrapLogs = Join-Path $stagingPackage 'logs/bootstrap'

function Invoke-Platform([string]$Name, [string[]]$Arguments) {
    $log = Join-Path $bootstrapLogs "$Name.log"
    & $PlatformExe @Arguments '/Out' $log '-NoTruncate'
    if ($LASTEXITCODE -ne 0) {
        throw "1C platform step '$Name' failed with exit code $LASTEXITCODE. Log: $log"
    }
}

try {
    if (Test-Path $package) { Remove-Item $package -Recurse -Force }
    if (Test-Path $archive) { Remove-Item $archive -Force }
    if (Test-Path "$archive.sha256") { Remove-Item "$archive.sha256" -Force }
    New-Item -ItemType Directory -Path $workspace -Force | Out-Null
    New-Item -ItemType Directory -Path $bootstrapLogs -Force | Out-Null
    Copy-Item $ExportedProject $workingProject -Recurse

    Invoke-Platform '01-create-build-infobase' @(
        'CREATEINFOBASE',
        "File=`"$fileInfoBase`";",
        '/DisableStartupDialogs',
        '/AddInList', 'false'
    )
    Invoke-Platform '02-load-base-configuration' @(
        'DESIGNER', '/F', $fileInfoBase, '/DisableStartupDialogs',
        '/LoadCfg', $baseConfiguration
    )
    Invoke-Platform '03-update-build-infobase' @(
        'DESIGNER', '/F', $fileInfoBase, '/DisableStartupDialogs', '/UpdateDBCfg'
    )

    $cfeDirectory = Join-Path $stagingPackage 'cfe'
    & (Join-Path $PSScriptRoot 'Build-Extension.ps1') `
        -PlatformExe $PlatformExe `
        -FileInfoBase $fileInfoBase `
        -ExportedProject $workingProject `
        -OutputCfe (Join-Path $cfeDirectory 'AvtoPult.cfe') `
        -UserName '' `
        -Password '' `
        -EnvironmentAcknowledgement I-CONFIRM-NON-PRODUCTION-BUILD-INFOBASE

    $source = Join-Path $stagingPackage 'source'
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    Copy-Item (Join-Path $root 'src') (Join-Path $source 'src') -Recurse
    Copy-Item $workingProject (Join-Path $source 'exported-project') -Recurse
    foreach ($name in @(
        'ADAPTER-CONTRACT.md',
        'BASE-METADATA-VERIFICATION.md',
        'BUILD-AND-INSTALL.md',
        'INVOICE-METADATA.md',
        'ORDER-METADATA.md',
        'OUTBOX-ORDERING.md',
        'PAYMENT-METADATA.md',
        'README.md',
        'REVERSE-METADATA.md',
        'extension-project-contract.mjs',
        'extension-project-manifest.json'
    )) {
        Copy-Item (Join-Path $root $name) (Join-Path $source $name)
    }
    $tools = Join-Path $source 'tools'
    New-Item -ItemType Directory -Path $tools -Force | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'Build-Extension.ps1') $tools
    Copy-Item (Join-Path $PSScriptRoot 'Build-Offline-Package.ps1') $tools

    $cfe = Join-Path $cfeDirectory 'AvtoPult.cfe'
    $metadata = [ordered]@{
        extensionName = $manifest.extensionName
        targetConfiguration = 'Комплексная автоматизация для Казахстана 2.4.5.21'
        platformVersion = $manifest.platformVersion
        builtAtUtc = [DateTime]::UtcNow.ToString('o')
        cfeSha256 = (Get-FileHash $cfe -Algorithm SHA256).Hash.ToLowerInvariant()
        baseConfigurationSha256 = (Get-FileHash $baseConfiguration -Algorithm SHA256).Hash.ToLowerInvariant()
        installationIncluded = $false
        buildDatabase = 'disposable-file-infobase'
    }
    $metadata | ConvertTo-Json | Set-Content (Join-Path $stagingPackage 'PACKAGE.json') -Encoding UTF8

    $checksums = Get-ChildItem $stagingPackage -Recurse -File |
        Where-Object { $_.Name -ne 'SHA256SUMS' } |
        Sort-Object FullName |
        ForEach-Object {
            $relative = [IO.Path]::GetRelativePath($stagingPackage, $_.FullName).Replace('\', '/')
            "$((Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $relative"
        }
    [IO.File]::WriteAllText(
        (Join-Path $stagingPackage 'SHA256SUMS'),
        "$($checksums -join "`n")`n",
        [Text.UTF8Encoding]::new($false)
    )

    New-Item -ItemType Directory -Path $output -Force | Out-Null
    Copy-Item $stagingPackage $package -Recurse
    Compress-Archive -Path "$stagingPackage/*" -DestinationPath $archive -CompressionLevel Optimal
    $archiveHash = (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText(
        "$archive.sha256",
        "$archiveHash  $([IO.Path]::GetFileName($archive))`n",
        [Text.UTF8Encoding]::new($false)
    )
    Write-Host "Built offline extension package: $archive"
    Write-Host "SHA-256: $archiveHash"
} finally {
    if (Test-Path $workspace) { Remove-Item $workspace -Recurse -Force }
}
