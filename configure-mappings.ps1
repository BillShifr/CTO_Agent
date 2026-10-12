[CmdletBinding()]
param(
    [string]$AgentDirectory = $PSScriptRoot,
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$NodeExe
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($NodeExe)) {
    $NodeExe = Join-Path $AgentDirectory 'runtime\node.exe'
}
$agent = Join-Path $AgentDirectory 'agent.mjs'
foreach ($file in @($NodeExe, $agent, $ConfigFile)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required file not found: $file"
    }
}

# Reuse the protected configuration; do not print, rewrite or rotate credentials.
$previous = [Environment]::GetEnvironmentVariable('AVTOPULT_AGENT_CONFIG_FILE', 'Process')
try {
    $env:AVTOPULT_AGENT_CONFIG_FILE = (Resolve-Path -LiteralPath $ConfigFile).ProviderPath
    & $NodeExe $agent --configure-mappings
    if ($LASTEXITCODE -ne 0) {
        throw "Mappings setup failed (exit code $LASTEXITCODE)."
    }
} finally {
    [Environment]::SetEnvironmentVariable('AVTOPULT_AGENT_CONFIG_FILE', $previous, 'Process')
}
