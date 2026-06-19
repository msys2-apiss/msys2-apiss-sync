#requires -Version 7.0
<#
.SYNOPSIS
    Step 1/4: fetch upstream history into CSV (ports.csv, ports-mingw.csv).
#>
[CmdletBinding()]
param(
    [ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
    [string] $Mode = 'Incremental',
    [switch] $SkipFetch,
    [switch] $Refresh
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot/lib/Sync-Common.ps1"
Set-SyncUtf8Environment
. "$PSScriptRoot/lib/Sync-Config.ps1"
. "$PSScriptRoot/lib/Sync-State.ps1"
. "$PSScriptRoot/lib/Sync-Git.ps1"
. "$PSScriptRoot/lib/Sync-LogStore.ps1"

try {
    $config = Get-SyncConfig -RepoRoot $repoRoot
    $state = Get-SyncState -RepoRoot $repoRoot
    $workDirectory = Get-WorkDirectory -RepoRoot $repoRoot

    $mirrors = @{}
    foreach ($prop in $config.sources.PSObject.Properties) {
        $mirrors[$prop.Name] = Initialize-MirrorRepository `
            -WorkDirectory $workDirectory `
            -SourceId $prop.Name `
            -SourceEntry $prop.Value `
            -SkipFetch:$SkipFetch
    }

    $logs = Export-ReplaySourceLogs `
        -RepoRoot $repoRoot `
        -Config $config `
        -State $state `
        -Mirrors $mirrors `
        -Mode $Mode `
        -Refresh:$Refresh

    $total = Get-ReplayPendingCount -SourceLogs $logs
    Write-SyncLog "Step 1/4 complete; $total commit(s) in source CSV file(s)."
    exit 0
}
catch {
    Write-SyncLog $_.Exception.Message -Level Error
    if ($_.ScriptStackTrace) {
        Write-SyncLog $_.ScriptStackTrace -Level Error
    }
    exit 1
}
