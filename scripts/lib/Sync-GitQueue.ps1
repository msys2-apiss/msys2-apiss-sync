#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

function Compare-ReplayRank {
    param(
        [Parameter(Mandatory)] $Left,
        [Parameter(Mandatory)] $Right
    )

    if ($Left.CommitterDateUnix -ne $Right.CommitterDateUnix) {
        return [Math]::Sign($Left.CommitterDateUnix - $Right.CommitterDateUnix)
    }

    if ($Left.AuthorDateUnix -ne $Right.AuthorDateUnix) {
        return [Math]::Sign($Left.AuthorDateUnix - $Right.AuthorDateUnix)
    }

    if ($Left.SourceId -ne $Right.SourceId) {
        return [StringComparer]::Ordinal.Compare($Left.SourceId, $Right.SourceId)
    }

    return [StringComparer]::Ordinal.Compare($Left.Sha, $Right.Sha)
}

function Get-ReplaySortRank {
    param(
        [Parameter(Mandatory)][int64] $AuthorDateUnix,
        [Parameter(Mandatory)][int64] $CommitterDateUnix,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $Sha
    )

    return ('{0:D12}|{1:D12}|{2}|{3}' -f $CommitterDateUnix, $AuthorDateUnix, $SourceId, $Sha)
}

function Merge-ReplayCommitQueues {
    param(
        [Parameter(Mandatory)][object[]] $PortsList,
        [Parameter(Mandatory)][object[]] $PortsMingwList
    )

    $merged = New-Object System.Collections.Generic.List[object]
    $i = 0
    $j = 0

    while ($i -lt $PortsList.Count -and $j -lt $PortsMingwList.Count) {
        if ((Compare-ReplayRank -Left $PortsList[$i] -Right $PortsMingwList[$j]) -le 0) {
            [void]$merged.Add($PortsList[$i])
            $i++
        }
        else {
            [void]$merged.Add($PortsMingwList[$j])
            $j++
        }
    }

    while ($i -lt $PortsList.Count) {
        [void]$merged.Add($PortsList[$i])
        $i++
    }

    while ($j -lt $PortsMingwList.Count) {
        [void]$merged.Add($PortsMingwList[$j])
        $j++
    }

    return $merged.ToArray()
}

function Get-ReplayAgeCutoffUnix {
    param(
        [Parameter(Mandatory)] $Config
    )

    $minutes = $Config.Replay.MinReplayAgeMinutes
    if ($null -eq $minutes -or $minutes -lt 0) {
        $minutes = 5
    }

    return [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - ([int64]$minutes * 60)
}

function Filter-ReplayQueueByAge {
    param(
        [Parameter(Mandatory)][object[]] $Queue,
        [Parameter(Mandatory)] $Config
    )

    $minutes = $Config.Replay.MinReplayAgeMinutes
    if ($null -eq $minutes) { $minutes = 5 }

    $cutoff = Get-ReplayAgeCutoffUnix -Config $Config
    $eligible = @($Queue | Where-Object { $_.CommitterDateUnix -le $cutoff })
    $held = $Queue.Count - $eligible.Count

    if ($held -gt 0) {
        Write-SyncLog "Holding $held commit(s) with committer date within the last $minutes minute(s) to avoid timeline reorder."
    }

    return $eligible
}
