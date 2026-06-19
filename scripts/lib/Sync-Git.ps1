#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

$script:EmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

function Initialize-MirrorRepository {
    param(
        [Parameter(Mandatory)][string] $WorkDirectory,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)] $SourceEntry,
        [switch] $SkipFetch
    )

    $mirrorRoot = Join-Path $WorkDirectory 'mirrors'
    if (-not (Test-Path -LiteralPath $mirrorRoot)) {
        New-Item -ItemType Directory -Path $mirrorRoot | Out-Null
    }

    $mirrorPath = Join-Path $mirrorRoot $SourceEntry.repo
    $url = Get-SourceCloneUrl -SourceEntry $SourceEntry

    if (-not (Test-Path -LiteralPath $mirrorPath)) {
        Write-SyncLog "Cloning mirror for $SourceId ($url)"
        $null = Invoke-Git -GitArgs @('clone', '--mirror', $url, $mirrorPath)
    }
    elseif (-not $SkipFetch) {
        Write-SyncLog "Fetching mirror for $SourceId"
        $null = Invoke-Git -RepoPath $mirrorPath -GitArgs @('fetch', '--prune', 'origin')
    }

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

    $destPath = Join-Path $destRoot $Config.destination.repo
    $url = Get-DestinationCloneUrl -Config $Config

    if (-not (Test-Path -LiteralPath $destPath)) {
        Write-SyncLog "Cloning destination ($url)"
        $null = Invoke-Git -GitArgs @('clone', $url, $destPath)
    }
    elseif (-not $SkipFetch) {
        $null = Invoke-Git -RepoPath $destPath -GitArgs @('fetch', 'origin', '--prune')
    }

    return $destPath
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

function Clear-DestinationWorkspace {
    param(
        [Parameter(Mandatory)][string] $DestinationPath
    )

    try {
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', '--verify', 'HEAD')
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('reset', '--hard', 'HEAD')
    }
    catch {
        # Detached or empty repo; checkout will establish HEAD.
    }

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('clean', '-fd')
}

function Reset-DestinationBranch {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [string] $BranchName
    )

    $branch = if ($BranchName) { $BranchName } else { $Config.destination.branch }
    $base = $Config.destination.baseCommit

    Clear-DestinationWorkspace -DestinationPath $DestinationPath
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('checkout', '-f', '-B', $branch, $base)
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('reset', '--hard', 'HEAD')
}

function Checkout-DestinationBranch {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName
    )

    Clear-DestinationWorkspace -DestinationPath $DestinationPath
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('checkout', '-f', $BranchName)
    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('reset', '--hard', 'HEAD')
}

function Get-DestinationBranchTip {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName
    )

    return (Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', $BranchName)).ToString().Trim()
}

function Test-CommitExists {
    param(
        [Parameter(Mandatory)][string] $RepoPath,
        [Parameter(Mandatory)][string] $Sha
    )

    $null = Invoke-Git -RepoPath $RepoPath -GitArgs @('cat-file', '-e', "${Sha}^{commit}")
    return $true
}

function Get-FirstParent {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit
    )

    $parents = Invoke-Git -RepoPath $MirrorPath -GitArgs @('rev-list', '--parents', '-n', '1', $Commit)
    $parts = $parents.ToString().Trim() -split '\s+'
    if ($parts.Count -le 1) {
        return $script:EmptyTree
    }
    return $parts[1]
}

function Get-UpstreamCommitEntries {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Branch,
        [string] $AfterSha,
        [string] $UntilSha
    )

    $text = Export-UpstreamCommitLog -MirrorPath $MirrorPath -AfterSha $AfterSha -UntilSha $UntilSha
    return ConvertFrom-UpstreamCommitLogText -Text $text
}

function Export-UpstreamCommitLog {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    $range = if ($AfterSha) { "$AfterSha..$UntilSha" } else { $UntilSha }
    $format = '%H|%at|%ct'
    $lines = Invoke-Git -RepoPath $MirrorPath -GitArgs @(
        'log', '--reverse', "--format=$format", $range
    )

    $text = (($lines | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ }) -join "`n")
    if ($text) {
        $text += "`n"
    }
    return $text
}

function Get-UpstreamCommitLogMetadataFormat {
    # Field sep: 0x1f; record sep: 0x1e (after %B, which may contain newlines).
    return '%H%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B%x1e'
}

function Split-GitLogCommitMessage {
    param([AllowNull()][string] $Message)

    return Split-CommitMessage -Message $Message
}

