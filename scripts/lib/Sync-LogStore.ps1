#requires -Version 7.0

. "$PSScriptRoot/Sync-Common.ps1"
. "$PSScriptRoot/Sync-Config.ps1"
. "$PSScriptRoot/Sync-State.ps1"
. "$PSScriptRoot/Sync-Git.ps1"

$script:ReplaySourceLogVersion = 5
$script:ReplaySourceLogLegacyJsonVersion = 2
$script:ReplayQueueVersion = 4
$script:Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$script:ReplaySourceLogCsvHeader = 'committerDate,authorDate,sha,authorName,authorEmail,committerName,committerEmail,message'

function Get-ReplayLogStoreDirectory {
    param([Parameter(Mandatory)][string] $RepoRoot)

    $dir = Join-Path (Get-WorkDirectory -RepoRoot $RepoRoot) 'cache/replay-log'
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Get-ReplaySourceLogCsvPath {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId
    )

    return Join-Path (Get-ReplayLogStoreDirectory -RepoRoot $RepoRoot) "$SourceId.csv"
}

function Get-ReplaySourceLogMetaPath {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId
    )

    return Join-Path (Get-ReplayLogStoreDirectory -RepoRoot $RepoRoot) "$SourceId.meta.json"
}

function Get-ReplaySourceLogJsonPath {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId
    )

    return Join-Path (Get-ReplayLogStoreDirectory -RepoRoot $RepoRoot) "$SourceId.json"
}

function Get-ReplayQueueJsonPath {
    param([Parameter(Mandatory)][string] $RepoRoot)

    return Join-Path (Get-ReplayLogStoreDirectory -RepoRoot $RepoRoot) 'replay-queue.json'
}

function New-StoredCommitEntry {
    param(
        [Parameter(Mandatory)][string] $Sha,
        [Parameter(Mandatory)][int64] $AuthorDate,
        [Parameter(Mandatory)][int64] $CommitterDate,
        [Parameter(Mandatory)] $Metadata,
        [int] $GitSequence = 0
    )

    $message = if ($null -ne $Metadata.PSObject.Properties['Message'] -and $Metadata.Message) {
        $Metadata.Message.ToString()
    }
    elseif ($Metadata.Subject) {
        $subject = $Metadata.Subject.ToString()
        if ($Metadata.Body) {
            "$subject`n`n$($Metadata.Body)"
        }
        else {
            $subject
        }
    }
    else {
        ''
    }

    return [pscustomobject]@{
        Sha = $Sha
        AuthorDate = $AuthorDate
        CommitterDate = $CommitterDate
        AuthorName = $Metadata.AuthorName
        AuthorEmail = $Metadata.AuthorEmail
        CommitterName = $Metadata.CommitterName
        CommitterEmail = $Metadata.CommitterEmail
        Message = $message
        GitSequence = $GitSequence
    }
}

function Test-ReplaySourceLogMeta {
    param(
        [Parameter(Mandatory)] $Meta,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    if ([int]$Meta.version -ne $script:ReplaySourceLogVersion) {
        return $false
    }

    $expectedAfter = if ($AfterSha) { $AfterSha } else { '' }
    $actualAfter = if ($Meta.afterSha) { $Meta.afterSha.ToString() } else { '' }
    if ($Meta.untilSha -ne $UntilSha -or $actualAfter -ne $expectedAfter) {
        return $false
    }

    return [int]$Meta.commitCount -gt 0
}

function Test-ReplaySourceLogCache {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    $metaPath = Get-ReplaySourceLogMetaPath -RepoRoot $RepoRoot -SourceId $SourceId
    $csvPath = Get-ReplaySourceLogCsvPath -RepoRoot $RepoRoot -SourceId $SourceId
    if (-not ((Test-Path -LiteralPath $metaPath) -and (Test-Path -LiteralPath $csvPath))) {
        return Test-ReplaySourceLogJson -Path (Get-ReplaySourceLogJsonPath -RepoRoot $RepoRoot -SourceId $SourceId) -AfterSha $AfterSha -UntilSha $UntilSha
    }

    try {
        $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding utf8 | ConvertFrom-Json
        return Test-ReplaySourceLogMeta -Meta $meta -AfterSha $AfterSha -UntilSha $UntilSha
    }
    catch {
        return $false
    }
}

function Test-ReplaySourceLogJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    try {
        $head = (Get-Content -LiteralPath $Path -TotalCount 1 -Encoding utf8)
        if ($head -notmatch '"version":2') {
            return $false
        }
        if ($head -notmatch '"untilSha":"([0-9a-f]{40})"') {
            return $false
        }
        if ($Matches[1] -ne $UntilSha) {
            return $false
        }
        $expectedAfter = if ($AfterSha) { $AfterSha } else { 'null' }
        if ($AfterSha) {
            return $head -match ('"afterSha":"' + [regex]::Escape($AfterSha) + '"')
        }
        return $head -match '"afterSha":null'
    }
    catch {
        return $false
    }
}

