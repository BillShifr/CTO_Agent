[CmdletBinding()]
param(
    [string]$RepositoryUrl = 'https://github.com/BillShifr/CTO_Agent',
    [string]$RunnerName = "$([Environment]::MachineName)-avtopult-production",
    [string]$RunnerGroup,
    [string]$RunnerDirectory = 'C:\actions-runner-avtopult',
    [string]$AgentDirectory = 'C:\one-c-agent',
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$DeploymentDirectory = 'C:\ProgramData\AvtoPult\Deployment',
    [switch]$PreflightOnly,
    [switch]$Offline
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'production-deployment.ps1')
Assert-ProductionAdministrator

$repository = [Uri]$RepositoryUrl
if (-not $repository.IsAbsoluteUri -or $repository.Scheme -ne 'https' -or
    $repository.DnsSafeHost -ne 'github.com' -or $repository.UserInfo -or
    $repository.Query -or $repository.Fragment) {
    throw 'RepositoryUrl must be a plain HTTPS github.com repository URL.'
}
$repositorySlug = $repository.AbsolutePath.Trim('/')
if ($repositorySlug -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') {
    throw 'RepositoryUrl must contain exactly an owner and repository name.'
}
$allowedWorkflowRef = "$repositorySlug/.github/workflows/deploy-agent.yml@refs/heads/main"
$requiredTools = @(
    'production-deployment.ps1',
    'deploy-agent-release.ps1',
    'restore-agent-release.ps1',
    'diagnose-production.ps1',
    'runner-job-started.ps1',
    'production-runner-release.json'
)
foreach ($name in $requiredTools) {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot $name) -PathType Leaf)) {
        throw "Installation package is missing $name."
    }
}
$AgentDirectory = (Resolve-Path -LiteralPath $AgentDirectory).Path
$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
$agentService = Get-Service -Name AvtoPultOneCAgent -ErrorAction SilentlyContinue
if ($null -eq $agentService -or $agentService.Status -ne 'Running') {
    throw 'AvtoPultOneCAgent must be installed and running before the deployment runner is configured.'
}

if (-not $Offline) {
    Test-ProductionHttpsEndpoint 'https://github.com/' 'GitHub' | Out-Null
    Test-ProductionHttpsEndpoint 'https://api.github.com/' 'GitHub API' | Out-Null
}
$node = Join-Path $AgentDirectory 'runtime\node.exe'
$diagnosticArguments = @('-NodeExe', $node, '-AgentDirectory', $AgentDirectory, '-ConfigFile', $ConfigFile)
if ($Offline) { $diagnosticArguments += '-Offline' }
& (Join-Path $AgentDirectory 'diagnose-agent.ps1') @diagnosticArguments
if (-not $?) { throw 'Agent connectivity diagnostics failed.' }

$runnerRelease = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'production-runner-release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($runnerRelease.version -notmatch '^\d+\.\d+\.\d+$' -or
    $runnerRelease.sha256 -notmatch '^[a-f0-9]{64}$' -or
    $runnerRelease.url -ne "https://github.com/actions/runner/releases/download/v$($runnerRelease.version)/$($runnerRelease.asset)") {
    throw 'Pinned GitHub runner release metadata is invalid.'
}
if ($PreflightOnly) {
    Write-Host 'Production runner preflight passed. No directories, services or credentials were changed.' -ForegroundColor Green
    return
}