function ConvertFrom-UpstreamCommitLogMetadataText {
    param(
        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string] $Text
    )

    $text = ConvertTo-UnixLineEndings -Text $Text
    $text = $text.Trim()
    if (-not $text) {
        return @()
    }

    $recordSep = [char]0x1e
    $fieldSep = [char]0x1f
    $entries = New-Object System.Collections.Generic.List[object]

    foreach ($record in $text.Split($recordSep, [StringSplitOptions]::RemoveEmptyEntries)) {
        $record = $record.Trim()
        if (-not $record) {
            continue
        }

        $parts = $record.Split($fieldSep, 8)
        if ($parts.Count -lt 8) {
            $preview = $record.Substring(0, [Math]::Min(120, $record.Length))
            throw "Invalid upstream commit log record (expected 8 fields, got $($parts.Count)): $preview"
        }

        $message = $parts[7].TrimEnd("`n")
        $split = Split-GitLogCommitMessage -Message $message
        [void]$entries.Add([pscustomobject]@{
            Sha = $parts[0]
            AuthorDate = [int64]$parts[3]
            CommitterDate = [int64]$parts[6]
            AuthorName = $parts[1]
            AuthorEmail = $parts[2]
            CommitterName = $parts[4]
            CommitterEmail = $parts[5]
            Message = $message
            Subject = $split.Subject
            Body = $split.Body
        })
    }

    return $entries.ToArray()
}

function Export-UpstreamCommitLogRawText {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    $range = if ($AfterSha) { "$AfterSha..$UntilSha" } else { $UntilSha }
    $format = Get-UpstreamCommitLogMetadataFormat
    $text = Invoke-GitText -RepoPath $MirrorPath -GitArgs @(
        'log', '--reverse', "--format=$format", $range
    )
    return (ConvertTo-UnixLineEndings -Text $text).Trim()
}

function Export-UpstreamCommitLogWithMetadata {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    return ConvertFrom-UpstreamCommitLogMetadataText -Text (
        Export-UpstreamCommitLogRawText -MirrorPath $MirrorPath -AfterSha $AfterSha -UntilSha $UntilSha
    )
}

function ConvertFrom-UpstreamCommitLogText {
    param(
        [Parameter(Mandatory)][string] $Text
    )

    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($line in ($Text -split "`n")) {
        $text = $line.Trim()
        if (-not $text) { continue }
        $parts = $text -split '\|'
        if ($parts.Count -lt 3) { continue }
        [void]$entries.Add([pscustomobject]@{
            Sha = $parts[0]
            AuthorDate = [int64]$parts[1]
            CommitterDate = [int64]$parts[2]
        })
    }

    return $entries.ToArray()
}

function Get-CommitMetadata {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit
    )

    $raw = Invoke-GitText -RepoPath $MirrorPath -GitArgs @('cat-file', '-p', $Commit)
    return Parse-GitCommitObject -Raw $raw
}

function Format-ReplayCommitMessage {
    param(
        [Parameter(Mandatory)][string] $SortKey,
        [Parameter(Mandatory)] $Metadata,
        [Parameter(Mandatory)][string] $UpstreamRepo,
        [Parameter(Mandatory)][string] $UpstreamSha
    )

    $subject = $Metadata.Subject
    $footer = "Source: ${UpstreamRepo}@${UpstreamSha}"

    if ($Metadata.Body) {
        return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n`n$($Metadata.Body)`n`n$footer"
    }
    return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n`n$footer"
}

function Get-DiffTreeEntries {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $Commit
    )

    $raw = Invoke-GitText -RepoPath $MirrorPath -GitArgs @(
        'diff-tree', '-r', '-z', '-M', '--no-commit-id', $Parent, $Commit
    )
    if (-not $raw) {
        return @()
    }

    $tokens = $raw.Split([char]0, [StringSplitOptions]::RemoveEmptyEntries)
    $entries = New-Object System.Collections.Generic.List[object]
    $i = 0

    while ($i -lt $tokens.Count) {
        $token = $tokens[$i]
        if ($token -notmatch '^:(\d+) (\d+) ([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$') {
            $i++
            continue
        }

        $oldMode = $Matches[1]
        $newMode = $Matches[2]
        $newSha = $Matches[4]
        $status = $Matches[5]
        $i++

        if ($status -match '^R') {
            if ($i + 1 -ge $tokens.Count) {
                throw "Unexpected diff-tree rename payload for commit $Commit"
            }
            [void]$entries.Add([pscustomobject]@{ Kind = 'Delete'; Path = $tokens[$i] })
            [void]$entries.Add([pscustomobject]@{
                Kind = 'Update'
                Path = $tokens[$i + 1]
                Mode = $newMode
                Sha = $newSha
            })
            $i += 2
            continue
        }

        if ($i -ge $tokens.Count) {
            throw "Unexpected diff-tree payload for commit $Commit"
        }

        $path = $tokens[$i++]
        if ($status -eq 'D' -or $newMode -eq '000000') {
            [void]$entries.Add([pscustomobject]@{ Kind = 'Delete'; Path = $path })
        }
        else {
            [void]$entries.Add([pscustomobject]@{
                Kind = 'Update'
                Path = $path
                Mode = $newMode
                Sha = $newSha
            })
        }
    }

    return [object[]]$entries
}