function Import-ReplaySourceLogJson {
    param(
        [Parameter(Mandatory)][string] $Path
    )

    $doc = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    $commits = @()
    $seq = 0
    foreach ($entry in $doc.commits) {
        $subject = ConvertFrom-Base64Utf8 -Encoded $entry.subjectB64.ToString()
        $body = ConvertFrom-Base64Utf8 -Encoded $(if ($entry.bodyB64) { $entry.bodyB64.ToString() } else { '' })
        $message = if ($body) { "$subject`n`n$body" } else { $subject }
        $authorName = ConvertFrom-Base64Utf8 -Encoded $entry.authorNameB64.ToString()
        $authorEmail = ConvertFrom-Base64Utf8 -Encoded $entry.authorEmailB64.ToString()
        $commits += [pscustomobject]@{
            Sha = $entry.sha.ToString()
            AuthorDate = [int64]$entry.authorDate
            CommitterDate = [int64]$entry.committerDate
            AuthorName = $authorName
            AuthorEmail = $authorEmail
            CommitterName = $authorName
            CommitterEmail = $authorEmail
            Message = $message
            GitSequence = $seq
        }
        $seq++
    }

    return [pscustomobject]@{
        SourceId = $doc.sourceId.ToString()
        AfterSha = if ($doc.afterSha) { $doc.afterSha.ToString() } else { $null }
        UntilSha = $doc.untilSha.ToString()
        FetchedAt = $doc.fetchedAt.ToString()
        Commits = $commits
    }
}

function Write-ReplaySourceLogMeta {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $SourceId,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha,
        [Parameter(Mandatory)][string] $FetchedAt,
        [Parameter(Mandatory)][int] $CommitCount
    )

    $writer = [System.IO.StreamWriter]::new($Path, $false, $script:Utf8NoBom)
    try {
        $writer.Write('{"version":')
        $writer.Write($script:ReplaySourceLogVersion)
        $writer.Write(',"format":"csv","sourceId":')
        Write-JsonString -Writer $writer -Value $SourceId
        $writer.Write(',"afterSha":')
        if ($AfterSha) {
            Write-JsonString -Writer $writer -Value $AfterSha
        }
        else {
            $writer.Write('null')
        }
        $writer.Write(',"untilSha":')
        Write-JsonString -Writer $writer -Value $UntilSha
        $writer.Write(',"fetchedAt":')
        Write-JsonString -Writer $writer -Value $FetchedAt
        $writer.Write(',"commitCount":')
        $writer.Write($CommitCount)
        $writer.Write('}')
    }
    finally {
        $writer.Close()
    }
}

function Write-ReplaySourceLogCsv {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][object[]] $Entries
    )

    $writer = [System.IO.StreamWriter]::new($Path, $false, $script:Utf8NoBom)
    try {
        $writer.WriteLine($script:ReplaySourceLogCsvHeader)
        foreach ($entry in $Entries) {
            $line = @(
                $entry.CommitterDate
                $entry.AuthorDate
                (Format-CsvQuotedField -Value $entry.Sha)
                (Format-CsvQuotedField -Value $entry.AuthorName)
                (Format-CsvQuotedField -Value $entry.AuthorEmail)
                (Format-CsvQuotedField -Value $entry.CommitterName)
                (Format-CsvQuotedField -Value $entry.CommitterEmail)
                (Format-CsvQuotedField -Value $entry.Message)
            ) -join ','
            $writer.WriteLine($line)
        }
    }
    finally {
        $writer.Close()
    }
}

