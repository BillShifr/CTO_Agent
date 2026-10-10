$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'agent-maintenance.ps1')

$script:requestBody = $null
$script:cacheableResponse = $false
$script:enrollmentCodeLength = 32
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    if (-not $AsSecureString) { throw 'Enrollment code must be requested as a SecureString.' }
    return ConvertTo-SecureString ('e' * $script:enrollmentCodeLength) -AsPlainText -Force
}
function global:Invoke-WebRequest {
    param([switch]$UseBasicParsing, $Method, $Uri, $ContentType, $Headers, $Body)
    if ($Method -ne 'Post') { throw 'Enrollment must use POST.' }
    if ($Uri.AbsoluteUri -ne 'https://api.example.kz/api/v1/integrations/one-c/agent/v1/enroll') {
        throw "Unexpected enrollment URI: $Uri"
    }
    $script:requestBody = $Body | ConvertFrom-Json
    return @{
        Headers = $(if ($script:cacheableResponse) { @{} } else { @{ 'Cache-Control' = 'private, no-store' } })
        Content = (@{ agentId = 'issued-agent'; agentSecret = ('s' * 48) } | ConvertTo-Json -Compress)
    }
}

$credential = Request-AgentEnrollmentCredential 'https://api.example.kz/api/v1/'
if ($credential.agentId -ne 'issued-agent' -or $credential.agentSecret -ne ('s' * 48)) {
    throw 'Enrollment credential was parsed incorrectly.'
}
if ($script:requestBody.enrollmentCode -ne ('e' * 32)) { throw 'Enrollment code was not sent.' }
if ([string]::IsNullOrWhiteSpace($script:requestBody.agentName)) { throw 'Agent machine name was not sent.' }

$script:enrollmentCodeLength = 31
$refusedShortCode = $false
try { Request-AgentEnrollmentCredential 'https://api.example.kz/api/v1/' | Out-Null }
catch { $refusedShortCode = $true }
if (-not $refusedShortCode) { throw 'An enrollment code shorter than the server contract was accepted.' }
$script:enrollmentCodeLength = 32

$script:cacheableResponse = $true
$refusedCacheableResponse = $false
try { Request-AgentEnrollmentCredential 'https://api.example.kz/api/v1/' | Out-Null }
catch { $refusedCacheableResponse = $true }
if (-not $refusedCacheableResponse) { throw 'A cacheable credential response was accepted.' }

Write-Host 'Windows enrollment contract checks passed.' -ForegroundColor Green
