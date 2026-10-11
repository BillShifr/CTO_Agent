$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('avtopult-setup-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    Copy-Item -Path (Join-Path $PSScriptRoot '.artifacts/one-c-agent/*') -Destination $fixture -Recurse
    $setup = Join-Path $fixture 'setup-agent.ps1'
    $node = (Get-Command node.exe).Source
    & $setup -NodeExe $node -PreflightOnly
    if (Get-Service AvtoPultOneCAgent -ErrorAction SilentlyContinue) {
        throw 'Preflight created a service.'
    }
    # Existing source paths include Cyrillic: the real manifest exercises UTF-8 on PS 5.1.
    Add-Content -LiteralPath (Join-Path $fixture 'agent.mjs') -Value '// tampered'
    $rejected = $false
    try { & $setup -NodeExe $node -PreflightOnly }
    catch {
        if ($_.Exception.Message -notlike 'Package checksum mismatch:*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'Tampered package was accepted.' }
    Write-Host 'Guided setup: real release preflight and corruption rejection passed.'
} finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
