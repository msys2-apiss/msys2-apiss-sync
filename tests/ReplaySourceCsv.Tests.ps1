#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$repoRoot/scripts/lib/Sync-Common.ps1"
. "$repoRoot/scripts/lib/Sync-LogStore.ps1"

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

$tempDir = Join-Path $env:TEMP "msys2-uwp-sync-csv-test-$PID"
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$csvPath = Join-Path $tempDir 'sample.csv'

try {
    $entries = @(
        [pscustomobject]@{
            Sha = 'a' * 40
            AuthorDate = [int64]1700000000
            CommitterDate = [int64]1700000001
            AuthorName = 'Example User'
            AuthorEmail = 'user@example.com'
            CommitterName = 'Committer'
            CommitterEmail = 'committer@example.com'
            Message = "tslib - 1,17 - new package`n`nline one`nline, two"
        }
    )

    Write-ReplaySourceLogCsv -Path $csvPath -Entries $entries
    $meta = [pscustomobject]@{
        sourceId = 'ports'
        afterSha = 'b' * 40
        untilSha = 'c' * 40
        fetchedAt = '2026-01-01T00:00:00Z'
    }
    $imported = Import-ReplaySourceLogCsv -Meta $meta -Path $csvPath

    $split = Split-CommitMessage -Message $imported.Commits[0].Message
    Assert-Equal -Name 'row count' -Expected 1 -Actual $imported.Commits.Count
    Assert-Equal -Name 'committer date' -Expected 1700000001 -Actual $imported.Commits[0].CommitterDate
    Assert-Equal -Name 'committer name' -Expected 'Committer' -Actual $imported.Commits[0].CommitterName
    Assert-Equal -Name 'git sequence' -Expected 0 -Actual $imported.Commits[0].GitSequence
    Assert-Equal -Name 'comma subject' -Expected 'tslib - 1,17 - new package' -Actual $split.Subject
    Assert-Equal -Name 'multiline body' -Expected "line one`nline, two" -Actual $split.Body

    $header = (Get-Content -LiteralPath $csvPath -TotalCount 1 -Encoding utf8)
    Assert-Equal -Name 'last column name' -Expected 'message' -Actual ($header.Split(',')[-1])

    $rowCount = @(Import-Csv -LiteralPath $csvPath -Encoding UTF8).Count
    Assert-Equal -Name 'physical row count' -Expected 1 -Actual $rowCount
}
finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:Failed -gt 0) {
    Write-Host "FAILED: $script:Failed test(s)"
    exit 1
}

Write-Host 'Replay source CSV tests passed.'
exit 0
