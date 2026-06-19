#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"

$script:EmptyTree = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

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
        return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n`n$($Metadata.Body)`n$footer"
    }
    return ConvertTo-UnixLineEndings -Text "[${SortKey}] ${subject}`n$footer"
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
        $removeArgs = @('rm', '--cached', '-r', '-f', '--ignore-unmatch', '--') + $removePaths
        $null = Invoke-Git -RepoPath $DestinationPath -GitArgs $removeArgs
    }

    return $true
}

function Test-UpstreamCommitHasMappedChanges {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)][string] $Commit,
        [Parameter(Mandatory)][string] $Parent
    )

    $diffEntries = Get-DiffTreeEntries -MirrorPath $MirrorPath -Parent $Parent -Commit $Commit
    return ($diffEntries.Count -gt 0)
}

function Format-GitReplayDateEnv {
    param([Parameter(Mandatory)][int64] $UnixSeconds)

    return "@$UnixSeconds"
}

function New-ReplayCommit {
    param(
        [Parameter(Mandatory)][string] $DestinationPath,
        [Parameter(Mandatory)] $Entry,
        [Parameter(Mandatory)][string] $Message
    )

    if ($null -eq $Entry.PSObject.Properties['AuthorDateUnix']) {
        throw 'Replay entry is missing AuthorDateUnix.'
    }

    if ($null -eq $Entry.PSObject.Properties['CommitterDateUnix']) {
        throw 'Replay entry is missing CommitterDateUnix.'
    }

    if ($null -eq $Entry.PSObject.Properties['CommitterName']) {
        throw 'Replay entry is missing CommitterName.'
    }

    if ($null -eq $Entry.PSObject.Properties['CommitterEmail']) {
        throw 'Replay entry is missing CommitterEmail.'
    }

    $authorUnix = [int64]$Entry.AuthorDateUnix
    $committerUnix = [int64]$Entry.CommitterDateUnix
    $env:GIT_AUTHOR_NAME = $Entry.AuthorName
    $env:GIT_AUTHOR_EMAIL = $Entry.AuthorEmail
    $env:GIT_AUTHOR_DATE = Format-GitReplayDateEnv -UnixSeconds $authorUnix
    $env:GIT_COMMITTER_NAME = $Entry.CommitterName
    $env:GIT_COMMITTER_EMAIL = $Entry.CommitterEmail
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
