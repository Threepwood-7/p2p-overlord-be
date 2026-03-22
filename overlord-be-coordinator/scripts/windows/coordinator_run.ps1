<#
.SYNOPSIS
Starts or checks the coordinator from a Windows-first PowerShell entry point.

.DESCRIPTION
This helper validates the coordinator layout, force-kills any stale listener on the
coordinator port before `dev`, `preview`, or `debug`, warns when PostgreSQL looks
offline, and then forwards control to either npm or a direct Node inspector launch.
#>

[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('dev', 'build', 'preview', 'check', 'debug', 'stop')]
    [string]$Command = 'dev',

    [int]$InspectPort = 9229,

    [string]$ListenHost = '0.0.0.0',

    [int]$Port = 13300,

    [string[]]$CoordinatorArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskkillPath = Join-Path ($env:SystemRoot ?? 'C:\Windows') 'System32\taskkill.exe'
$script:CmdPath = Join-Path ($env:SystemRoot ?? 'C:\Windows') 'System32\cmd.exe'
$script:Paths = @{
    CoordinatorDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    PackageJson    = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\package.json'))
    EnvFile        = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\.env'))
    ViteBin        = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\node_modules\vite\bin\vite.js'))
    LogDir         = 'c:\tmp\p2p-overlord'
    StdoutLogFile  = 'c:\tmp\p2p-overlord\coordinator_stdout.log'
    StderrLogFile  = 'c:\tmp\p2p-overlord\coordinator_stderr.log'
    MainLogFile    = 'c:\tmp\p2p-overlord\coordinator_main.log'
}
$script:LogEncoding = [System.Text.UTF8Encoding]::new($false)
$script:MainLogLock = New-Object object

function Ensure-LogLayout {
    if (-not (Test-Path -LiteralPath $script:Paths.LogDir -PathType Container)) {
        New-Item -ItemType Directory -Path $script:Paths.LogDir -Force | Out-Null
    }
}

function Append-LogLine {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [AllowEmptyString()]
        [string]$Line
    )

    Ensure-LogLayout
    [System.IO.File]::AppendAllText(
        $Path,
        $Line + [System.Environment]::NewLine,
        $script:LogEncoding
    )
}

function New-RunBanner {
    $timestamp = Get-Date -Format o
    $arguments = if ($CoordinatorArgs.Count -gt 0) {
        $CoordinatorArgs -join ' '
    }
    else {
        '(none)'
    }

    return "==== coordinator run timestamp=$timestamp command=$Command host=$ListenHost port=$Port cwd=$($script:Paths.CoordinatorDir) extra_args=$arguments ===="
}

function Write-RunBanner {
    param(
        [string[]]$Paths = @($script:Paths.MainLogFile, $script:Paths.StdoutLogFile, $script:Paths.StderrLogFile)
    )

    $banner = New-RunBanner
    foreach ($path in $Paths) {
        Append-LogLine -Path $path -Line ''
        Append-LogLine -Path $path -Line $banner
    }
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    $timestampedMessage = "$(Get-Date -Format o) $Message"
    [Console]::Out.WriteLine($timestampedMessage)

    [System.Threading.Monitor]::Enter($script:MainLogLock)
    try {
        Append-LogLine -Path $script:Paths.MainLogFile -Line $timestampedMessage
    }
    finally {
        [System.Threading.Monitor]::Exit($script:MainLogLock)
    }
}

function Resolve-CommandPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandName
    )

    $command = Get-Command -Name $CommandName -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
        Fail "Unable to resolve executable path for $CommandName"
    }

    return $command.Source
}

function Format-CmdArgument {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    return '"' + $Value.Replace('"', '""') + '"'
}

function Build-CmdInvocation {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [string[]]$Arguments = @()
    )

    $segments = @()
    $segments += 'set "NO_COLOR=1"'
    $segments += '&&'
    $segments += 'set "FORCE_COLOR=0"'
    $segments += '&&'
    $segments += 'set "npm_config_color=false"'
    $segments += '&&'
    $segments += 'set "TERM=dumb"'
    $segments += '&&'
    if ($FilePath.EndsWith('.cmd', [System.StringComparison]::OrdinalIgnoreCase) -or
        $FilePath.EndsWith('.bat', [System.StringComparison]::OrdinalIgnoreCase)) {
        $segments += 'call'
    }

    $segments += (Format-CmdArgument -Value $FilePath)
    foreach ($argument in $Arguments) {
        $segments += (Format-CmdArgument -Value $argument)
    }
    $segments += '1>>' + (Format-CmdArgument -Value $script:Paths.StdoutLogFile)
    $segments += '2>>' + (Format-CmdArgument -Value $script:Paths.StderrLogFile)

    return $segments -join ' '
}

