#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

function Get-SyncStatePath {
    param([Parameter(Mandatory)][string] $RepoRoot)
    return Join-Path $RepoRoot '.sync/state.json'
}

function New-EmptyManifest {
    param(
        [Parameter(Mandatory)] $Config
    )

    return [ordered]@{
        replaySpecVersion = $Config.replaySpecVersion
        upstreamPins = [ordered]@{
            ports = $null
            'ports-mingw' = $null
        }
        commitCount = 0
        destinationTipSha = $null
        treeRootSha = $null
    }
}

function Import-LegacyReplayManifest {
    param(
        [Parameter(Mandatory)][string] $RepoRoot
    )

    $legacyPath = Join-Path $RepoRoot '.sync/replay-manifest.json'
    if (-not (Test-Path -LiteralPath $legacyPath)) {
        return $null
    }

    $json = Get-Content -LiteralPath $legacyPath -Raw -Encoding UTF8
    return ($json | ConvertFrom-Json -Depth 20)
}

function Repair-SyncState {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)] $Config,
        [string] $RepoRoot
    )

    if (-not $State.manifest) {
        $legacy = if ($RepoRoot) { Import-LegacyReplayManifest -RepoRoot $RepoRoot } else { $null }
        if ($legacy) {
            $State | Add-Member -NotePropertyName manifest -NotePropertyValue ([ordered]@{
                replaySpecVersion = $legacy.replaySpecVersion
                upstreamPins = [ordered]@{
                    ports = $legacy.upstreamPins.ports
                    'ports-mingw' = $legacy.upstreamPins.'ports-mingw'
                }
                commitCount = $legacy.commitCount
                destinationTipSha = $legacy.destinationTipSha
                treeRootSha = $legacy.treeRootSha
            }) -Force
        }
        else {
            $State | Add-Member -NotePropertyName manifest -NotePropertyValue (New-EmptyManifest -Config $Config) -Force
        }
    }

    if ($State.PSObject.Properties.Name -contains 'destinationBranchTip') {
        if ($State.destinationBranchTip -and -not $State.manifest.destinationTipSha) {
            $State.manifest.destinationTipSha = $State.destinationBranchTip
        }
        $State.PSObject.Properties.Remove('destinationBranchTip')
    }

    if ($State.PSObject.Properties.Name -contains 'replayManifestSha') {
        $State.PSObject.Properties.Remove('replayManifestSha')
    }

    if ($State.version -lt 2) {
        $State.version = 2
    }

    return $State
}

function Get-SyncState {
    param(
        [Parameter(Mandatory)][string] $RepoRoot
    )

    $path = Get-SyncStatePath -RepoRoot $RepoRoot
    if (-not (Test-Path -LiteralPath $path)) {
        throw "State file not found: $path"
    }

    $config = Get-SyncConfig -RepoRoot $RepoRoot
    $json = Get-Content -LiteralPath $path -Raw -Encoding UTF8
    $state = $json | ConvertFrom-Json -Depth 20
    return (Repair-SyncState -State $state -Config $config -RepoRoot $RepoRoot)
}

function Save-SyncState {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $State
    )

    $path = Get-SyncStatePath -RepoRoot $RepoRoot
    $json = $State | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($path, "$json`n", [System.Text.UTF8Encoding]::new($false))
}

function Initialize-SyncStateFromConfig {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Config
    )

    $sources = @{}
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $id = $prop.Name
        $entry = $prop.Value
        $sources[$id] = [ordered]@{
            repo = Get-SourceRepoSlug -SourceEntry $entry
            branch = $entry.branch
            lastReplayedSha = $null
        }
    }

    return [pscustomobject]@{
        version = 2
        destination = [ordered]@{
            branch = $Config.destination.branch
            baseCommit = $Config.destination.baseCommit
        }
        sources = $sources
        lastSyncAt = $null
        lastUpstreamCheck = [ordered]@{
            ports = $null
            'ports-mingw' = $null
        }
        manifest = New-EmptyManifest -Config $Config
    }
}

function Update-LastUpstreamCheck {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][hashtable] $Tips
    )

    foreach ($key in $Tips.Keys) {
        $State.lastUpstreamCheck.$key = $Tips[$key]
        $State.manifest.upstreamPins.$key = $Tips[$key]
    }
}

function Set-SourceCursor {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $Sha
    )
    $State.sources.$SourceId.lastReplayedSha = $Sha
}

function Get-SourceCursor {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)][string] $SourceId
    )
    return $State.sources.$SourceId.lastReplayedSha
}

function New-ReplayManifestSnapshot {
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][hashtable] $UpstreamPins,
        [Parameter(Mandatory)][int] $CommitCount,
        [Parameter(Mandatory)][string] $DestinationTipSha,
        [Parameter(Mandatory)][string] $TreeRootSha
    )

    return [ordered]@{
        replaySpecVersion = $Config.replaySpecVersion
        upstreamPins = [ordered]@{
            ports = $UpstreamPins.ports
            'ports-mingw' = $UpstreamPins['ports-mingw']
        }
        commitCount = $CommitCount
        destinationTipSha = $DestinationTipSha
        treeRootSha = $TreeRootSha
    }
}

function Update-StateManifest {
    param(
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)] $Manifest
    )

    $State.manifest = $Manifest
}

function Compare-ReplayManifest {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    $fields = @(
        'replaySpecVersion',
        'commitCount',
        'destinationTipSha',
        'treeRootSha'
    )

    foreach ($field in $fields) {
        if ("$($Expected.$field)" -ne "$($Actual.$field)") {
            return [pscustomobject]@{
                Match = $false
                Field = $field
                Expected = $Expected.$field
                Actual = $Actual.$field
            }
        }
    }

    foreach ($sourceId in @('ports', 'ports-mingw')) {
        $e = $Expected.upstreamPins.$sourceId
        $a = $Actual.upstreamPins.$sourceId
        if ("$e" -ne "$a") {
            return [pscustomobject]@{
                Match = $false
                Field = "upstreamPins.$sourceId"
                Expected = $e
                Actual = $a
            }
        }
    }

    return [pscustomobject]@{ Match = $true }
}