function Apply-UpstreamCommitToIndex {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit,
        [Parameter(Mandatory)][string] $Parent,
        [Parameter(Mandatory)][string] $DestSubdir,
        [Parameter(Mandatory)][string] $DestinationPath
    )

    $diffEntries = Get-DiffTreeEntries -MirrorPath $MirrorPath -Parent $Parent -Commit $Commit
    if ($diffEntries.Count -eq 0) {
        return $false
    }

    $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('read-tree', 'HEAD')

    $indexLines = New-Object System.Collections.Generic.List[string]
    $removePaths = New-Object System.Collections.Generic.List[string]

    foreach ($entry in $diffEntries) {
        if ($entry.Kind -eq 'Delete') {
            [void]$removePaths.Add("$DestSubdir/$($entry.Path)")
            continue
        }

        [void]$indexLines.Add("$($entry.Mode) $($entry.Sha)`t$DestSubdir/$($entry.Path)")
    }

    if ($indexLines.Count -gt 0) {
        $infoText = (($indexLines | ForEach-Object { "$_`n" }) -join '')
        $null = Invoke-GitStdin -RepoPath $DestinationPath -GitArgs @(
            'update-index', '--index-info'
        ) -InputText $infoText
    }

    if ($removePaths.Count -gt 0) {
        $removeArgs = @('rm', '--cached', '-f', '--ignore-unmatch', '--') + $removePaths
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs $removeArgs
    }

    return $true
}

function Format-GitReplayDateEnv {
    param([Parameter(Mandatory)][int64] $UnixSeconds)

    return "@$UnixSeconds"
}

function New-ReplayCommit {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $Metadata,
        [Parameter(Mandatory)][string] $Message
    )

    if ($null -eq $Metadata.PSObject.Properties['AuthorDate']) {
        throw 'Commit metadata is missing AuthorDate.'
    }

    if ($null -eq $Metadata.PSObject.Properties['CommitterDate']) {
        throw 'Commit metadata is missing CommitterDate.'
    }

    if ($null -eq $Metadata.PSObject.Properties['CommitterName']) {
        throw 'Commit metadata is missing CommitterName.'
    }

    if ($null -eq $Metadata.PSObject.Properties['CommitterEmail']) {
        throw 'Commit metadata is missing CommitterEmail.'
    }

    $authorUnix = [int64]$Metadata.AuthorDate
    $committerUnix = [int64]$Metadata.CommitterDate
    $env:GIT_AUTHOR_NAME = $Metadata.AuthorName
    $env:GIT_AUTHOR_EMAIL = $Metadata.AuthorEmail
    $env:GIT_AUTHOR_DATE = Format-GitReplayDateEnv -UnixSeconds $authorUnix
    $env:GIT_COMMITTER_NAME = $Metadata.CommitterName
    $env:GIT_COMMITTER_EMAIL = $Metadata.CommitterEmail
    $env:GIT_COMMITTER_DATE = Format-GitReplayDateEnv -UnixSeconds $committerUnix

    $messagePath = Join-Path ([System.IO.Path]::GetTempPath()) "sync-commit-$([Guid]::NewGuid().ToString('N')).txt"
    try {
        [System.IO.File]::WriteAllText($messagePath, $Message, [System.Text.UTF8Encoding]::new($false))
        $parent = (Invoke-Git -RepoPath $DestinationPath -GitArgs @('rev-parse', 'HEAD')).ToString().Trim()
        $tree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @('write-tree')).ToString().Trim()
        $newCommit = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'commit-tree', $tree, '-p', $parent, '-F', $messagePath
        )).ToString().Trim()
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs @('update-ref', 'HEAD', $newCommit, $parent)
    }
    finally {
        Remove-Item -LiteralPath $messagePath -Force -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_EMAIL -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_AUTHOR_DATE -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_NAME -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_EMAIL -ErrorAction SilentlyContinue
        Remove-Item Env:GIT_COMMITTER_DATE -ErrorAction SilentlyContinue
    }
}

