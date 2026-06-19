#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

function Initialize-MirrorRepository {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)]
        [ValidateSet('Ports', 'PortsMingw')]
        [string] $SourceKey,
        [Parameter(Mandatory)] $Config,
        [switch] $SkipFetch
    )

    $sourceEntry = Get-SourceConfigEntry -Config $Config -SourceKey $SourceKey
    $mirrorKey = Get-MirrorConfigKeyForSource -SourceKey $SourceKey
    $mirrorRoot = Join-Path $WorkDirectory 'mirrors'
    if (-not (Test-Path -LiteralPath $mirrorRoot)) {
        New-Item -ItemType Directory -Path $mirrorRoot | Out-Null
    }

    $mirrorPath = Join-Path $mirrorRoot $sourceEntry.Repo
    $url = Get-MirrorCloneUrl -Config $Config -MirrorKey $mirrorKey

    if (-not (Test-Path -LiteralPath $mirrorPath)) {
        Write-SyncLog "Cloning mirror for $SourceKey ($url)"
        $null = Invoke-Git -GitArgs @('clone', '--mirror', $url, $mirrorPath)
        Set-GitRepoUtf8Encoding -RepoPath $mirrorPath
    }
    elseif (-not $SkipFetch) {
        Write-SyncLog "Fetching mirror for $SourceKey"
        $null = Invoke-Git -RepoPath $mirrorPath -GitArgs @('fetch', '--prune', 'origin')
    }

    Set-GitRepoUtf8Encoding -RepoPath $mirrorPath
    return $mirrorPath
}

function Initialize-DestinationRepository {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)] $Config,
        [string] $DestinationPath,
        [switch] $SkipFetch
    )

    if ($DestinationPath) {
        return (Resolve-Path -LiteralPath $DestinationPath).Path
    }

    $destRoot = Join-Path $WorkDirectory 'destination'
    if (-not (Test-Path -LiteralPath $destRoot)) {
        New-Item -ItemType Directory -Path $destRoot | Out-Null
    }

    $destPath = Join-Path $destRoot $Config.Destination.Repo
    $url = Get-DestinationCloneUrl -Config $Config

    if (-not (Test-Path -LiteralPath $destPath)) {
        Write-SyncLog "Cloning destination ($url)"
        $null = Invoke-Git -GitArgs @('clone', $url, $destPath)
        Set-GitRepoUtf8Encoding -RepoPath $destPath
    }
    elseif (-not $SkipFetch) {
        $null = Invoke-Git -RepoPath $destPath -GitArgs @('fetch', 'origin', '--prune')
    }

    Set-GitRepoUtf8Encoding -RepoPath $destPath
    return $destPath
}

function Set-GitRepoUtf8Encoding {
    param(
        [Parameter(Mandatory)][string] $RepoPath
    )

    foreach ($entry in @(
            ,@('i18n.logOutputEncoding', 'utf-8')
            ,@('i18n.commitEncoding', 'utf-8')
            ,@('core.quotepath', 'false')
        )) {
        $null = Invoke-Git -RepoPath $RepoPath -GitArgs @('config', $entry[0], $entry[1])
    }
}

function Initialize-DestinationAlternates {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string[]] $MirrorPaths
    )

    $alternatesDir = Join-Path $DestinationPath '.git/objects/info'
    if (-not (Test-Path -LiteralPath $alternatesDir)) {
        New-Item -ItemType Directory -Path $alternatesDir -Force | Out-Null
    }

    $normalized = foreach ($mirrorPath in $MirrorPaths) {
        $objectsPath = Join-Path (Resolve-Path -LiteralPath $mirrorPath).Path 'objects'
        if (Test-Path -LiteralPath $objectsPath) {
            ($objectsPath -replace '\\', '/')
        }
    }

    $alternatesFile = Join-Path $alternatesDir 'alternates'
    $text = (($normalized | Where-Object { $_ }) -join "`n") + "`n"
    [System.IO.File]::WriteAllText($alternatesFile, $text, [System.Text.UTF8Encoding]::new($false))
}

