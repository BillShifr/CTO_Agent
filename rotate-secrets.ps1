param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$AgentDirectory,
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$ServiceName = 'AvtoPultOneCAgent',
    [switch]$AgentSecret,
    [switch]$OneCWritePassword,
    [switch]$OneCODataPassword,
    [switch]$KaspiSecrets
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-maintenance.ps1')
Assert-AgentAdministrator
if (-not ($AgentSecret -or $OneCWritePassword -or $OneCODataPassword -or $KaspiSecrets)) {
    throw 'Select at least one secret group to rotate.'
}
$NodeExe = (Resolve-Path -LiteralPath $NodeExe).Path
$AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
$config = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json

function Read-PlainSecret([string]$Prompt, [int]$Minimum) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $value = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($value.Length -lt $Minimum) { throw "$Prompt is too short." }
        return $value
    }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

if ($AgentSecret) { $config.AVTOPULT_AGENT_SECRET = Read-PlainSecret 'New AvtoPult agent secret' 32 }
if ($OneCWritePassword) { $config.ONE_C_PASSWORD = Read-PlainSecret 'New 1C write password' 1 }
if ($OneCODataPassword) { $config.ONE_C_ODATA_PASSWORD = Read-PlainSecret 'New 1C OData password' 1 }
if ($KaspiSecrets) {
    if (-not $config.KASPI_SMART_POS_URL) { throw 'Kaspi Smart POS is not configured.' }
    $config.KASPI_SMART_POS_TOKEN = Read-PlainSecret 'New Kaspi access token' 16
    $config.KASPI_SMART_POS_REFRESH_TOKEN = Read-PlainSecret 'New Kaspi refresh token' 16
    $config.KASPI_CALLBACK_SECRET = Read-PlainSecret 'New Kaspi callback secret' 16
}

$prepared = "$ConfigFile.next.$([Guid]::NewGuid().ToString('N'))"
[IO.File]::WriteAllText($prepared, ($config | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
$acl = Get-Acl -LiteralPath $ConfigFile
Set-Acl -LiteralPath $prepared -AclObject $acl
$previous = $env:AVTOPULT_AGENT_CONFIG_FILE
$env:AVTOPULT_AGENT_CONFIG_FILE = $prepared
try {
    & $NodeExe (Join-Path $AgentDirectory 'agent.mjs') --diagnose
    if ($LASTEXITCODE -ne 0) { throw 'New credentials failed diagnostics; configuration was not changed.' }
}
catch {
    Remove-Item -LiteralPath $prepared -Force -ErrorAction SilentlyContinue
    $config = $null
    throw
}
finally { $env:AVTOPULT_AGENT_CONFIG_FILE = $previous }

$wrapper = Join-Path $AgentDirectory "$ServiceName.exe"
$restart = { & $wrapper restart; if ($LASTEXITCODE -ne 0) { throw 'Failed to restart agent service.' } }
$health = {
    $service = Get-Service -Name $ServiceName
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $service.Refresh()
    if ($service.Status -ne 'Running') { throw 'Agent service did not recover after secret rotation.' }
}
Invoke-AgentConfigSwap $ConfigFile $prepared $restart $health
$config = $null
Write-Host 'Selected secrets were rotated and the service is running.' -ForegroundColor Green
