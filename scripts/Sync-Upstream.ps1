#requires -Version 7.0
<#
.SYNOPSIS
    Replay upstream MSYS2 package history into msys2-uwp/msys2-uwp.

.DESCRIPTION
    Retrieves pending upstream commits, merges by replay rank, replays one-by-one
    onto destination branch upstream, updates cursor branches, and pushes unless
    -DryRun. Bootstrap vs incremental is derived from destination branch presence.
    Use -Resume to continue after a failed or interrupted run (checkpoint in
    .work/cache/replay-log/replay-checkpoint.json).
#>
[CmdletBinding()]
param(
    [string] $DestinationPath,
    [switch] $Clean,
    [switch] $DryRun,
    [switch] $SkipFetch,
    [int] $MaxCommits = 0,
    [string] $LogFile,
    [switch] $LogAppend,
    [switch] $LogToConsole,
    [switch] $Resume,
    [switch] $ClearCheckpoint
)

$ErrorActionPreference = 'Stop'

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
. "$repoRoot/scripts/lib/Sync-GitReplay.ps1"
. "$repoRoot/scripts/lib/Sync-GitQueue.ps1"
. "$repoRoot/scripts/lib/Sync-GitHistory.ps1"
. "$repoRoot/scripts/lib/Sync-GitCheckpoint.ps1"
. "$repoRoot/scripts/lib/Sync-Git.ps1"
Set-SyncUtf8Environment

if ($LogFile) {
    $logPath = if ([System.IO.Path]::IsPathRooted($LogFile)) {
        $LogFile
    }
    else {
        Join-Path $repoRoot $LogFile
    }
    Set-SyncLogFile -Path $logPath -Append:$LogAppend -QuietConsole:(-not $LogToConsole)
}

