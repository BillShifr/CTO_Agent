$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('sto mappings test ' + [Guid]::NewGuid().ToString('N'))
$previousConfig = [Environment]::GetEnvironmentVariable('AVTOPULT_AGENT_CONFIG_FILE', 'Process')
$previousOutput = [Environment]::GetEnvironmentVariable('STO_MAPPING_TEST_OUTPUT', 'Process')
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    $node = (Get-Command node.exe).Source
    $config = Join-Path $fixture 'config.json'
    $output = Join-Path $fixture 'result.json'
    $agent = Join-Path $fixture 'agent.mjs'
    [IO.File]::WriteAllText($config, '{"fixture":true}')
    [IO.File]::WriteAllText($agent, @'
import {writeFileSync} from 'node:fs';
writeFileSync(process.env.STO_MAPPING_TEST_OUTPUT, JSON.stringify({
    args: process.argv.slice(2), config: process.env.AVTOPULT_AGENT_CONFIG_FILE
}));
'@)
    $hash = (Get-FileHash -LiteralPath $config).Hash
    $env:STO_MAPPING_TEST_OUTPUT = $output
    $env:AVTOPULT_AGENT_CONFIG_FILE = 'must-be-restored'
    $wrapper = Join-Path $PSScriptRoot 'configure-mappings.ps1'
    & $wrapper -AgentDirectory $fixture -ConfigFile $config -NodeExe $node
    $result = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
    if ($result.config -ne $config -or $result.args.Count -ne 1 -or $result.args[0] -ne '--configure-mappings') {
        throw 'Wrong configuration or CLI arguments.'
    }
    if ($env:AVTOPULT_AGENT_CONFIG_FILE -ne 'must-be-restored') { throw 'Environment leaked.' }
    if ((Get-FileHash -LiteralPath $config).Hash -ne $hash) { throw 'Config changed.' }

    [IO.File]::WriteAllText($agent, 'process.exit(7);')
    $rejected = $false
    try { & $wrapper -AgentDirectory $fixture -ConfigFile $config -NodeExe $node }
    catch {
        if ($_.Exception.Message -notlike 'Mappings setup failed*7*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'Child failure was ignored.' }
    if ($env:AVTOPULT_AGENT_CONFIG_FILE -ne 'must-be-restored') { throw 'Failure leaked environment.' }

    $rejected = $false
    try { & $wrapper -AgentDirectory $fixture -ConfigFile (Join-Path $fixture 'missing.json') -NodeExe $node }
    catch {
        if ($_.Exception.Message -notlike 'Required file not found:*') { throw }
        $rejected = $true
    }
    if (-not $rejected) { throw 'Missing configuration was accepted.' }
    [Environment]::SetEnvironmentVariable('AVTOPULT_AGENT_CONFIG_FILE', $null, 'Process')
    [IO.File]::WriteAllText($agent, 'process.exit(0);')
    & $wrapper -AgentDirectory $fixture -ConfigFile $config -NodeExe $node
    if (Test-Path Env:AVTOPULT_AGENT_CONFIG_FILE) { throw 'Previously absent variable was retained.' }
    Write-Host 'Mappings wrapper: success, failures, paths with spaces and environment restoration passed.'
} finally {
    [Environment]::SetEnvironmentVariable('AVTOPULT_AGENT_CONFIG_FILE', $previousConfig, 'Process')
    [Environment]::SetEnvironmentVariable('STO_MAPPING_TEST_OUTPUT', $previousOutput, 'Process')
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
