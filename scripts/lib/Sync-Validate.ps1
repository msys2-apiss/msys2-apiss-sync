#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"
. "$PSScriptRoot/Sync-Git.ps1"
. "$PSScriptRoot/Sync-LogStore.ps1"

function Test-ReplayQueueEntry {
    param(
        [Parameter(Mandatory)] $Item
    )

    if ($Item.Metadata.AuthorDate -ne $Item.AuthorDate) {
        throw "Author date mismatch: queue=$($Item.AuthorDate) metadata=$($Item.Metadata.AuthorDate)."
    }

    if ($Item.Metadata.CommitterDate -ne $Item.CommitterDate) {
        throw "Committer date mismatch: queue=$($Item.CommitterDate) metadata=$($Item.Metadata.CommitterDate)."
    }

    if ([string]::IsNullOrWhiteSpace($Item.Metadata.Subject)) {
        throw 'Commit subject is empty.'
    }

    $expected = Format-ReplayCommitMessage `
        -SortKey $Item.SortKey `
        -Metadata $Item.Metadata `
        -UpstreamRepo $Item.UpstreamRepo `
        -UpstreamSha $Item.Sha

    if ($Item.ReplayMessage -ne $expected) {
        throw 'Replay message does not match normalized template.'
    }
}

function Test-ReplayQueueFromJson {
    param(
        [Parameter(Mandatory)][string] $QueuePath,
        [Parameter(Mandatory)] $Mirrors,
        [int] $MaxCommits = 0,
        [int] $ProgressInterval = 5000
    )

    if (-not (Test-Path -LiteralPath $QueuePath)) {
        throw "Missing $QueuePath (run Sort-ReplayQueue.ps1 first)"
    }

    Write-SyncLog "Step 3/4: load replay-queue.json"
    $imported = Import-ReplayQueueJson -Path $QueuePath -Mirrors $Mirrors
    $queue = @($imported.Commits)

    if ($MaxCommits -gt 0 -and $queue.Count -gt $MaxCommits) {
        $queue = $queue[0..($MaxCommits - 1)]
    }

    if ($queue.Count -eq 0) {
        Write-SyncLog 'Metadata validation: queue empty.'
        return 0
    }

    Write-SyncLog "Validating $($queue.Count) commit(s) (no git)"

    $index = 0
    foreach ($item in $queue) {
        $index++
        try {
            Test-ReplayQueueEntry -Item $item
        }
        catch {
            throw "[$($item.SortKey)] metadata validation failed for $($item.Sha): $($_.Exception.Message)"
        }

        if ($ProgressInterval -gt 0 -and $index % $ProgressInterval -eq 0) {
            Write-SyncLog "Metadata validation: $index / $($queue.Count)"
        }
    }

    Write-SyncLog "Metadata validation passed for $($queue.Count) commit(s)."
    return $queue.Count
}

function Build-ReplayCommitQueue {
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)] $Mirrors,
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
        [string] $Mode,
        [switch] $Force,
        [int] $MaxCommits = 0,
        [switch] $RefreshLogs
    )

    $upstreamTips = @{}
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $mirrorPath = $Mirrors[$prop.Name]
        $branchRef = "refs/heads/$($prop.Value.branch)"
        $upstreamTips[$prop.Name] = (Invoke-Git -RepoPath $mirrorPath -GitArgs @(
            'rev-parse', $branchRef
        )).ToString().Trim()
    }

    $queuePath = Get-ReplayQueueJsonPath -RepoRoot $RepoRoot
    if ($RefreshLogs) {
        $sourceLogs = Export-ReplaySourceLogs `
            -RepoRoot $RepoRoot `
            -Config $Config `
            -State $State `
            -Mirrors $Mirrors `
            -Mode $Mode `
            -Refresh
        $queue = @(Export-ReplayQueueJson `
            -RepoRoot $RepoRoot `
            -Config $Config `
            -Mirrors $Mirrors `
            -SourceLogs $sourceLogs `
            -Refresh)
    }
    elseif (-not (Test-Path -LiteralPath $queuePath)) {
        throw "Missing $queuePath (run Export-ReplayLogs.ps1 then Sort-ReplayQueue.ps1 first)"
    }
    else {
        Write-SyncLog "Step 4/4: load replay-queue.json"
        $imported = Import-ReplayQueueJson -Path $queuePath -Mirrors $Mirrors
        $queue = @($imported.Commits)
    }

    $skippedNoChanges = $false
    if ($Mode -eq 'Incremental' -and -not $Force) {
        $currentTips = Get-AllUpstreamTips -Config $Config
        if (-not (Test-UpstreamChanged -State $State -CurrentTips $currentTips) -and $queue.Count -eq 0) {
            $skippedNoChanges = $true
        }
    }

    if ($Mode -eq 'Incremental') {
        $beforeAge = $queue.Count
        $queue = @(Filter-ReplayQueueByAge -Queue $queue -Config $Config)
        if ($beforeAge -gt 0 -and $queue.Count -eq 0) {
            Write-SyncLog 'Pending upstream commits exist but all are within the replay age window; waiting.'
        }
    }

    if ($MaxCommits -gt 0 -and $queue.Count -gt $MaxCommits) {
        $queue = $queue[0..($MaxCommits - 1)]
    }

    return [pscustomobject]@{
        Queue = $queue
        UpstreamTips = $upstreamTips
        SkippedNoChanges = $skippedNoChanges
    }
}

function Invoke-ReplayMetadataPreflight {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [string] $QueuePath,
        [int] $MaxCommits = 0
    )

    $config = Get-SyncConfig -RepoRoot $RepoRoot
    $workDirectory = Get-WorkDirectory -RepoRoot $RepoRoot
    $path = if ($QueuePath) { $QueuePath } else { Get-ReplayQueueJsonPath -RepoRoot $RepoRoot }

    $mirrors = @{}
    foreach ($prop in $config.sources.PSObject.Properties) {
        $mirrors[$prop.Name] = Join-Path $workDirectory "mirrors/$($prop.Value.repo)"
    }

    $validated = Test-ReplayQueueFromJson `
        -QueuePath $path `
        -Mirrors $mirrors `
        -MaxCommits $MaxCommits

    return [pscustomobject]@{
        QueueCount = $validated
        Skipped = $false
    }
}