function Ensure-DestinationBaseCommit {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config
    )

    $base = $Config.Destination.BaseCommit
    try {
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('cat-file', '-e', "${base}^{commit}")
        return
    }
    catch {
        Write-SyncLog "Base commit not in clone; fetching from origin" -Level Warn
    }

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('fetch', 'origin', $base)
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('cat-file', '-e', "${base}^{commit}")
}

function Set-DestinationReplayCheckout {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][bool] $IsFullReplay
    )

    $replayBranch = $Config.Destination.Branches.Replay
    if ($IsFullReplay) {
        $base = $Config.Destination.BaseCommit
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'checkout', '-B', $replayBranch, $base
        )
        return
    }

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('checkout', $replayBranch)
}

function Add-SourceRemotesToDestination {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][hashtable] $MirrorPaths,
        [switch] $SkipFetch
    )

    foreach ($sourceKey in @('Ports', 'PortsMingw')) {
        $sourceEntry = Get-SourceConfigEntry -Config $Config -SourceKey $sourceKey
        $remoteName = $sourceEntry.SortKey
        $mirrorPath = $MirrorPaths[$sourceKey]

        $remotes = @(Invoke-Git -RepoPath $DestinationPath -GitArgs @('remote') | ForEach-Object { $_.ToString().Trim() })
        if ($remotes -notcontains $remoteName) {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @(
                'remote', 'add', $remoteName, (Resolve-Path -LiteralPath $mirrorPath).Path
            )
        }

        if (-not $SkipFetch) {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('fetch', $remoteName, '--prune')
        }
    }
}

function Get-DestinationBranchSha {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName
    )

    try {
        return (Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', $BranchName)).ToString().Trim()
    }
    catch {
        return $null
    }
}

function Test-AllSyncBranchesExist {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config
    )

    foreach ($branchName in @(
            $Config.Destination.Branches.Replay
            $Config.Destination.Branches.CursorPorts
            $Config.Destination.Branches.CursorPortsMingw
        )) {
        if (-not (Get-DestinationBranchSha -DestinationPath $DestinationPath -BranchName $branchName)) {
            return $false
        }
    }

    return $true
}

function Set-DestinationBranchSha {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName,
        [Parameter(Mandatory)][string] $Sha
    )

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('branch', '-f', $BranchName, $Sha)
}

function Clear-DestinationSyncBranches {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config
    )

    $base = $Config.Destination.BaseCommit
    $replayBranch = $Config.Destination.Branches.Replay
    $cursorBranches = @(
        $Config.Destination.Branches.CursorPorts
        $Config.Destination.Branches.CursorPortsMingw
    )

    try {
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('cat-file', '-e', "${base}^{commit}")
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('branch', '-f', $replayBranch, $base)
    }
    catch {
        Write-SyncLog "Base commit not in clone; deleting replay branch $replayBranch" -Level Warn
        try {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('branch', '-D', $replayBranch)
        }
        catch {
            # Branch may not exist.
        }
    }

    foreach ($branchName in $cursorBranches) {
        try {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('branch', '-D', $branchName)
        }
        catch {
            # Branch may not exist.
        }
    }
}

function Push-DestinationBranches {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [switch] $ForceReplayBranch
    )

    $replayBranch = $Config.Destination.Branches.Replay
    $cursorBranches = @(
        $Config.Destination.Branches.CursorPorts
        $Config.Destination.Branches.CursorPortsMingw
    )

    $pushArgs = @('push', 'origin')
    if ($ForceReplayBranch) {
        $pushArgs += '--force'
    }
    $pushArgs += $replayBranch
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs $pushArgs

    foreach ($branchName in $cursorBranches) {
        $sha = Get-DestinationBranchSha -DestinationPath $DestinationPath -BranchName $branchName
        if ($sha) {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('push', 'origin', $branchName)
        }
        else {
            $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @(
                'push', 'origin', '--delete', $branchName
            )
        }
    }
}
