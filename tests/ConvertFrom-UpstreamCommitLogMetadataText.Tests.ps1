#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$repoRoot/scripts/lib/Sync-Common.ps1"
. "$repoRoot/scripts/lib/Sync-Git.ps1"

$script:Failed = 0

function Assert-True {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)][bool] $Condition
    )

    if (-not $Condition) {
        Write-Host "[FAIL] $Name"
        $script:Failed++
        return
    }

    Write-Host "[PASS] $Name"
}

function Assert-Equal {
    param(
        [Parameter(Mandatory)][string] $Name,
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    Assert-True -Name $Name -Condition:($Expected -eq $Actual)
}

$fieldSep = [char]0x1f
$recordSep = [char]0x1e

function New-LogRecord {
    param(
        [string] $Sha,
        [string] $AuthorName,
        [string] $AuthorEmail,
        [int64] $AuthorDate,
        [string] $CommitterName,
        [string] $CommitterEmail,
        [int64] $CommitterDate,
        [string] $Message
    )

    return (@(
        $Sha,
        $AuthorName,
        $AuthorEmail,
        $AuthorDate,
        $CommitterName,
        $CommitterEmail,
        $CommitterDate,
        $Message
    ) -join $fieldSep) + $recordSep
}

$normalRecord = New-LogRecord `
    -Sha ('a' * 40) `
    -AuthorName 'Example User' `
    -AuthorEmail 'user@example.com' `
    -AuthorDate 1700000000 `
    -CommitterName 'Example User' `
    -CommitterEmail 'user@example.com' `
    -CommitterDate 1700000001 `
    -Message "subject line`n`nbody line`n"

$emptyEmailRecord = New-LogRecord `
    -Sha ('b' * 40) `
    -AuthorName 'Mehrdad' `
    -AuthorEmail '' `
    -AuthorDate 1520670164 `
    -CommitterName 'Mehrdad' `
    -CommitterEmail '' `
    -CommitterDate 1520833463 `
    -Message "/etc/post-install and /etc/profile.d script optimizations`n"

$mergeRecord = New-LogRecord `
    -Sha ('c' * 40) `
    -AuthorName 'Bot' `
    -AuthorEmail 'bot@example.com' `
    -AuthorDate 1599130701 `
    -CommitterName 'GitHub' `
    -CommitterEmail 'noreply@github.com' `
    -CommitterDate 1599130701 `
    -Message "Merge pull request #2 from 3rav/3rav-patch-1`n`n3rav patch 1`n"

$entries = ConvertFrom-UpstreamCommitLogMetadataText -Text $normalRecord
Assert-Equal -Name 'record count' -Expected 1 -Actual $entries.Count
Assert-Equal -Name 'normal committer name' -Expected 'Example User' -Actual $entries[0].CommitterName
Assert-Equal -Name 'normal subject' -Expected 'subject line' -Actual $entries[0].Subject
Assert-True -Name 'normal body' -Condition:($entries[0].Body.Trim() -eq 'body line')

$entries = ConvertFrom-UpstreamCommitLogMetadataText -Text $mergeRecord
Assert-Equal -Name 'merge subject' -Expected 'Merge pull request #2 from 3rav/3rav-patch-1' -Actual $entries[0].Subject
Assert-Equal -Name 'merge body' -Expected '3rav patch 1' -Actual $entries[0].Body

$entries = ConvertFrom-UpstreamCommitLogMetadataText -Text ($normalRecord + $emptyEmailRecord)
Assert-Equal -Name 'two records' -Expected 2 -Actual $entries.Count

$empty = ConvertFrom-UpstreamCommitLogMetadataText -Text ''
Assert-Equal -Name 'empty text' -Expected 0 -Actual $empty.Count

if ($script:Failed -gt 0) {
    Write-Host "FAILED: $script:Failed test(s)"
    exit 1
}

Write-Host 'All ConvertFrom-UpstreamCommitLogMetadataText tests passed.'
exit 0
