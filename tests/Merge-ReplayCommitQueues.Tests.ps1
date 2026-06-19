#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$repoRoot/scripts/lib/Sync-Git.ps1"

$script:Failed = 0

function Assert-Equal {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    if ($Expected -ne $Actual) {
        Write-Host "[FAIL] $Name (expected=$Expected actual=$Actual)"
        $script:Failed++
        return
    }

    Write-Host "[PASS] $Name"
}

function New-TestQueueItem {
    param(
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $Sha,
        [Parameter(Mandatory)][int64] $AuthorDate,
        [int64] $CommitterDate = 0
    )

    if ($CommitterDate -eq 0) {
        $CommitterDate = $AuthorDate
    }

    return [pscustomobject]@{
        SourceId = $SourceId
        Sha = $Sha
        SortRank = (Get-ReplaySortRank `
            -AuthorDate $AuthorDate `
            -CommitterDate $CommitterDate `
            -SortKey $SourceId `
            -Sha $Sha)
    }
}

$ports = @(
    (New-TestQueueItem -SourceId 'ports' -Sha ('a' * 40) -AuthorDate 200)
    (New-TestQueueItem -SourceId 'ports' -Sha ('b' * 40) -AuthorDate 100)
)

$mingw = @(
    (New-TestQueueItem -SourceId 'ports-mingw' -Sha ('c' * 40) -AuthorDate 150)
)

$merged = Merge-ReplayCommitQueues -Left $ports -Right $mingw
Assert-Equal -Name 'merge count' -Expected 3 -Actual $merged.Count
Assert-Equal -Name 'first sha' -Expected ('c' * 40) -Actual $merged[0].Sha
Assert-Equal -Name 'second sha' -Expected ('a' * 40) -Actual $merged[1].Sha
Assert-Equal -Name 'third sha' -Expected ('b' * 40) -Actual $merged[2].Sha

$globalSorted = @($ports + $mingw | Sort-Object -Property SortRank)
Assert-Equal -Name 'differs from global sort' -Expected 'True' -Actual ($merged[0].Sha -ne $globalSorted[0].Sha)

$committerFirst = Merge-ReplayCommitQueues -Left @(
    (New-TestQueueItem -SourceId 'ports' -Sha ('d' * 40) -AuthorDate 300 -CommitterDate 50)
) -Right @(
    (New-TestQueueItem -SourceId 'ports-mingw' -Sha ('e' * 40) -AuthorDate 100 -CommitterDate 200)
)
Assert-Equal -Name 'committer date wins merge' -Expected ('d' * 40) -Actual $committerFirst[0].Sha

if ($script:Failed -gt 0) {
    Write-Host "FAILED: $script:Failed test(s)"
    exit 1
}

Write-Host 'Merge replay queue tests passed.'
exit 0
