#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Format-GitReplayDateEnv {
    param([Parameter(Mandatory)][int64] $UnixSeconds)

    return "@$UnixSeconds"
}
