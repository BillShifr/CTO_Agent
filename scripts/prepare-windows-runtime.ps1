param([Parameter(Mandatory = $true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$version = '22.20.0'
$expected = 'bb819d6eb8f5bfda294bbc83a7e4ec6539da67c4233d54b0d655b9248b15e29d'
if (Test-Path -LiteralPath $Destination) { throw 'Runtime destination already exists.' }
$temporary = Join-Path $env:TEMP ('avtopult-node-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporary | Out-Null
try {
    $archive = Join-Path $temporary 'node.zip'
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip" -OutFile $archive
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
        throw 'Official Node.js archive checksum mismatch.'
    }
    Expand-Archive -LiteralPath $archive -DestinationPath (Join-Path $temporary 'expanded')
    $source = Join-Path $temporary "expanded/node-v$version-win-x64"
    New-Item -ItemType Directory -Path $Destination | Out-Null
    foreach ($name in @('node.exe', 'LICENSE')) {
        Copy-Item -LiteralPath (Join-Path $source $name) -Destination $Destination
    }
    & (Join-Path $Destination 'node.exe') -e "if(process.version!=='v$version'||process.arch!=='x64')process.exit(1)"
    if ($LASTEXITCODE -ne 0) { throw 'Bundled runtime identity check failed.' }
} finally {
    Remove-Item -LiteralPath $temporary -Recurse -Force
}