function Import-ReplaySourceLogCsv {
    param(
        [Parameter(Mandatory)] $Meta,
        [Parameter(Mandatory)][string] $Path
    )

    $header = (Get-Content -LiteralPath $Path -TotalCount 1 -Encoding utf8)
    $hasMessageColumn = $header -match '(^|,)message($|,)'

    $commits = @()
    $seq = 0
    foreach ($row in (Import-Csv -LiteralPath $Path -Encoding UTF8)) {
        $message = if ($hasMessageColumn) {
            if ($row.message) { $row.message.ToString() } else { '' }
        }
        else {
            $subject = if ($row.subject) { $row.subject.ToString() } else { '' }
            if ($row.body) {
                "$subject`n`n$($row.body.ToString())"
            }
            else {
                $subject
            }
        }

        $commits += [pscustomobject]@{
            Sha = $row.sha.ToString()
            AuthorDate = [int64]$row.authorDate
            CommitterDate = [int64]$row.committerDate
            AuthorName = $row.authorName.ToString()
            AuthorEmail = $row.authorEmail.ToString()
            CommitterName = $row.committerName.ToString()
            CommitterEmail = $row.committerEmail.ToString()
            Message = $message
            GitSequence = $seq
        }
        $seq++
    }

    return [pscustomobject]@{
        SourceId = $Meta.sourceId.ToString()
        AfterSha = if ($Meta.afterSha) { $Meta.afterSha.ToString() } else { $null }
        UntilSha = $Meta.untilSha.ToString()
        FetchedAt = $Meta.fetchedAt.ToString()
        CommitCount = $commits.Count
        Commits = $commits
    }
}

function New-ReplaySourceLogStub {
    param(
        [Parameter(Mandatory)][string] $SourceId,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha,
        [Parameter(Mandatory)][string] $FetchedAt,
        [Parameter(Mandatory)][int] $CommitCount
    )

    return [pscustomobject]@{
        SourceId = $SourceId
        AfterSha = $AfterSha
        UntilSha = $UntilSha
        FetchedAt = $FetchedAt
        CommitCount = $CommitCount
        Commits = $null
    }
}

function Write-ReplaySourceLogJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $SourceId,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha,
        [Parameter(Mandatory)][string] $FetchedAt,
        [Parameter(Mandatory)][object[]] $Entries
    )

    $writer = [System.IO.StreamWriter]::new($Path, $false, $script:Utf8NoBom)
    try {
        $writer.Write('{"version":')
        $writer.Write($script:ReplaySourceLogLegacyJsonVersion)
        $writer.Write(',"sourceId":')
        Write-JsonString -Writer $writer -Value $SourceId
        $writer.Write(',"afterSha":')
        if ($AfterSha) {
            Write-JsonString -Writer $writer -Value $AfterSha
        }
        else {
            $writer.Write('null')
        }
        $writer.Write(',"untilSha":')
        Write-JsonString -Writer $writer -Value $UntilSha
        $writer.Write(',"fetchedAt":')
        Write-JsonString -Writer $writer -Value $FetchedAt
        $writer.Write(',"commits":[')

        $first = $true
        foreach ($entry in $Entries) {
            if (-not $first) {
                $writer.Write(',')
            }
            $first = $false
            $writer.Write('{"sha":')
            Write-JsonString -Writer $writer -Value $entry.Sha
            $writer.Write(',"authorDate":')
            $writer.Write($entry.AuthorDate)
            $writer.Write(',"committerDate":')
            $writer.Write($entry.CommitterDate)
            $writer.Write(',"authorNameB64":')
            Write-JsonString -Writer $writer -Value (ConvertTo-Base64Utf8 -Text $entry.AuthorName)
            $writer.Write(',"authorEmailB64":')
            Write-JsonString -Writer $writer -Value (ConvertTo-Base64Utf8 -Text $entry.AuthorEmail)
            $writer.Write(',"subjectB64":')
            Write-JsonString -Writer $writer -Value (ConvertTo-Base64Utf8 -Text $entry.Subject)
            $writer.Write(',"bodyB64":')
            Write-JsonString -Writer $writer -Value (ConvertTo-Base64Utf8 -Text $entry.Body)
            $writer.Write('}')
        }

        $writer.Write(']}')
    }
    finally {
        $writer.Close()
    }
}