function Get-TreeRootSha {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)][string] $BranchName,
        [Parameter(Mandatory)] $Config
    )

    $portsTree = 'empty'
    $mingwTree = 'empty'
    $portsSub = $Config.sources.ports.destSubdir
    $mingwSub = $Config.sources.'ports-mingw'.destSubdir

    try {
        $portsTree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'rev-parse', "${BranchName}:${portsSub}"
        )).ToString().Trim()
    }
    catch { }

    try {
        $mingwTree = (Invoke-Git -RepoPath $DestinationPath -GitArgs @(
            'rev-parse', "${BranchName}:${mingwSub}"
        )).ToString().Trim()
    }
    catch { }

    return "${portsTree}-${mingwTree}"
}

function Get-ReplayAgeCutoffUnix {
    param(
        [Parameter(Mandatory)] $Config
    )

    $minutes = $Config.replay.minReplayAgeMinutes
    if ($null -eq $minutes) {
        $minutes = $Config.pollIntervalMinutes
    }
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

    $minutes = $Config.replay.minReplayAgeMinutes
    if ($null -eq $minutes) { $minutes = $Config.pollIntervalMinutes }
    if ($null -eq $minutes) { $minutes = 5 }

    $cutoff = Get-ReplayAgeCutoffUnix -Config $Config
    $eligible = @($Queue | Where-Object { $_.CommitterDate -le $cutoff })
    $held = $Queue.Count - $eligible.Count

    if ($held -gt 0) {
        Write-SyncLog "Holding $held commit(s) with committer date within the last $minutes minute(s) to avoid timeline reorder."
    }

    return $eligible
}

function Get-ReplaySortRank {
    param(
        [Parameter(Mandatory)][int64] $AuthorDate,
        [Parameter(Mandatory)][int64] $CommitterDate,
        [Parameter(Mandatory)][string] $SortKey,
        [Parameter(Mandatory)][string] $Sha
    )

    return ('{0:D12}|{1:D12}|{2}|{3}' -f $CommitterDate, $AuthorDate, $SortKey, $Sha)
}

function New-ReplayQueueItem {
    param(
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)] $SourceEntry,
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)] $LogEntry
    )

    return [pscustomobject]@{
        SourceId = $SourceId
        SortKey = $SourceEntry.sortKey
        DestSubdir = $SourceEntry.destSubdir
        UpstreamRepo = Get-SourceRepoSlug -SourceEntry $SourceEntry
        MirrorPath = $MirrorPath
        Sha = $LogEntry.Sha
        AuthorDate = $LogEntry.AuthorDate
        CommitterDate = $LogEntry.CommitterDate
        SortRank = (Get-ReplaySortRank `
            -AuthorDate $LogEntry.AuthorDate `
            -CommitterDate $LogEntry.CommitterDate `
            -SortKey $SourceEntry.sortKey `
            -Sha $LogEntry.Sha)
    }
}

function Merge-ReplayCommitQueues {
    param(
        [Parameter(Mandatory)][object[]] $Left,
        [Parameter(Mandatory)][object[]] $Right
    )

    $merged = New-Object System.Collections.Generic.List[object]
    $i = 0
    $j = 0

    while ($i -lt $Left.Count -and $j -lt $Right.Count) {
        if ($Left[$i].SortRank -le $Right[$j].SortRank) {
            [void]$merged.Add($Left[$i])
            $i++
        }
        else {
            [void]$merged.Add($Right[$j])
            $j++
        }
    }

    while ($i -lt $Left.Count) {
        [void]$merged.Add($Left[$i])
        $i++
    }

    while ($j -lt $Right.Count) {
        [void]$merged.Add($Right[$j])
        $j++
    }

    return $merged.ToArray()
}

function Sort-ReplayCommitQueue {
    param(
        [Parameter(Mandatory)][object[]] $Queue
    )

    return @($Queue | Sort-Object -Property SortRank)
}
