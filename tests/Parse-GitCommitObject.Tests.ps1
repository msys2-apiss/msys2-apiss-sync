#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$repoRoot/scripts/lib/Sync-Common.ps1"

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

$normalRaw = @'
tree 1111111111111111111111111111111111111111
parent 2222222222222222222222222222222222222222
author Example User <user@example.com> 1700000000 +0000
committer Example User <user@example.com> 1700000001 +0000

subject line

body line
'@

$emptyEmailRaw = @'
tree 1111111111111111111111111111111111111111
author Mehrdad <> 1520670164 -0800
committer Mehrdad <> 1520833463 -0700

/etc/post-install and /etc/profile.d script optimizations
'@

$subjectOnlyRaw = @'
tree 1111111111111111111111111111111111111111
author Bot <bot@example.com> 1700000000 +0000
committer Bot <bot@example.com> 1700000000 +0000

only subject
'@

$normal = Parse-GitCommitObject -Raw $normalRaw
Assert-Equal -Name 'normal author name' -Expected 'Example User' -Actual $normal.AuthorName
Assert-Equal -Name 'normal author email' -Expected 'user@example.com' -Actual $normal.AuthorEmail
Assert-Equal -Name 'normal author date' -Expected 1700000000 -Actual $normal.AuthorDate
Assert-Equal -Name 'normal committer date' -Expected 1700000001 -Actual $normal.CommitterDate
Assert-Equal -Name 'normal committer name' -Expected 'Example User' -Actual $normal.CommitterName
Assert-Equal -Name 'normal committer email' -Expected 'user@example.com' -Actual $normal.CommitterEmail
Assert-Equal -Name 'normal subject' -Expected 'subject line' -Actual $normal.Subject
Assert-True -Name 'normal body' -Condition:($normal.Body.Trim() -eq 'body line')

$emptyEmail = Parse-GitCommitObject -Raw $emptyEmailRaw
Assert-Equal -Name 'empty email author name' -Expected 'Mehrdad' -Actual $emptyEmail.AuthorName
Assert-Equal -Name 'empty email author email' -Expected '' -Actual $emptyEmail.AuthorEmail
Assert-Equal -Name 'empty email author date' -Expected 1520670164 -Actual $emptyEmail.AuthorDate
Assert-Equal -Name 'empty email committer date' -Expected 1520833463 -Actual $emptyEmail.CommitterDate
Assert-Equal -Name 'empty email committer name' -Expected 'Mehrdad' -Actual $emptyEmail.CommitterName
Assert-Equal -Name 'empty email committer email' -Expected '' -Actual $emptyEmail.CommitterEmail

$subjectOnly = Parse-GitCommitObject -Raw $subjectOnlyRaw
Assert-Equal -Name 'subject-only body' -Expected '' -Actual $subjectOnly.Body

try {
    $null = Parse-GitCommitObject -Raw "tree abc`ncommitter x <x@x.com> 1 +0000`n`nmsg"
    Assert-True -Name 'missing author throws' -Condition $false
}
catch {
    Assert-True -Name 'missing author throws' -Condition $true
}

if ($script:Failed -gt 0) {
    Write-Host "Parse-GitCommitObject tests failed: $script:Failed"
    exit 1
}

Write-Host 'Parse-GitCommitObject tests passed.'
exit 0