try {
    $config = Get-SyncConfig -RepoRoot $repoRoot
    $work = Get-WorkDirectory -RepoRoot $repoRoot
    $replayBranch = $config.Destination.Branches.Replay
    $cursorPortsBranch = $config.Destination.Branches.CursorPorts
    $cursorMingwBranch = $config.Destination.Branches.CursorPortsMingw

    if ($ClearCheckpoint) {
        Clear-ReplayCheckpoint -WorkDirectory $work
        Write-SyncLog 'Checkpoint cleared.'
    }

    Write-SyncLog "Sync-Upstream start (clean=$Clean dryRun=$DryRun skipFetch=$SkipFetch resume=$Resume)"

    $mirrorPorts = Initialize-MirrorRepository `
        -WorkDirectory $work -SourceKey Ports -Config $config -SkipFetch:$SkipFetch
    $mirrorMingw = Initialize-MirrorRepository `
        -WorkDirectory $work -SourceKey PortsMingw -Config $config -SkipFetch:$SkipFetch

    $destPath = Initialize-DestinationRepository `
        -WorkDirectory $work -Config $config -DestinationPath $DestinationPath -SkipFetch:$SkipFetch

    Initialize-DestinationAlternates -DestinationPath $destPath -MirrorPaths @($mirrorPorts, $mirrorMingw)
    Ensure-DestinationBaseCommit -DestinationPath $destPath -Config $config

    if ($Clean) {
        Write-SyncLog 'Clean: resetting sync branches'
        Clear-DestinationSyncBranches -DestinationPath $destPath -Config $config
        Clear-ReplayCheckpoint -WorkDirectory $work
    }

    $cursorPorts = Get-DestinationBranchSha -DestinationPath $destPath -BranchName $cursorPortsBranch
    $cursorMingw = Get-DestinationBranchSha -DestinationPath $destPath -BranchName $cursorMingwBranch
    $isFullReplay = -not (Test-AllSyncBranchesExist -DestinationPath $destPath -Config $config)

    $checkpoint = $null
    if ($Resume) {
        $checkpoint = Get-ReplayCheckpoint -WorkDirectory $work
        if (-not $checkpoint) {
            Write-SyncLog 'Resume requested but no checkpoint found; starting from cursors.' -Level Warn
        }
        elseif ([bool]$checkpoint.DryRun -ne [bool]$DryRun) {
            throw 'Checkpoint DryRun flag does not match this run. Use the same -DryRun setting as the interrupted run.'
        }
        elseif ($checkpoint.ReplaySpecVersion -ne $config.ReplaySpecVersion) {
            throw "Checkpoint ReplaySpecVersion $($checkpoint.ReplaySpecVersion) does not match config $($config.ReplaySpecVersion)."
        }
        else {
            $cursorPorts = $checkpoint.LastPortsSha
            $cursorMingw = $checkpoint.LastPortsMingwSha
            Write-SyncLog "Resume: continuing after $($checkpoint.ProcessedCount) processed entry(ies)"
            if ($checkpoint.LastPortsSha) {
                Write-SyncLog "  ports cursor=$($checkpoint.LastPortsSha.Substring(0, 8))"
            }
            if ($checkpoint.LastPortsMingwSha) {
                Write-SyncLog "  mingw cursor=$($checkpoint.LastPortsMingwSha.Substring(0, 8))"
            }
        }
    }

    if ($isFullReplay -and -not $checkpoint) {
        Write-SyncLog 'Bootstrap: full replay (no age gate)'
    }
    elseif (-not $checkpoint) {
        Write-SyncLog "Incremental: cursors ports=$($cursorPorts.Substring(0, 8)) mingw=$($cursorMingw.Substring(0, 8))"
    }

    if ($checkpoint -and $checkpoint.ReplayTipSha -and -not $DryRun) {
        $null = Invoke-Git -RepoPath $destPath -GitArgs @(
            'checkout', '-B', $replayBranch, $checkpoint.ReplayTipSha
        )
        $isFullReplay = $false
    }
    else {
        Set-DestinationReplayCheckout -DestinationPath $destPath -Config $config -IsFullReplay:$isFullReplay
    }

    $tipPorts = Get-MirrorTipSha -MirrorPath $mirrorPorts -Branch $config.Sources.Ports.Branch
    $tipMingw = Get-MirrorTipSha -MirrorPath $mirrorMingw -Branch $config.Sources.PortsMingw.Branch

    $portsList = Get-SourceReplayHistory `
        -SourceKey Ports -Config $config -MirrorPath $mirrorPorts `
        -AfterSha $cursorPorts -UntilSha $tipPorts

    $mingwList = Get-SourceReplayHistory `
        -SourceKey PortsMingw -Config $config -MirrorPath $mirrorMingw `
        -AfterSha $cursorMingw -UntilSha $tipMingw

    $queue = Merge-ReplayCommitQueues -PortsList $portsList -PortsMingwList $mingwList

    Write-SyncLog "Retrieved ports=$($portsList.Count) mingw=$($mingwList.Count) merged=$($queue.Count)"

    if (-not $isFullReplay) {
        $queue = Filter-ReplayQueueByAge -Queue $queue -Config $config
        Write-SyncLog "After age gate: $($queue.Count) commit(s)"
    }

    if ($queue.Count -eq 0) {
        Write-SyncLog 'No commits to replay.'
        if ($Resume -and $checkpoint) {
            Clear-ReplayCheckpoint -WorkDirectory $work
        }
        exit 0
    }

    if ($MaxCommits -gt 0 -and $queue.Count -gt $MaxCommits) {
        $queue = @($queue | Select-Object -First $MaxCommits)
        Write-SyncLog "Throttled to MaxCommits=$MaxCommits"
    }

    $mirrorBySourceId = @{
        'ports' = $mirrorPorts
        'ports-mingw' = $mirrorMingw
    }

    $lastPortsSha = $cursorPorts
    $lastMingwSha = $cursorMingw
    $replayed = 0
    $index = 0
    $skipEmpty = [bool]$config.Replay.SkipEmptyTreeDiff
    $priorProcessed = if ($checkpoint) { [int]$checkpoint.ProcessedCount } else { 0 }

    foreach ($entry in $queue) {
        $index++
        $mirrorPath = $mirrorBySourceId[$entry.SourceId]
        if (-not $mirrorPath) {
            throw "Unknown SourceId on queue entry: $($entry.SourceId)"
        }

        $parent = Get-FirstParent -MirrorPath $mirrorPath -Commit $entry.Sha
        $message = Format-ReplayCommitMessage `
            -SortKey $entry.SortKey `
            -Metadata $entry `
            -UpstreamRepo $entry.UpstreamRepo `
            -UpstreamSha $entry.Sha

        if ($DryRun) {
            $hasChanges = Test-UpstreamCommitHasMappedChanges `
                -MirrorPath $mirrorPath -Commit $entry.Sha -Parent $parent
            if (-not $hasChanges -and $skipEmpty) {
                Write-SyncLog "[$($entry.SourceId)] skip empty diff $($entry.Sha.Substring(0, 8)) $($entry.Subject)"
            }
            else {
                Write-SyncLog "[$($entry.SourceId)] dry-run would replay $($entry.Sha.Substring(0, 8)) $($entry.Subject)"
            }
        }
        else {
            $hasChanges = Apply-UpstreamCommitToIndex `
                -MirrorPath $mirrorPath `
                -Commit $entry.Sha `
                -Parent $parent `
                -DestSubdir $entry.DestSubdir `
                -DestinationPath $destPath

            if (-not $hasChanges -and $skipEmpty) {
                Write-SyncLog "[$($entry.SourceId)] skip empty diff $($entry.Sha.Substring(0, 8)) $($entry.Subject)"
            }
            else {
                New-ReplayCommit -DestinationPath $destPath -Entry $entry -Message $message
                $replayed++
            }
        }

        if ($entry.SourceId -eq 'ports') { $lastPortsSha = $entry.Sha }
        else { $lastMingwSha = $entry.Sha }

        $replayTipSha = if ($DryRun) {
            $null
        }
        else {
            (Invoke-Git -RepoPath $destPath -GitArgs @('rev-parse', 'HEAD')).ToString().Trim()
        }

        Save-ReplayCheckpoint `
            -WorkDirectory $work `
            -Config $config `
            -DryRun:$DryRun `
            -LastPortsSha $lastPortsSha `
            -LastPortsMingwSha $lastMingwSha `
            -ReplayTipSha $replayTipSha `
            -ProcessedCount ($priorProcessed + $index)

        if ($index % 100 -eq 0) {
            Write-SyncLog "Progress: $($priorProcessed + $index) total ($index this run, $replayed replayed)"
        }
    }

    Clear-ReplayCheckpoint -WorkDirectory $work

    if ($DryRun) {
        Write-SyncLog "Dry run complete; processed $($priorProcessed + $index) queue entry(ies) ($index this run)."
        exit 0
    }

    if ($replayed -gt 0) {
        $null = Invoke-Git -RepoPath $destPath -GitArgs @('reset', '--hard', 'HEAD')
    }

    $replayTip = (Invoke-Git -RepoPath $destPath -GitArgs @('rev-parse', 'HEAD')).ToString().Trim()
    Set-DestinationBranchSha -DestinationPath $destPath -BranchName $replayBranch -Sha $replayTip

    if ($lastPortsSha) {
        Set-DestinationBranchSha -DestinationPath $destPath -BranchName $cursorPortsBranch -Sha $lastPortsSha
    }
    if ($lastMingwSha) {
        Set-DestinationBranchSha -DestinationPath $destPath -BranchName $cursorMingwBranch -Sha $lastMingwSha
    }

    Write-SyncLog "Replayed $replayed commit(s); tip=$($replayTip.Substring(0, 8))"

    Write-SyncLog 'Pushing destination branches'
    Push-DestinationBranches `
        -DestinationPath $destPath `
        -Config $config `
        -ForceReplayBranch:($Clean -or $isFullReplay)

    Write-SyncLog 'Sync-Upstream done.'
    exit 0
}
catch {
    Write-SyncLog $_.Exception.Message -Level Error
    if ($_.ScriptStackTrace) {
        Write-SyncLog $_.ScriptStackTrace -Level Error
    }
    Write-SyncLog 'Checkpoint retained; re-run with -Resume to continue.' -Level Warn
    exit 1
}
finally {
    Close-SyncLogFile
}
