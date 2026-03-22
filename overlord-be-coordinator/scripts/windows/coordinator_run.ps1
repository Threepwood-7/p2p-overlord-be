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
    [ValidateSet('dev', 'build', 'preview', 'check', 'debug')]
    [string]$Command = 'dev',

    [int]$InspectPort = 9229,

    [string]$Host = '0.0.0.0',

    [int]$Port = 13300,

    [string[]]$CoordinatorArgs = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:TaskkillPath = Join-Path ($env:SystemRoot ?? 'C:\Windows') 'System32\taskkill.exe'
$script:Paths = @{
    CoordinatorDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    PackageJson    = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\package.json'))
    EnvFile        = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\.env'))
    ViteBin        = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\node_modules\vite\bin\vite.js'))
}

function Write-Log {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    [Console]::Out.WriteLine($Message)
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
        if ((Get-ListeningProcessIds -LocalPort $LocalPort).Count -eq 0) {
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

    Push-Location -LiteralPath $script:Paths.CoordinatorDir
    try {
        & npm @npmArgs
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
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

    Push-Location -LiteralPath $script:Paths.CoordinatorDir
    try {
        & node @nodeArgs
        return $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

function Invoke-Main {
    Assert-Windows
    Ensure-CoordinatorLayout

    if ($Command -in @('dev', 'preview', 'debug')) {
        Stop-DanglingCoordinatorInstances -LocalPort $Port
        Warn-IfDatabaseLooksOffline
    }

    if ($Command -eq 'debug') {
        return Invoke-CoordinatorDebug `
            -InspectorPort $InspectPort `
            -ListenHost $Host `
            -ListenPort $Port `
            -AdditionalArgs $CoordinatorArgs
    }

    return Invoke-NpmScript -NpmCommand $Command -PassthroughArgs $CoordinatorArgs
}

try {
    exit (Invoke-Main)
}
catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
