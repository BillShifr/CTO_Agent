[CmdletBinding()]
param(
    [string]$PolicyFile = (Join-Path $PSScriptRoot 'runner-policy.json')
)

$ErrorActionPreference = 'Stop'
if (-not (Test-Path -LiteralPath $PolicyFile -PathType Leaf)) {
    throw 'Production runner policy was not found.'
}
$policy = Get-Content -LiteralPath $PolicyFile -Raw -Encoding UTF8 | ConvertFrom-Json
$actual = @{
    repository = $env:GITHUB_REPOSITORY
    workflowRef = $env:GITHUB_WORKFLOW_REF
    eventName = $env:GITHUB_EVENT_NAME
    gitRef = $env:GITHUB_REF
}
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Production runner hook can run only inside GitHub Actions.' }
if ($actual.repository -ne $policy.repository) {
    throw "Production runner rejected repository '$($actual.repository)'."
}
if ($actual.workflowRef -ne $policy.workflowRef) {
    throw "Production runner rejected workflow '$($actual.workflowRef)'."
}
if ($actual.eventName -notin @('workflow_run', 'workflow_dispatch')) {
    throw "Production runner rejected event '$($actual.eventName)'."
}
if ($actual.gitRef -ne $policy.gitRef) {
    throw "Production runner rejected ref '$($actual.gitRef)'."
}
Write-Host "Production runner policy accepted $($actual.workflowRef)."
