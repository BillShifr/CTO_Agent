$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('avtopult-package-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $archive = Join-Path $PSScriptRoot '.artifacts/AvtoPult-OneCAgent-windows-x64.zip'
    $hash = (Get-FileHash $archive -Algorithm SHA256).Hash
    $target = Join-Path $fixture 'agent'
    $installer = Join-Path $PSScriptRoot 'install-package.ps1'
    & $installer -Archive $archive -ExpectedSha256 $hash -Destination $target -PreflightOnly
    if (Test-Path $target) { throw 'Preflight installed files.' }
    if (@(Get-ChildItem $fixture).Count) { throw 'Staging was not cleaned.' }
    $rejected = $false
    try { & $installer -Archive $archive -ExpectedSha256 ('0' * 64) -Destination $target -PreflightOnly }
    catch { if ($_.Exception.Message -notlike 'Archive checksum mismatch*') { throw }; $rejected = $true }
    if (-not $rejected) { throw 'Bad checksum accepted.' }
    New-Item -ItemType Directory -Path $target | Out-Null
    Set-Content (Join-Path $target 'keep.txt') 'preserve'
    $rejected = $false
    try { & $installer -Archive $archive -ExpectedSha256 $hash -Destination $target -PreflightOnly }
    catch { if ($_.Exception.Message -notlike 'Destination already exists*') { throw }; $rejected = $true }
    if (-not $rejected -or (Get-Content (Join-Path $target 'keep.txt')) -ne 'preserve') { throw 'Existing installation not preserved.' }
    Write-Host 'Package bootstrap preflight, checksum rejection and existing-directory protection passed.'
} finally { Remove-Item -LiteralPath $fixture -Recurse -Force }
