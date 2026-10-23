$ErrorActionPreference = 'Stop'
$fixture = Join-Path $env:TEMP ('avtopult-production-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
try {
    . (Join-Path $PSScriptRoot 'production-deployment.ps1')
    $policy = Join-Path $fixture 'runner-policy.json'
    [IO.File]::WriteAllText(
        $policy,
        (@{
            repository = 'BillShifr/CTO_Agent'
            workflowRef = 'BillShifr/CTO_Agent/.github/workflows/deploy-agent.yml@refs/heads/main'
            gitRef = 'refs/heads/main'
        } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    $previousEnvironment = @{
        GITHUB_ACTIONS = $env:GITHUB_ACTIONS
        GITHUB_REPOSITORY = $env:GITHUB_REPOSITORY
        GITHUB_WORKFLOW_REF = $env:GITHUB_WORKFLOW_REF
        GITHUB_EVENT_NAME = $env:GITHUB_EVENT_NAME
        GITHUB_REF = $env:GITHUB_REF
    }
    try {
        $env:GITHUB_ACTIONS = 'true'
        $env:GITHUB_REPOSITORY = 'BillShifr/CTO_Agent'
        $env:GITHUB_WORKFLOW_REF = 'BillShifr/CTO_Agent/.github/workflows/deploy-agent.yml@refs/heads/main'
        $env:GITHUB_EVENT_NAME = 'workflow_run'
        $env:GITHUB_REF = 'refs/heads/main'
        & (Join-Path $PSScriptRoot 'runner-job-started.ps1') -PolicyFile $policy

        $env:GITHUB_WORKFLOW_REF = 'BillShifr/CTO_Agent/.github/workflows/ci.yml@refs/heads/main'
        $rejected = $false
        try { & (Join-Path $PSScriptRoot 'runner-job-started.ps1') -PolicyFile $policy }
        catch { $rejected = $_.Exception.Message -like 'Production runner rejected workflow*' }
        if (-not $rejected) { throw 'Runner policy accepted another workflow.' }

        $env:GITHUB_WORKFLOW_REF = 'BillShifr/CTO_Agent/.github/workflows/deploy-agent.yml@refs/heads/main'
        $env:GITHUB_EVENT_NAME = 'pull_request'
        $rejected = $false
        try { & (Join-Path $PSScriptRoot 'runner-job-started.ps1') -PolicyFile $policy }
        catch { $rejected = $_.Exception.Message -like 'Production runner rejected event*' }
        if (-not $rejected) { throw 'Runner policy accepted a pull request event.' }
    }
    finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) {
            [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
        }
    }

    $archive = Join-Path $PSScriptRoot '.artifacts\AvtoPult-OneCAgent-windows-x64.zip'
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
    $extracted = Join-Path $fixture 'release'
    $metadata = Expand-VerifiedAgentArchive -Archive $archive -ExpectedSha256 $hash -Destination $extracted
    if ($metadata.sourceRevision -notmatch '^[a-f0-9]{40}$') { throw 'Verified release revision is invalid.' }
    if (-not (Test-Path -LiteralPath (Join-Path $extracted 'setup-production-runner.ps1'))) {
        throw 'Production runner setup is missing from the release.'
    }

    $rejected = $false
    try {
        Expand-VerifiedAgentArchive -Archive $archive -ExpectedSha256 ('0' * 64) `
            -Destination (Join-Path $fixture 'rejected') | Out-Null
    }
    catch { $rejected = $_.Exception.Message -eq 'Agent release archive checksum mismatch.' }
    if (-not $rejected) { throw 'Production deployment accepted an invalid outer checksum.' }
    Write-Host 'Production runner policy and release verification passed.'
}
finally {
    Remove-Item -LiteralPath $fixture -Recurse -Force
}
