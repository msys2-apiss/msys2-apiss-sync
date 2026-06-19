#requires -Version 7.0
<#
.SYNOPSIS
    Step 2/4: import source CSV files, sort, write replay-queue.json (no git).
#>
[CmdletBinding()]
param(
    [switch] $Refresh
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$PSScriptRoot/lib/Sync-Common.ps1"
Set-SyncUtf8Environment
. "$PSScriptRoot/lib/Sync-Config.ps1"
. "$PSScriptRoot/lib/Sync-LogStore.ps1"

try {
    $config = Get-SyncConfig -RepoRoot $repoRoot
    $workDirectory = Get-WorkDirectory -RepoRoot $repoRoot

    $mirrors = @{}
    foreach ($prop in $config.sources.PSObject.Properties) {
        $mirrors[$prop.Name] = Join-Path $workDirectory "mirrors/$($prop.Value.repo)"
    }

    $sourceLogs = Import-ReplaySourceLogsFromDisk -RepoRoot $repoRoot -Config $config
    $queue = Export-ReplayQueueJson `
        -RepoRoot $repoRoot `
        -Config $config `
        -Mirrors $mirrors `
        -SourceLogs $sourceLogs `
        -Refresh:$Refresh

    Write-SyncLog "Step 2/4 complete; $($queue.Count) commit(s) in replay-queue.json"
    exit 0
}
catch {
    Write-SyncLog $_.Exception.Message -Level Error
    if ($_.ScriptStackTrace) {
        Write-SyncLog $_.ScriptStackTrace -Level Error
    }
    exit 1
}
