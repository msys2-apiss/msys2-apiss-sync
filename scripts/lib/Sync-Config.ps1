#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

function Get-SyncConfig {
    param(
        [string] $RepoRoot = (Get-SyncRepoRoot),
        [string] $ConfigPath
    )

    if (-not $ConfigPath) {
        $ConfigPath = Join-Path $RepoRoot 'config/config.psd1'
    }

    if (-not (Test-Path -LiteralPath $ConfigPath)) {
        throw "Config file not found: $ConfigPath"
    }

    return Import-PowerShellDataFile -Path $ConfigPath
}

function Get-SourceRepoSlug {
    param(
        [Parameter(Mandatory)] $SourceEntry
    )
    return "$($SourceEntry.Owner)/$($SourceEntry.Repo)"
}

function Get-SourceCloneUrl {
    param(
        [Parameter(Mandatory)] $SourceEntry
    )
    return "https://github.com/$(Get-SourceRepoSlug -SourceEntry $SourceEntry).git"
}

function Get-DestinationCloneUrl {
    param(
        [Parameter(Mandatory)] $Config
    )
    if ($Config.Destination.Url) {
        return $Config.Destination.Url
    }
    return "https://github.com/$($Config.Destination.Owner)/$($Config.Destination.Repo).git"
}

function Get-MirrorCloneUrl {
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)]
        [ValidateSet('Ports', 'PortsMingw')]
        [string] $MirrorKey
    )

    $mirrorRepo = $Config.Mirrors.$MirrorKey
    return "https://github.com/$($Config.Mirrors.Owner)/$mirrorRepo.git"
}

function Get-SourceConfigEntry {
    param(
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)]
        [ValidateSet('Ports', 'PortsMingw')]
        [string] $SourceKey
    )

    return $Config.Sources.$SourceKey
}

function Get-MirrorConfigKeyForSource {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Ports', 'PortsMingw')]
        [string] $SourceKey
    )

    return $SourceKey
}