function Export-ReplaySourceLogCsv {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha,
        [switch] $Refresh
    )

    $csvPath = Get-ReplaySourceLogCsvPath -RepoRoot $RepoRoot -SourceId $SourceId
    $metaPath = Get-ReplaySourceLogMetaPath -RepoRoot $RepoRoot -SourceId $SourceId
    $legacyJsonPath = Get-ReplaySourceLogJsonPath -RepoRoot $RepoRoot -SourceId $SourceId

    if (-not $Refresh -and (Test-ReplaySourceLogCache -RepoRoot $RepoRoot -SourceId $SourceId -AfterSha $AfterSha -UntilSha $UntilSha)) {
        $metaPath = Get-ReplaySourceLogMetaPath -RepoRoot $RepoRoot -SourceId $SourceId
        if (Test-Path -LiteralPath $metaPath) {
            $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding utf8 | ConvertFrom-Json
            if ([int]$meta.version -eq $script:ReplaySourceLogVersion) {
                Write-SyncLog "  $SourceId -> $csvPath ($($meta.commitCount) commits, cached)"
                return New-ReplaySourceLogStub `
                    -SourceId $SourceId `
                    -AfterSha $AfterSha `
                    -UntilSha $UntilSha `
                    -FetchedAt $meta.fetchedAt.ToString() `
                    -CommitCount [int]$meta.commitCount
            }
        }
        $existing = Import-ReplaySourceLogJson -Path $legacyJsonPath
        Write-SyncLog "  $SourceId -> $legacyJsonPath ($($existing.Commits.Count) commits, cached)"
        return $existing
    }

    Write-SyncLog "  $SourceId -> git log..."
    $entries = @()
    $gitSeq = 0
    foreach ($raw in (Export-UpstreamCommitLogWithMetadata `
            -MirrorPath $MirrorPath `
            -AfterSha $AfterSha `
            -UntilSha $UntilSha)) {
        $entries += New-StoredCommitEntry `
            -Sha $raw.Sha `
            -AuthorDate $raw.AuthorDate `
            -CommitterDate $raw.CommitterDate `
            -Metadata $raw `
            -GitSequence $gitSeq
        $gitSeq++
    }

    $fetchedAt = (Get-Date).ToUniversalTime().ToString('o')
    Write-ReplaySourceLogCsv -Path $csvPath -Entries $entries
    Write-ReplaySourceLogMeta `
        -Path $metaPath `
        -SourceId $SourceId `
        -AfterSha $AfterSha `
        -UntilSha $UntilSha `
        -FetchedAt $fetchedAt `
        -CommitCount $entries.Count

    if (Test-Path -LiteralPath $legacyJsonPath) {
        Remove-Item -LiteralPath $legacyJsonPath -Force
    }

    Write-SyncLog "  $SourceId -> $csvPath ($($entries.Count) commits, written)"

    return [pscustomobject]@{
        SourceId = $SourceId
        AfterSha = $AfterSha
        UntilSha = $UntilSha
        FetchedAt = $fetchedAt
        CommitCount = $entries.Count
        Commits = $entries
    }
}

function Export-ReplaySourceLogJson {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)][string] $MirrorPath,
        [string] $AfterSha,
        [Parameter(Mandatory)][string] $UntilSha,
        [switch] $Refresh
    )

    return Export-ReplaySourceLogCsv `
        -RepoRoot $RepoRoot `
        -SourceId $SourceId `
        -MirrorPath $MirrorPath `
        -AfterSha $AfterSha `
        -UntilSha $UntilSha `
        -Refresh:$Refresh
}

function Export-ReplaySourceLogs {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $State,
        [Parameter(Mandatory)] $Mirrors,
        [Parameter(Mandatory)][ValidateSet('Bootstrap', 'Incremental', 'Rebuild', 'Verify')]
        [string] $Mode,
        [switch] $Refresh
    )

    Write-SyncLog 'Step 1/4: export upstream history to CSV (one file per source)'

    $resetBranch = $Mode -in @('Bootstrap', 'Rebuild', 'Verify')
    $logs = @{}

    foreach ($prop in $Config.sources.PSObject.Properties) {
        $sourceId = $prop.Name
        $mirrorPath = $Mirrors[$sourceId]
        $branchRef = "refs/heads/$($prop.Value.branch)"
        $untilSha = (Invoke-Git -RepoPath $mirrorPath -GitArgs @('rev-parse', $branchRef)).ToString().Trim()
        $afterSha = if ($resetBranch) { $null } else { Get-SourceCursor -State $State -SourceId $sourceId }

        if ($afterSha) {
            $null = Test-CommitExists -RepoPath $mirrorPath -Sha $afterSha
        }

        $logs[$sourceId] = Export-ReplaySourceLogCsv `
            -RepoRoot $RepoRoot `
            -SourceId $sourceId `
            -MirrorPath $mirrorPath `
            -AfterSha $afterSha `
            -UntilSha $untilSha `
            -Refresh:$Refresh
    }

    return $logs
}

function Import-ReplaySourceLogsFromDisk {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Config
    )

    $logs = @{}
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $sourceId = $prop.Name
        $csvPath = Get-ReplaySourceLogCsvPath -RepoRoot $RepoRoot -SourceId $sourceId
        $metaPath = Get-ReplaySourceLogMetaPath -RepoRoot $RepoRoot -SourceId $sourceId
        $jsonPath = Get-ReplaySourceLogJsonPath -RepoRoot $RepoRoot -SourceId $sourceId

        if ((Test-Path -LiteralPath $csvPath) -and (Test-Path -LiteralPath $metaPath)) {
            $meta = Get-Content -LiteralPath $metaPath -Raw -Encoding utf8 | ConvertFrom-Json
            $logs[$sourceId] = Import-ReplaySourceLogCsv -Meta $meta -Path $csvPath
        }
        elseif (Test-Path -LiteralPath $jsonPath) {
            $logs[$sourceId] = Import-ReplaySourceLogJson -Path $jsonPath
        }
        else {
            throw "Missing $csvPath (run Export-ReplayLogs.ps1 first)"
        }
    }
    return $logs
}

function Get-ReplayPendingCount {
    param([Parameter(Mandatory)] $SourceLogs)

    $count = 0
    foreach ($log in $SourceLogs.Values) {
        if ($log.Commits) {
            $count += $log.Commits.Count
        }
        else {
            $count += [int]$log.CommitCount
        }
    }
    return $count
}

function New-ReplayQueueItemFromStored {
    param(
        [Parameter(Mandatory)][string] $SourceId,
        [Parameter(Mandatory)] $SourceEntry,
        [Parameter(Mandatory)][string] $MirrorPath,
        [Parameter(Mandatory)] $StoredEntry
    )

    $metadata = Get-CommitMetadataFromStoredEntry -Entry $StoredEntry
    $upstreamRepo = Get-SourceRepoSlug -SourceEntry $SourceEntry
    $message = Format-ReplayCommitMessage `
        -SortKey $SourceEntry.sortKey `
        -Metadata $metadata `
        -UpstreamRepo $upstreamRepo `
        -UpstreamSha $StoredEntry.Sha

    return [pscustomobject]@{
        SourceId = $SourceId
        SortKey = $SourceEntry.sortKey
        DestSubdir = $SourceEntry.destSubdir
        UpstreamRepo = $upstreamRepo
        MirrorPath = $MirrorPath
        Sha = $StoredEntry.Sha
        AuthorDate = $StoredEntry.AuthorDate
        CommitterDate = $StoredEntry.CommitterDate
        SortRank = (Get-ReplaySortRank `
            -AuthorDate $StoredEntry.AuthorDate `
            -CommitterDate $StoredEntry.CommitterDate `
            -SortKey $SourceEntry.sortKey `
            -Sha $StoredEntry.Sha)
        Metadata = $metadata
        ReplayMessage = $message
        AuthorNameB64 = (ConvertTo-Base64Utf8 -Text $StoredEntry.AuthorName)
        AuthorEmailB64 = (ConvertTo-Base64Utf8 -Text $StoredEntry.AuthorEmail)
        CommitterNameB64 = (ConvertTo-Base64Utf8 -Text $StoredEntry.CommitterName)
        CommitterEmailB64 = (ConvertTo-Base64Utf8 -Text $StoredEntry.CommitterEmail)
        SubjectB64 = (ConvertTo-Base64Utf8 -Text $metadata.Subject)
        BodyB64 = (ConvertTo-Base64Utf8 -Text $metadata.Body)
        ReplayMessageB64 = (ConvertTo-Base64Utf8 -Text $message)
    }
}

function Write-ReplayQueueJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)][string] $BuiltAt,
        [Parameter(Mandatory)] $SourcePins,
        [Parameter(Mandatory)][object[]] $Queue
    )

    $writer = [System.IO.StreamWriter]::new($Path, $false, $script:Utf8NoBom)
    try {
        $writer.Write('{"version":')
        $writer.Write($script:ReplayQueueVersion)
        $writer.Write(',"builtAt":')
        Write-JsonString -Writer $writer -Value $BuiltAt
        $writer.Write(',"sources":{')

        $firstSource = $true
        foreach ($entry in $SourcePins.GetEnumerator()) {
            if (-not $firstSource) {
                $writer.Write(',')
            }
            $firstSource = $false
            $writer.Write('"')
            $writer.Write($entry.Key)
            $writer.Write('":{"afterSha":')
            if ($entry.Value.afterSha) {
                Write-JsonString -Writer $writer -Value $entry.Value.afterSha
            }
            else {
                $writer.Write('null')
            }
            $writer.Write(',"untilSha":')
            Write-JsonString -Writer $writer -Value $entry.Value.untilSha
            $writer.Write('}')
        }

        $writer.Write('},"commits":[')
        $first = $true
        foreach ($item in $Queue) {
            if (-not $first) {
                $writer.Write(',')
            }
            $first = $false
            $writer.Write('{"sha":')
            Write-JsonString -Writer $writer -Value $item.Sha
            $writer.Write(',"sourceId":')
            Write-JsonString -Writer $writer -Value $item.SourceId
            $writer.Write(',"sortKey":')
            Write-JsonString -Writer $writer -Value $item.SortKey
            $writer.Write(',"destSubdir":')
            Write-JsonString -Writer $writer -Value $item.DestSubdir
            $writer.Write(',"upstreamRepo":')
            Write-JsonString -Writer $writer -Value $item.UpstreamRepo
            $writer.Write(',"authorDate":')
            $writer.Write($item.AuthorDate)
            $writer.Write(',"committerDate":')
            $writer.Write($item.CommitterDate)
            $writer.Write(',"sortRank":')
            Write-JsonString -Writer $writer -Value $item.SortRank
            $writer.Write(',"authorNameB64":')
            Write-JsonString -Writer $writer -Value $item.AuthorNameB64
            $writer.Write(',"authorEmailB64":')
            Write-JsonString -Writer $writer -Value $item.AuthorEmailB64
            $writer.Write(',"committerNameB64":')
            Write-JsonString -Writer $writer -Value $item.CommitterNameB64
            $writer.Write(',"committerEmailB64":')
            Write-JsonString -Writer $writer -Value $item.CommitterEmailB64
            $writer.Write(',"subjectB64":')
            Write-JsonString -Writer $writer -Value $item.SubjectB64
            $writer.Write(',"bodyB64":')
            Write-JsonString -Writer $writer -Value $item.BodyB64
            $writer.Write(',"replayMessageB64":')
            Write-JsonString -Writer $writer -Value $item.ReplayMessageB64
            $writer.Write('}')
        }

        $writer.Write(']}')
    }
    finally {
        $writer.Close()
    }
}

function Test-ReplayQueueJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)] $SourceLogs
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }

    try {
        $head = (Get-Content -LiteralPath $Path -TotalCount 1 -Encoding utf8)
        if ($head -notmatch '"version":4') {
            return $false
        }
        $doc = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    }
    catch {
        return $false
    }

    foreach ($sourceId in $SourceLogs.Keys) {
        $log = $SourceLogs[$sourceId]
        $pin = $doc.sources.$sourceId
        if (-not $pin) {
            return $false
        }
        $expectedAfter = if ($log.AfterSha) { $log.AfterSha } else { $null }
        $actualAfter = if ($pin.afterSha) { $pin.afterSha.ToString() } else { $null }
        if ($pin.untilSha -ne $log.UntilSha -or $actualAfter -ne $expectedAfter) {
            return $false
        }
    }

    return $doc.commits.Count -gt 0
}

function Import-ReplayQueueJson {
    param(
        [Parameter(Mandatory)][string] $Path,
        [Parameter(Mandatory)] $Mirrors
    )

    $doc = Get-Content -LiteralPath $Path -Raw -Encoding utf8 | ConvertFrom-Json
    $queue = @()

    foreach ($entry in $doc.commits) {
        $metadata = [pscustomobject]@{
            AuthorName = ConvertFrom-Base64Utf8 -Encoded $entry.authorNameB64.ToString()
            AuthorEmail = ConvertFrom-Base64Utf8 -Encoded $entry.authorEmailB64.ToString()
            AuthorDate = [int64]$entry.authorDate
            CommitterName = ConvertFrom-Base64Utf8 -Encoded $entry.committerNameB64.ToString()
            CommitterEmail = ConvertFrom-Base64Utf8 -Encoded $entry.committerEmailB64.ToString()
            CommitterDate = [int64]$entry.committerDate
            Subject = ConvertFrom-Base64Utf8 -Encoded $entry.subjectB64.ToString()
            Body = ConvertFrom-Base64Utf8 -Encoded $(if ($entry.bodyB64) { $entry.bodyB64.ToString() } else { '' })
        }

        $queue += [pscustomobject]@{
            SourceId = $entry.sourceId.ToString()
            SortKey = $entry.sortKey.ToString()
            DestSubdir = $entry.destSubdir.ToString()
            UpstreamRepo = $entry.upstreamRepo.ToString()
            MirrorPath = $Mirrors[$entry.sourceId.ToString()]
            Sha = $entry.sha.ToString()
            AuthorDate = [int64]$entry.authorDate
            CommitterDate = [int64]$entry.committerDate
            SortRank = $entry.sortRank.ToString()
            Metadata = $metadata
            ReplayMessage = ConvertFrom-Base64Utf8 -Encoded $entry.replayMessageB64.ToString()
            AuthorNameB64 = $entry.authorNameB64.ToString()
            AuthorEmailB64 = $entry.authorEmailB64.ToString()
            CommitterNameB64 = $entry.committerNameB64.ToString()
            CommitterEmailB64 = $entry.committerEmailB64.ToString()
            SubjectB64 = $entry.subjectB64.ToString()
            BodyB64 = if ($entry.bodyB64) { $entry.bodyB64.ToString() } else { '' }
            ReplayMessageB64 = $entry.replayMessageB64.ToString()
        }
    }

    return [pscustomobject]@{
        BuiltAt = $doc.builtAt.ToString()
        Commits = $queue
    }
}

function Export-ReplayQueueJson {
    param(
        [Parameter(Mandatory)][string] $RepoRoot,
        [Parameter(Mandatory)] $Config,
        [Parameter(Mandatory)] $Mirrors,
        [Parameter(Mandatory)] $SourceLogs,
        [switch] $Refresh
    )

    $path = Get-ReplayQueueJsonPath -RepoRoot $RepoRoot
    if (-not $Refresh -and (Test-ReplayQueueJson -Path $path -SourceLogs $SourceLogs)) {
        $imported = Import-ReplayQueueJson -Path $path -Mirrors $Mirrors
        Write-SyncLog "Step 2/4: using cached $path ($($imported.Commits.Count) commits)"
        return $imported.Commits
    }

    $total = Get-ReplayPendingCount -SourceLogs $SourceLogs
    Write-SyncLog "Step 2/4: import source CSV, merge by replay rank ($total commits)"

    $merged = $null
    foreach ($prop in $Config.sources.PSObject.Properties) {
        $sourceId = $prop.Name
        $sourceEntry = $prop.Value
        $mirrorPath = $Mirrors[$sourceId]
        $sourceQueue = New-Object System.Collections.Generic.List[object]

        foreach ($entry in $SourceLogs[$sourceId].Commits) {
            [void]$sourceQueue.Add((New-ReplayQueueItemFromStored `
                -SourceId $sourceId `
                -SourceEntry $sourceEntry `
                -MirrorPath $mirrorPath `
                -StoredEntry $entry))
        }

        if ($null -eq $merged) {
            $merged = @($sourceQueue.ToArray())
        }
        else {
            $merged = Merge-ReplayCommitQueues -Left $merged -Right @($sourceQueue.ToArray())
        }
    }

    $sorted = if ($merged) { @($merged) } else { @() }
    $builtAt = (Get-Date).ToUniversalTime().ToString('o')

    $pins = @{}
    foreach ($sourceId in $SourceLogs.Keys) {
        $log = $SourceLogs[$sourceId]
        $pins[$sourceId] = @{
            afterSha = $log.AfterSha
            untilSha = $log.UntilSha
        }
    }

    Write-ReplayQueueJson -Path $path -BuiltAt $builtAt -SourcePins $pins -Queue $sorted
    Write-SyncLog "Step 2/4: wrote $path ($($sorted.Count) commits)"

    return $sorted
}
