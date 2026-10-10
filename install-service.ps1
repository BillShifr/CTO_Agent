param(
    [Parameter(Mandatory = $true)][string]$NodeExe,
    [Parameter(Mandatory = $true)][string]$AgentDirectory,
    [string]$WinSWExe,
    [string]$ConfigFile = 'C:\ProgramData\AvtoPult\OneCAgent\agent-config.json',
    [string]$WinSWExpectedSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da'
)

$ErrorActionPreference = 'Stop'
$serviceName = 'AvtoPultOneCAgent'
$requiredEnvironment = @(
    'AVTOPULT_AGENT_ID',
    'AVTOPULT_API_URL',
    'AVTOPULT_AGENT_SECRET',
    'ONE_C_WRITE_URL',
    'ONE_C_USERNAME',
    'ONE_C_PASSWORD',
    'ONE_C_ODATA_URL',
    'ONE_C_ODATA_USERNAME',
    'ONE_C_ODATA_PASSWORD',
    'AVTOPULT_AGENT_STATE_DIR'
)

$principal = New-Object Security.Principal.WindowsPrincipal(
    [Security.Principal.WindowsIdentity]::GetCurrent()
)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Run this installer from an elevated PowerShell session.'
}

function Set-AgentDirectoryAcl([string]$Path) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
        $identity = New-Object Security.Principal.SecurityIdentifier($sid)
        $rule = New-Object Security.AccessControl.FileSystemAccessRule(
            $identity,
            'FullControl',
            'ContainerInherit,ObjectInherit',
            'None',
            'Allow'
        )
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

$NodeExe = (Resolve-Path $NodeExe).Path
$AgentDirectory = (Resolve-Path $AgentDirectory).Path
$agentDirectoryItem = Get-Item -LiteralPath $AgentDirectory
if ($agentDirectoryItem.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'AgentDirectory must not be a reparse point.'
}
if ([string]::IsNullOrWhiteSpace($WinSWExe)) {
    $WinSWExe = Join-Path $AgentDirectory 'WinSW-x64.exe'
}
$WinSWExe = (Resolve-Path $WinSWExe).Path
$agentBundle = Join-Path $AgentDirectory 'agent.mjs'
if (-not (Test-Path $agentBundle -PathType Leaf)) {
    throw "Agent bundle was not found: $agentBundle"
}

$actualHash = (Get-FileHash $WinSWExe -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualHash -ne $WinSWExpectedSha256.ToLowerInvariant()) {
    throw 'WinSW checksum mismatch. Use the reviewed WinSW 2.12.0 x64 binary or pass an approved checksum explicitly.'
}

$existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($null -ne $existing) {
    throw 'The agent service is already installed. Use update-service.ps1 for a transactional update.'
}

$ConfigFile = (Resolve-Path -LiteralPath $ConfigFile).Path
$settings = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
$missingEnvironment = @(
    $requiredEnvironment | Where-Object {
        [string]::IsNullOrWhiteSpace($settings.$_)
    }
)
if ($missingEnvironment.Count -gt 0) {
    throw ('Missing configuration fields: ' + ($missingEnvironment -join ', '))
}

$stateDirectory = $settings.AVTOPULT_AGENT_STATE_DIR
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
Set-AgentDirectoryAcl $stateDirectory

$wrapper = Join-Path $AgentDirectory "$serviceName.exe"
$configuration = Join-Path $AgentDirectory "$serviceName.xml"
$escapedNode = [Security.SecurityElement]::Escape($NodeExe)
$escapedConfig = [Security.SecurityElement]::Escape($ConfigFile)
$xml = @"
<service>
  <id>$serviceName</id>
  <name>AvtoPult 1C Integration Agent</name>
  <description>Outbound relay between AvtoPult Cloud and the local 1C infobase.</description>
  <executable>$escapedNode</executable>
  <arguments>&quot;%BASE%\agent.mjs&quot;</arguments>
  <workingdirectory>%BASE%</workingdirectory>
  <env name="AVTOPULT_AGENT_CONFIG_FILE" value="$escapedConfig" />
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="5 sec" />
  <onfailure action="restart" delay="15 sec" />
  <onfailure action="restart" delay="60 sec" />
  <resetfailure>1 day</resetfailure>
  <logpath>%BASE%\logs</logpath>
  <log mode="roll" />
</service>
"@

Copy-Item $WinSWExe $wrapper -Force
[IO.File]::WriteAllText($configuration, $xml, [Text.UTF8Encoding]::new($false))

# The service runs as SYSTEM, so writable code would be a local privilege-escalation path.
Set-AgentDirectoryAcl $AgentDirectory

try {
    & $wrapper install
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install the agent service.' }
    & $wrapper start
    if ($LASTEXITCODE -ne 0) { throw 'Failed to start the agent service.' }

    $installed = Get-Service -Name $serviceName
    $installed.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    Start-Sleep -Seconds 5
    $installed.Refresh()
    if ($installed.Status -ne 'Running') {
        throw "Agent service status is $($installed.Status), expected Running."
    }
}
catch {
    $failure = $_
    $created = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $created) {
        if ($created.Status -ne 'Stopped') { & $wrapper stop | Out-Null }
        & $wrapper uninstall | Out-Null
    }
    Remove-Item -LiteralPath $wrapper, $configuration -Force -ErrorAction SilentlyContinue
    throw $failure
}
Write-Host 'AvtoPult 1C Integration Agent is installed and running.' -ForegroundColor Green
