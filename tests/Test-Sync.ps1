#requires -Version 7.0
<#
.SYNOPSIS
    Run sync unit tests.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

$tests = @(
    'Parse-GitCommitObject.Tests.ps1'
    'ConvertFrom-UpstreamCommitLogMetadataText.Tests.ps1'
    'Merge-ReplayCommitQueues.Tests.ps1'
    'Format-GitReplayDateEnv.Tests.ps1'
)

foreach ($testName in $tests) {
    Write-Host "[test] Running $testName..."
    & "$repoRoot/tests/$testName"
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}

Write-Host '[test] All unit tests passed.'
exit 0
