#requires -Version 7.0

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. "$repoRoot/scripts/lib/Sync-GitReplay.ps1"

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

Assert-Equal -Name 'author epoch' -Expected '@1700000000' -Actual (Format-GitReplayDateEnv -UnixSeconds 1700000000)
Assert-Equal -Name 'committer epoch' -Expected '@1700000001' -Actual (Format-GitReplayDateEnv -UnixSeconds 1700000001)
Assert-Equal -Name 'dates differ' -Expected 'True' -Actual ($(Format-GitReplayDateEnv -UnixSeconds 1700000000) -ne (Format-GitReplayDateEnv -UnixSeconds 1700000001))

if ($script:Failed -gt 0) {
    Write-Host "FAILED: $script:Failed test(s)"
    exit 1
}

Write-Host 'Format-GitReplayDateEnv tests passed.'
exit 0
