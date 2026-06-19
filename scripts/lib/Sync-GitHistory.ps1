#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"

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
            AuthorDateUnix = [int64]$parts[3]
            CommitterDateUnix = [int64]$parts[6]
            AuthorName = $parts[1]
            AuthorEmail = $parts[2]
            CommitterName = $parts[4]
            CommitterEmail = $parts[5]
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
        [Parameter(Mandatory)][string] $UntilSha,
        [string] $Branch = 'master'
    )

    $range = if ($AfterSha) { "$AfterSha..$UntilSha" } else { $UntilSha }
    $format = Get-UpstreamCommitLogMetadataFormat
    $text = Invoke-GitText -RepoPath $MirrorPath -GitArgs @(
        'log', '--reverse', "--format=$format", $range
    )
    return (ConvertTo-UnixLineEndings -Text $text).Trim()
}

function Resolve-HistoryStartSha {
    param(
        [AllowNull()][string] $AfterSha
    )

    if ($AfterSha) {
        return $AfterSha
    }

    return $null
}

function Get-MirrorTipSha {
    param(
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $Branch = 'master'
    )

    return (Invoke-Git -RepoPath $MirrorPath -GitArgs @('rev-parse', $Branch)).ToString().Trim()
}

function New-ReplayCommitEntry {
    param(
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)] $LogEntry,
        [Parameter(Mandatory)] $SourceEntry
    )

    return [pscustomobject]@{
        Sha = $LogEntry.Sha
        SourceId = $SourceId
        SortKey = $SourceEntry.SortKey
        DestSubdir = $SourceEntry.DestSubdir
        UpstreamRepo = Get-SourceRepoSlug -SourceEntry $SourceEntry
        CommitterDateUnix = $LogEntry.CommitterDateUnix
        AuthorDateUnix = $LogEntry.AuthorDateUnix
        AuthorName = $LogEntry.AuthorName
        AuthorEmail = $LogEntry.AuthorEmail
        CommitterName = $LogEntry.CommitterName
        CommitterEmail = $LogEntry.CommitterEmail
        Subject = $LogEntry.Subject
        Body = $LogEntry.Body
    }
}

function Get-SourceReplayHistory {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('Ports', 'PortsMingw')]
        [string] $SourceKey,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)][string] $MirrorPath,
        [AllowNull()][string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    $sourceEntry = Get-SourceConfigEntry -Config $Config -SourceKey $SourceKey
    $cursorSha = Resolve-HistoryStartSha -AfterSha $AfterSha
    $text = Export-UpstreamCommitLogRawText `
        -MirrorPath $MirrorPath `
        -AfterSha $cursorSha `
        -UntilSha $UntilSha `
        -Branch $sourceEntry.Branch
    $logEntries = ConvertFrom-UpstreamCommitLogMetadataText -Text $text

    $entries = New-Object System.Collections.Generic.List[object]
    foreach ($logEntry in $logEntries) {
        [void]$entries.Add((New-ReplayCommitEntry `
            -SourceId $sourceEntry.SortKey `
            -LogEntry $logEntry `
            -SourceEntry $sourceEntry))
    }

    return $entries.ToArray()
}