function Install-DeploymentTools {
    $root = Set-ProductionDirectoryAcl $DeploymentDirectory
    foreach ($name in $requiredTools) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $root $name) -Force
    }
    New-Item -ItemType Directory -Path (Join-Path $root 'reports'), (Join-Path $root 'staging') -Force | Out-Null
    $policy = [ordered]@{
        repository = $repositorySlug
        workflowRef = $allowedWorkflowRef
        gitRef = 'refs/heads/main'
    }
    [IO.File]::WriteAllText(
        (Join-Path $root 'runner-policy.json'),
        ($policy | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    [IO.File]::WriteAllText(
        (Join-Path $root 'production-settings.json'),
        (@{
            agentDirectory = $AgentDirectory
            configFile = $ConfigFile
            runnerDirectory = [IO.Path]::GetFullPath($RunnerDirectory)
        } | ConvertTo-Json),
        [Text.UTF8Encoding]::new($false)
    )
    Set-ProductionDirectoryAcl $root | Out-Null
    return $root
}

$deploymentRoot = Install-DeploymentTools
$runnerMarker = Join-Path $RunnerDirectory '.runner'
if (Test-Path -LiteralPath $runnerMarker -PathType Leaf) {
    $serviceName = Get-ProductionRunnerServiceName $RunnerDirectory
    [IO.File]::WriteAllText(
        (Join-Path $RunnerDirectory '.env'),
        "ACTIONS_RUNNER_HOOK_JOB_STARTED=$deploymentRoot\runner-job-started.ps1`n",
        [Text.UTF8Encoding]::new($false)
    )
    Set-ProductionDirectoryAcl $RunnerDirectory | Out-Null
    Restart-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    & (Join-Path $deploymentRoot 'diagnose-production.ps1') -AgentDirectory $AgentDirectory `
        -RunnerDirectory $RunnerDirectory -ConfigFile $ConfigFile -DeploymentDirectory $deploymentRoot `
        -Offline:$Offline
    Write-Host 'Existing production runner configuration and deployment tools were refreshed.' -ForegroundColor Green
    return
}
if (Test-Path -LiteralPath $RunnerDirectory) {
    $preparedMarker = Join-Path $RunnerDirectory '.avtopult-prepared-runner.json'
    if (-not (Test-ProductionDirectoryAcl $RunnerDirectory) -or
        -not (Test-Path -LiteralPath $preparedMarker -PathType Leaf)) {
        throw 'RunnerDirectory exists but is neither configured nor a protected installer-created runner.'
    }
    $preparedRelease = Get-Content -LiteralPath $preparedMarker -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($preparedRelease.version -ne $runnerRelease.version) {
        throw 'Prepared runner version differs from the pinned installer version.'
    }
    foreach ($required in @('config.cmd', 'run.cmd', 'bin\Runner.Listener.exe')) {
        if (-not (Test-Path -LiteralPath (Join-Path $RunnerDirectory $required) -PathType Leaf)) {
            throw "Prepared runner is missing $required."
        }
    }
    Write-Host 'Resuming registration of the protected runner payload.'
}
else {
    $runnerParent = Split-Path -Parent ([IO.Path]::GetFullPath($RunnerDirectory))
    New-Item -ItemType Directory -Path $runnerParent -Force | Out-Null
    $temporary = Join-Path $env:TEMP ('avtopult-runner-' + [Guid]::NewGuid().ToString('N'))
    $archive = Join-Path $temporary $runnerRelease.asset
    $staging = Join-Path $temporary 'runner'
    New-Item -ItemType Directory -Path $temporary, $staging | Out-Null
    try {
        Invoke-WebRequest -UseBasicParsing -Uri $runnerRelease.url -OutFile $archive
        $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actualHash -ne $runnerRelease.sha256) { throw 'GitHub runner package checksum mismatch.' }
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            $entries = @{}
            $total = [long]0
            foreach ($entry in $zip.Entries) {
                $name = $entry.FullName.Replace('/', '\')
                if (-not $name -or $name.StartsWith('\') -or $name.Contains(':') -or
                    ($name.Split('\') -contains '..') -or ($name.Split('\') -contains '.')) {
                    throw 'GitHub runner package contains an unsafe path.'
                }
                if ($entries.ContainsKey($name)) { throw 'GitHub runner package contains a duplicate path.' }
                $entries[$name] = $true
                $total += $entry.Length
                if ($total -gt 2GB -or $entries.Count -gt 20000) { throw 'GitHub runner package exceeds extraction limits.' }
            }
            foreach ($required in @('config.cmd', 'run.cmd', 'bin\Runner.Listener.exe')) {
                if (-not $entries.ContainsKey($required)) { throw "GitHub runner package is missing $required." }
            }
            [IO.Compression.ZipFile]::ExtractToDirectory($archive, $staging)
        }
        finally { $zip.Dispose() }
        [IO.File]::WriteAllText(
            (Join-Path $staging '.avtopult-prepared-runner.json'),
            (@{ version = $runnerRelease.version; sha256 = $runnerRelease.sha256 } | ConvertTo-Json),
            [Text.UTF8Encoding]::new($false)
        )
        [IO.Directory]::Move($staging, $RunnerDirectory)
        Set-ProductionDirectoryAcl $RunnerDirectory | Out-Null
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Recurse -Force }
    }
}

[IO.File]::WriteAllText(
    (Join-Path $RunnerDirectory '.env'),
    "ACTIONS_RUNNER_HOOK_JOB_STARTED=$deploymentRoot\runner-job-started.ps1`n",
    [Text.UTF8Encoding]::new($false)
)
Set-ProductionDirectoryAcl $RunnerDirectory | Out-Null
$registrationToken = Read-ProductionSecret 'One-time GitHub runner registration token' 20
try {
    $arguments = @(
        '--unattended',
        '--url', $RepositoryUrl.TrimEnd('/'),
        '--token', $registrationToken,
        '--name', $RunnerName,
        '--work', '_work',
        '--replace',
        '--no-default-labels',
        '--labels', 'avtopult-one-c-production',
        '--runasservice',
        '--windowslogonaccount', 'NT AUTHORITY\SYSTEM'
    )
    if (-not [string]::IsNullOrWhiteSpace($RunnerGroup)) {
        $arguments += @('--runnergroup', $RunnerGroup)
    }
    Push-Location $RunnerDirectory
    try {
        & (Join-Path $RunnerDirectory 'config.cmd') @arguments
        if ($LASTEXITCODE -ne 0) { throw 'GitHub runner registration or service installation failed.' }
    }
    finally { Pop-Location }
}
finally {
    $registrationToken = $null
    $arguments = $null
}
$serviceName = Get-ProductionRunnerServiceName $RunnerDirectory
Set-Service -Name $serviceName -StartupType Automatic
$service = Get-Service -Name $serviceName
if ($service.Status -ne 'Running') { Start-Service -Name $serviceName }
$service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
Set-ProductionDirectoryAcl $RunnerDirectory | Out-Null
& (Join-Path $deploymentRoot 'diagnose-production.ps1') -AgentDirectory $AgentDirectory `
    -RunnerDirectory $RunnerDirectory -ConfigFile $ConfigFile -DeploymentDirectory $deploymentRoot `
    -Offline:$Offline
Write-Host 'Production GitHub runner is registered, protected and running as a Windows service.' -ForegroundColor Green
