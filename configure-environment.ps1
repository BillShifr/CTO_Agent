param(
    [Parameter(Mandatory = $true)][string]$AgentId,
    [Parameter(Mandatory = $true)][string]$ApiUrl,
    [Parameter(Mandatory = $true)][string]$OneCWriteUrl,
    [Parameter(Mandatory = $true)][string]$OneCUsername,
    [Parameter(Mandatory = $true)][string]$OneCODataUrl,
    [Parameter(Mandatory = $true)][string]$OneCODataUsername,
    [string]$KaspiSmartPosUrl,
    [string]$KaspiSmartPosName,
    [string]$StateDirectory = 'C:\ProgramData\AvtoPult\OneCAgent',
    [switch]$AllowLocalHttp,
    [switch]$AllowWrites
)

$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this configurator from an elevated PowerShell session.'
}
if (-not $ApiUrl.StartsWith('https://', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'ApiUrl must use HTTPS.'
}
if (-not $OneCWriteUrl.EndsWith('/hs/avtopult/v1/')) {
    throw 'OneCWriteUrl must end with /hs/avtopult/v1/.'
}
if (-not $OneCODataUrl.EndsWith('/odata/standard.odata/')) {
    throw 'OneCODataUrl must end with /odata/standard.odata/.'
}
if ($KaspiSmartPosUrl) {
    if ([string]::IsNullOrWhiteSpace($KaspiSmartPosName)) {
        throw 'KaspiSmartPosName is required with KaspiSmartPosUrl.'
    }
    $smartPosUri = [Uri]$KaspiSmartPosUrl
    if ($smartPosUri.Scheme -ne 'https' -or $smartPosUri.Port -ne 8080) {
        throw 'KaspiSmartPosUrl must use local HTTPS on port 8080.'
    }
    if (-not $smartPosUri.DnsSafeHost.EndsWith('.kaspipos.kz', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'KaspiSmartPosUrl must use a local DNS name covered by the trusted *.kaspipos.kz certificate.'
    }
}
if (
    (-not $AllowLocalHttp) -and
    ($OneCWriteUrl.StartsWith('http://') -or $OneCODataUrl.StartsWith('http://'))
) {
    throw 'Use AllowLocalHttp explicitly for a trusted loopback/LAN endpoint.'
}

function Read-Secret([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

$agentSecret = Read-Secret 'AvtoPult agent secret (minimum 32 characters)'
$writePassword = Read-Secret '1C write password'
$odataPassword = Read-Secret '1C OData read password'
$kaspiToken = if ($KaspiSmartPosUrl) { Read-Secret 'Kaspi Smart POS API token' } else { $null }
$kaspiRefreshToken = if ($KaspiSmartPosUrl) { Read-Secret 'Kaspi Smart POS refresh token' } else { $null }
$kaspiCallbackSecret = if ($KaspiSmartPosUrl) { Read-Secret 'Kaspi callback secret' } else { $null }
if ($agentSecret.Length -lt 32) { throw 'Agent secret must contain at least 32 characters.' }
if ($writePassword.Length -eq 0 -or $odataPassword.Length -eq 0) {
    throw '1C passwords cannot be empty.'
}
if ($KaspiSmartPosUrl -and $kaspiToken.Length -lt 16) {
    throw 'Kaspi Smart POS token must contain at least 16 characters.'
}
if ($KaspiSmartPosUrl -and $kaspiRefreshToken.Length -lt 16) {
    throw 'Kaspi Smart POS refresh token must contain at least 16 characters.'
}
if ($KaspiSmartPosUrl -and $kaspiCallbackSecret.Length -lt 16) {
    throw 'Kaspi callback secret must contain at least 16 characters.'
}

$values = @{
    AVTOPULT_AGENT_ID = $AgentId
    AVTOPULT_API_URL = $ApiUrl
    AVTOPULT_AGENT_SECRET = $agentSecret
    ONE_C_WRITE_URL = $OneCWriteUrl
    ONE_C_USERNAME = $OneCUsername
    ONE_C_PASSWORD = $writePassword
    ONE_C_ODATA_URL = $OneCODataUrl
    ONE_C_ODATA_USERNAME = $OneCODataUsername
    ONE_C_ODATA_PASSWORD = $odataPassword
    ONE_C_ALLOW_HTTP = $(if ($AllowLocalHttp) { '1' } else { '0' })
    ONE_C_ALLOW_WRITES = $(if ($AllowWrites) { '1' } else { '0' })
    AVTOPULT_AGENT_STATE_DIR = $StateDirectory
}
if ($KaspiSmartPosUrl) {
    $values.KASPI_SMART_POS_URL = $KaspiSmartPosUrl
    $values.KASPI_SMART_POS_NAME = $KaspiSmartPosName
    $values.KASPI_SMART_POS_TOKEN = $kaspiToken
    $values.KASPI_SMART_POS_REFRESH_TOKEN = $kaspiRefreshToken
    $values.KASPI_CALLBACK_SECRET = $kaspiCallbackSecret
}
if (-not [IO.Path]::IsPathRooted($StateDirectory) -or (Split-Path $StateDirectory -Leaf) -ne 'OneCAgent') {
    throw 'StateDirectory must be a dedicated absolute directory named OneCAgent.'
}
$directory = New-Item -ItemType Directory -Path $StateDirectory -Force
if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'The agent state directory must not be a reparse point.'
}
# Replace the ACL instead of merely removing inherited permissions: explicit old grants matter too.
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $StateDirectory -AclObject $acl
$configPath = Join-Path $StateDirectory 'agent-config.json'
if (Test-Path -LiteralPath $configPath) {
    throw 'Configuration already exists. Back it up and remove it explicitly before rotating credentials.'
}
[IO.File]::WriteAllText($configPath, ($values | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
# Migrate away from globally readable machine environment. Rotate any previously exposed secrets.
foreach ($name in @('AVTOPULT_AGENT_SECRET', 'ONE_C_PASSWORD', 'ONE_C_ODATA_PASSWORD', 'KASPI_SMART_POS_TOKEN', 'KASPI_SMART_POS_REFRESH_TOKEN', 'KASPI_CALLBACK_SECRET')) {
    [Environment]::SetEnvironmentVariable($name, $null, 'Machine')
}
$values.Clear()
$agentSecret = $null
$writePassword = $null
$odataPassword = $null
$kaspiToken = $null
$kaspiRefreshToken = $null
$kaspiCallbackSecret = $null
Write-Host 'Agent configuration saved with access restricted to SYSTEM and Administrators. Rotate previously configured machine-environment secrets.' -ForegroundColor Green