function Invoke-LoggedProcess {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,

        [Parameter(Mandatory = $true)]
        [string]$DisplayName,

        [string[]]$Arguments = @(),

        [Parameter(Mandatory = $true)]
        [string]$WorkingDirectory
    )

    Ensure-LogLayout
    Write-Log "Launching $DisplayName"

    $process = $null
    $commandLine = Build-CmdInvocation -FilePath $FilePath -Arguments $Arguments
    try {
        $process = Start-Process `
            -FilePath $script:CmdPath `
            -ArgumentList @('/d', '/s', '/c', $commandLine) `
            -WorkingDirectory $WorkingDirectory `
            -PassThru `
            -Wait

        $exitCode = $process.ExitCode
        Write-Log "$DisplayName exited with code $exitCode"
        return $exitCode
    }
    catch {
        Write-Log "$DisplayName failed before returning an exit code: $($_.Exception.Message)"
        throw
    }
    finally {
        if ($null -ne $process) {
            $process.Dispose()
        }
    }
}

function Fail {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    throw $Message
}

function Assert-Windows {
    if (-not $IsWindows) {
        Fail "This helper currently supports Windows only. Detected platform: $([System.Environment]::OSVersion.Platform)"
    }
}

function Ensure-CoordinatorLayout {
    if (-not (Test-Path -LiteralPath $script:Paths.PackageJson -PathType Leaf)) {
        Fail "Coordinator package.json is missing at $($script:Paths.PackageJson)"
    }
}

function Ensure-ViteDebugEntrypoint {
    if (-not (Test-Path -LiteralPath $script:Paths.ViteBin -PathType Leaf)) {
        Fail "Vite debug entrypoint is missing at $($script:Paths.ViteBin)"
    }
}

function Read-DatabaseUrl {
    if (-not (Test-Path -LiteralPath $script:Paths.EnvFile -PathType Leaf)) {
        return $null
    }

    foreach ($rawLine in Get-Content -LiteralPath $script:Paths.EnvFile) {
        $line = $rawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith('#', [System.StringComparison]::Ordinal)) {
            continue
        }

        $separatorIndex = $line.IndexOf('=')
        if ($separatorIndex -lt 0) {
            continue
        }

        $key = $line.Substring(0, $separatorIndex).Trim()
        if ($key -ne 'DATABASE_URL') {
            continue
        }

        $value = $line.Substring($separatorIndex + 1).Trim()
        if ([string]::IsNullOrWhiteSpace($value)) {
            return $null
        }

        return $value
    }

    return $null
}

function Test-PostgresUrl {
    param(
        [AllowNull()]
        [string]$DatabaseUrl
    )

    if ([string]::IsNullOrWhiteSpace($DatabaseUrl)) {
        return $false
    }

    try {
        $uri = [System.Uri]$DatabaseUrl
        return $uri.Scheme -in @('postgresql', 'postgres')
    }
    catch {
        return $false
    }
}

function Test-TcpEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$HostName,

        [Parameter(Mandatory = $true)]
        [int]$TargetPort,

        [int]$TimeoutMs = 1200
    )

    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $connectTask = $client.ConnectAsync($HostName, $TargetPort)
        if (-not $connectTask.Wait($TimeoutMs)) {
            return $false
        }

        return $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Warn-IfDatabaseLooksOffline {
    $databaseUrl = Read-DatabaseUrl
    if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
        Write-Log 'Warning: .env does not define DATABASE_URL. The coordinator may fail once DB access is needed.'
        return
    }

    if (-not (Test-PostgresUrl -DatabaseUrl $databaseUrl)) {
        Write-Log 'Warning: DATABASE_URL is present but could not be parsed as a PostgreSQL URL.'
        return
    }

    $uri = [System.Uri]$databaseUrl
    $hostName = if ([string]::IsNullOrWhiteSpace($uri.Host)) { '127.0.0.1' } else { $uri.Host }
    $targetPort = if ($uri.Port -gt 0) { $uri.Port } else { 5432 }
    if (-not (Test-TcpEndpoint -HostName $hostName -TargetPort $targetPort)) {
        Write-Log "Warning: PostgreSQL at ${hostName}:$targetPort is not reachable right now."
        Write-Log 'Hint: node overlord-be/overlord-be-db/scripts/windows/db_run.mjs start'
    }
}

function Get-ListeningProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int]$LocalPort
    )

    # Listening PIDs are the safest way to identify a stale coordinator because the
    # Windows helper owns the chosen TCP port for dev, preview, and debug.
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue)
    if ($connections.Count -eq 0) {
        return @()
    }

    return @($connections |
        Where-Object { $_.OwningProcess -gt 0 } |
        Select-Object -ExpandProperty OwningProcess -Unique)
}

function Stop-ProcessTreeHard {
    param(
        [Parameter(Mandatory = $true)]
        [int]$ProcessId
    )

    $taskkillArgs = @('/F', '/T', '/PID', [string]$ProcessId)
    & $script:TaskkillPath @taskkillArgs | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Fail "Failed to terminate dangling coordinator process tree $ProcessId via taskkill."
    }
}

function Wait-ForPortRelease {
    param(
        [Parameter(Mandatory = $true)]
        [int]$LocalPort,

        [int]$TimeoutMs = 5000
    )

    $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds($TimeoutMs)
    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        $listeningPids = @(Get-ListeningProcessIds -LocalPort $LocalPort)
        if ($listeningPids.Count -eq 0) {
            return
        }

        Start-Sleep -Milliseconds 150
    }

    Fail "Coordinator port $LocalPort is still busy after terminating stale instances."
}

function Stop-DanglingCoordinatorInstances {
    param(
        [Parameter(Mandatory = $true)]
        [int]$LocalPort
    )

    $listeningPids = @(Get-ListeningProcessIds -LocalPort $LocalPort)
    if ($listeningPids.Count -eq 0) {
        return
    }

    Write-Log "Found dangling coordinator instance(s) on port ${LocalPort}: $($listeningPids -join ', ')"
    foreach ($processId in $listeningPids) {
        Write-Log "Hard-killing process tree $processId..."
        Stop-ProcessTreeHard -ProcessId $processId
    }

    Wait-ForPortRelease -LocalPort $LocalPort
}

function Stop-Coordinator {
    param(
        [Parameter(Mandatory = $true)]
        [int]$LocalPort
    )

    $listeningPids = @(Get-ListeningProcessIds -LocalPort $LocalPort)
    if ($listeningPids.Count -eq 0) {
        Write-Log "No coordinator instance is listening on port ${LocalPort}."
        return 0
    }

    Write-Log "Stopping coordinator instance(s) on port ${LocalPort}: $($listeningPids -join ', ')"
    foreach ($processId in $listeningPids) {
        Stop-ProcessTreeHard -ProcessId $processId
    }

    Wait-ForPortRelease -LocalPort $LocalPort
    Write-Log "Coordinator stopped on port ${LocalPort}."
    return 0
}

function Invoke-NpmScript {
    param(
        [Parameter(Mandatory = $true)]
        [string]$NpmCommand,

        [string[]]$PassthroughArgs = @()
    )

    $npmArgs = @('run', $NpmCommand)
    if ($PassthroughArgs.Count -gt 0) {
        $npmArgs += '--'
        $npmArgs += $PassthroughArgs
    }

    return Invoke-LoggedProcess `
        -FilePath (Resolve-CommandPath -CommandName 'npm.cmd') `
        -DisplayName "npm $NpmCommand" `
        -Arguments $npmArgs `
        -WorkingDirectory $script:Paths.CoordinatorDir
}

function Invoke-CoordinatorDebug {
    param(
        [Parameter(Mandatory = $true)]
        [int]$InspectorPort,

        [Parameter(Mandatory = $true)]
        [string]$ListenHost,

        [Parameter(Mandatory = $true)]
        [int]$ListenPort,

        [string[]]$AdditionalArgs = @()
    )

    Ensure-ViteDebugEntrypoint

    $nodeArgs = @(
        "--inspect=$InspectorPort",
        $script:Paths.ViteBin,
        'dev',
        '--host',
        $ListenHost,
        '--port',
        [string]$ListenPort
    )

    if ($AdditionalArgs.Count -gt 0) {
        $nodeArgs += $AdditionalArgs
    }

    return Invoke-LoggedProcess `
        -FilePath (Resolve-CommandPath -CommandName 'node.exe') `
        -DisplayName 'node vite debug' `
        -Arguments $nodeArgs `
        -WorkingDirectory $script:Paths.CoordinatorDir
}

function Invoke-Main {
    Assert-Windows
    Ensure-LogLayout

    if ($Command -eq 'stop') {
        Write-RunBanner -Paths @($script:Paths.MainLogFile)
        Write-Log "coordinator_run.ps1 starting command=$Command host=$ListenHost port=$Port"
        return Stop-Coordinator -LocalPort $Port
    }

    Write-RunBanner
    Write-Log "coordinator_run.ps1 starting command=$Command host=$ListenHost port=$Port"
    Ensure-CoordinatorLayout

    if ($Command -in @('dev', 'preview', 'debug')) {
        Stop-DanglingCoordinatorInstances -LocalPort $Port
        Warn-IfDatabaseLooksOffline
    }

    if ($Command -eq 'debug') {
        return Invoke-CoordinatorDebug `
            -InspectorPort $InspectPort `
            -ListenHost $ListenHost `
            -ListenPort $Port `
            -AdditionalArgs $CoordinatorArgs
    }

    return Invoke-NpmScript -NpmCommand $Command -PassthroughArgs $CoordinatorArgs
}

try {
    exit (Invoke-Main)
}
catch {
    Write-Log "coordinator_run.ps1 failed: $($_.Exception.Message)"
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
