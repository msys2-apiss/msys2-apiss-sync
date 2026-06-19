#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Get-ReplayCheckpointPath {
    param([Parameter(Mandatory)][string] $WorkDirectory)

    return Join-Path $WorkDirectory 'cache/replay-log/replay-checkpoint.json'
}

function Get-ReplayCheckpoint {
    param([Parameter(Mandatory)][string] $WorkDirectory)

    $path = Get-ReplayCheckpointPath -WorkDirectory $WorkDirectory
    if (-not (Test-Path -LiteralPath $path)) {
        return $null
    }

    $raw = [System.IO.File]::ReadAllText($path, [System.Text.UTF8Encoding]::new($false))
    if (-not $raw.Trim()) {
        return $null
    }

    return ($raw | ConvertFrom-Json)
}

function Save-ReplayCheckpoint {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][bool] $DryRun,
        [AllowNull()][string] $LastPortsSha,
        [AllowNull()][string] $LastPortsMingwSha,
        [AllowNull()][string] $ReplayTipSha,
        [Parameter(Mandatory)][int] $ProcessedCount
    )

    $path = Get-ReplayCheckpointPath -WorkDirectory $WorkDirectory
    $dir = Split-Path -Parent $path
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $payload = [ordered]@{
        ReplaySpecVersion = $Config.ReplaySpecVersion
        DryRun = $DryRun
        LastPortsSha = $LastPortsSha
        LastPortsMingwSha = $LastPortsMingwSha
        ReplayTipSha = $ReplayTipSha
        ProcessedCount = $ProcessedCount
        UpdatedAt = (Get-Date).ToUniversalTime().ToString('o')
    }

    $json = ($payload | ConvertTo-Json -Depth 3)
    [System.IO.File]::WriteAllText($path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Clear-ReplayCheckpoint {
    param([Parameter(Mandatory)][string] $WorkDirectory)

    $path = Get-ReplayCheckpointPath -WorkDirectory $WorkDirectory
    if (Test-Path -LiteralPath $path) {
        Remove-Item -LiteralPath $path -Force
    }
}
