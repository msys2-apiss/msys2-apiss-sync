#requires -Version 7.0

function Write-SyncLog {
    param(
        [Parameter(Mandatory)]
        [string] $Message,
        [ValidateSet('Info', 'Warn', 'Error')]
        [string] $Level = 'Info'
    )
    $prefix = switch ($Level) {
        'Warn' { '[sync][warn]' }
        'Error' { '[sync][error]' }
        default { '[sync]' }
    }
    Write-Host "$prefix $Message"
}

function Clear-GitLockFiles {
    param(
        [Parameter(Mandatory)][string] $RepoPath
    )

    $gitDir = Join-Path $RepoPath '.git'
    foreach ($name in @('index.lock', 'shallow.lock', 'HEAD.lock')) {
        $lockPath = Join-Path $gitDir $name
        if (-not (Test-Path -LiteralPath $lockPath)) {
            continue
        }

        try {
            Remove-Item -LiteralPath $lockPath -Force -ErrorAction Stop
            Write-SyncLog "Removed stale git lock: $name" -Level Warn
        }
        catch {
            Write-SyncLog "Could not remove git lock $name : $($_.Exception.Message)" -Level Warn
        }
    }
}

function Test-GitLockError {
    param([string] $Text)
    return $Text -match 'index\.lock|Unable to create.*\.lock|Another git process'
}

function Invoke-Git {
    param(
        [string] $RepoPath,
        [Parameter(Mandatory)]
        [string[]] $GitArgs,
        [int] $MaxAttempts = 5
    )

    $allArgs = if ($RepoPath) { @('-C', $RepoPath) + $GitArgs } else { $GitArgs }
    $attempt = 0
    $lastOutput = $null

    while ($attempt -lt $MaxAttempts) {
        $attempt++
        $output = & git @allArgs 2>&1
        if ($LASTEXITCODE -eq 0) {
            return $output
        }

        $lastOutput = "$output"
        if ($RepoPath -and (Test-GitLockError -Text $lastOutput) -and $attempt -lt $MaxAttempts) {
            Clear-GitLockFiles -RepoPath $RepoPath
            Start-Sleep -Milliseconds (200 * $attempt)
            continue
        }

        $cmd = "git $($allArgs -join ' ')"
        throw "git command failed ($cmd): $lastOutput"
    }

    $cmd = "git $($allArgs -join ' ')"
    throw "git command failed ($cmd): $lastOutput"
}

function Invoke-GitStdin {
    param(
        [string] $RepoPath,
        [Parameter(Mandatory)]
        [string[]] $GitArgs,
        [Parameter(Mandatory)]
        [string] $InputText,
        [int] $MaxAttempts = 5
    )

    $attempt = 0
    $lastOutput = $null

    while ($attempt -lt $MaxAttempts) {
        $attempt++
        $psi = [System.Diagnostics.ProcessStartInfo]::new('git')
        $psi.UseShellExecute = $false
        $psi.RedirectStandardInput = $true
        $psi.RedirectStandardOutput = $true
        $psi.RedirectStandardError = $true
        $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
        $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)

        if ($RepoPath) {
            [void]$psi.ArgumentList.Add('-C')
            [void]$psi.ArgumentList.Add($RepoPath)
        }
        foreach ($arg in $GitArgs) {
            [void]$psi.ArgumentList.Add($arg)
        }

        $process = [System.Diagnostics.Process]::Start($psi)
        $process.StandardInput.Write($InputText)
        $process.StandardInput.Close()
        $stdout = $process.StandardOutput.ReadToEnd()
        $stderr = $process.StandardError.ReadToEnd()
        $process.WaitForExit()

        if ($process.ExitCode -eq 0) {
            return $stdout
        }

        $lastOutput = $stderr
        if ($RepoPath -and (Test-GitLockError -Text $lastOutput) -and $attempt -lt $MaxAttempts) {
            Clear-GitLockFiles -RepoPath $RepoPath
            Start-Sleep -Milliseconds (200 * $attempt)
            continue
        }

        $cmd = if ($RepoPath) { "git -C $RepoPath $($GitArgs -join ' ')" } else { "git $($GitArgs -join ' ')" }
        throw "git command failed ($cmd): $lastOutput"
    }

    $cmd = if ($RepoPath) { "git -C $RepoPath $($GitArgs -join ' ')" } else { "git $($GitArgs -join ' ')" }
    throw "git command failed ($cmd): $lastOutput"
}

function Get-SyncRepoRoot {
    param([string] $StartPath = $PSScriptRoot)

    $current = Resolve-Path -LiteralPath $StartPath
    while ($true) {
        $configPath = Join-Path $current.Path 'config/sync.json'
        if (Test-Path -LiteralPath $configPath) {
            return $current.Path
        }
        $parent = Split-Path -Parent $current.Path
        if (-not $parent -or $parent -eq $current.Path) {
            throw 'Could not locate sync repo root (config/sync.json not found).'
        }
        $current = Resolve-Path -LiteralPath $parent
    }
}

function Get-WorkDirectory {
    param([Parameter(Mandatory)][string] $RepoRoot)
    $work = Join-Path $RepoRoot '.work'
    if (-not (Test-Path -LiteralPath $work)) {
        New-Item -ItemType Directory -Path $work | Out-Null
    }
    return $work
}

function ConvertTo-UnixLineEndings {
    param([string] $Text)
    if ($null -eq $Text) { return '' }
    return ($Text -replace "`r`n", "`n" -replace "`r", "`n")
}

function Set-SyncUtf8Environment {
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = $utf8
    [Console]::InputEncoding = $utf8
    $OutputEncoding = $utf8
    $env:LANG = 'C.UTF-8'
    $env:LC_ALL = 'C.UTF-8'
}

function Invoke-GitText {
    param(
        [string] $RepoPath,
        [Parameter(Mandatory)]
        [string[]] $GitArgs
    )

    $psi = [System.Diagnostics.ProcessStartInfo]::new('git')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $psi.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)

    if ($RepoPath) {
        [void]$psi.ArgumentList.Add('-C')
        [void]$psi.ArgumentList.Add($RepoPath)
    }
    foreach ($arg in $GitArgs) {
        [void]$psi.ArgumentList.Add($arg)
    }

    $process = [System.Diagnostics.Process]::Start($psi)
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()

    if ($process.ExitCode -ne 0) {
        $cmd = if ($RepoPath) { "git -C $RepoPath $($GitArgs -join ' ')" } else { "git $($GitArgs -join ' ')" }
        throw "git command failed ($cmd): $stderr"
    }

    return $stdout
}

function ConvertTo-Base64Utf8 {
    param([AllowNull()][string] $Text)
    if ($null -eq $Text -or $Text.Length -eq 0) {
        return ''
    }
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($Text))
}

function ConvertFrom-Base64Utf8 {
    param([AllowNull()][string] $Encoded)
    if ($null -eq $Encoded -or $Encoded.Length -eq 0) {
        return ''
    }
    return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Encoded))
}

function Format-CsvField {
    param([AllowNull()][string] $Value)

    if ($null -eq $Value) {
        return '""'
    }

    if ($Value -match '[,"\r\n]') {
        return '"' + ($Value -replace '"', '""') + '"'
    }

    return $Value
}

function Format-CsvQuotedField {
    param([AllowNull()][string] $Value)

    if ($null -eq $Value) {
        return '""'
    }

    return '"' + ($Value -replace '"', '""') + '"'
}

function Write-JsonString {
    param(
        [Parameter(Mandatory)][System.IO.StreamWriter] $Writer,
        [AllowNull()][string] $Value
    )

    if ($null -eq $Value) {
        $Writer.Write('null')
        return
    }

    $Writer.Write('"')
    foreach ($ch in $Value.ToCharArray()) {
        switch ($ch) {
            '"' { $Writer.Write('\"') }
            '\' { $Writer.Write('\\') }
            { [int][char]$ch -lt 0x20 } { $Writer.Write('\u{0:x4}' -f [int][char]$ch) }
            default { $Writer.Write($ch) }
        }
    }
    $Writer.Write('"')
}

function Split-CommitMessage {
    param([AllowNull()][string] $Message)

    $message = ConvertTo-UnixLineEndings -Text $Message
    $message = $message.TrimEnd("`n")
    if (-not $message) {
        return @{ Subject = ''; Body = '' }
    }

    $lines = $message -split "`n"
    $subject = $lines[0]
    if ($lines.Count -eq 1) {
        return @{ Subject = $subject; Body = '' }
    }

    $bodyStart = 1
    if ($lines.Count -gt 1 -and $lines[1] -eq '') {
        $bodyStart = 2
    }

    $body = if ($bodyStart -lt $lines.Count) {
        ($lines[$bodyStart..($lines.Count - 1)] -join "`n").TrimEnd()
    }
    else {
        ''
    }

    return @{
        Subject = $subject
        Body = $body
    }
}

function Get-CommitMetadataFromStoredEntry {
    param([Parameter(Mandatory)] $Entry)

    if ($null -ne $Entry.PSObject.Properties['AuthorName']) {
        if ($null -ne $Entry.PSObject.Properties['Message'] -and $Entry.Message) {
            $split = Split-CommitMessage -Message $Entry.Message
            return [pscustomobject]@{
                AuthorName = $Entry.AuthorName
                AuthorEmail = $Entry.AuthorEmail
                AuthorDate = [int64]$Entry.AuthorDate
                CommitterName = $Entry.CommitterName
                CommitterEmail = $Entry.CommitterEmail
                CommitterDate = [int64]$Entry.CommitterDate
                Subject = $split.Subject
                Body = $split.Body
            }
        }

        return [pscustomobject]@{
            AuthorName = $Entry.AuthorName
            AuthorEmail = $Entry.AuthorEmail
            AuthorDate = [int64]$Entry.AuthorDate
            CommitterName = $Entry.CommitterName
            CommitterEmail = $Entry.CommitterEmail
            CommitterDate = [int64]$Entry.CommitterDate
            Subject = $Entry.Subject
            Body = if ($Entry.Body) { $Entry.Body } else { '' }
        }
    }

    return [pscustomobject]@{
        AuthorName = ConvertFrom-Base64Utf8 -Encoded $Entry.AuthorNameB64
        AuthorEmail = ConvertFrom-Base64Utf8 -Encoded $Entry.AuthorEmailB64
        AuthorDate = [int64]$Entry.AuthorDate
        CommitterName = ConvertFrom-Base64Utf8 -Encoded $Entry.CommitterNameB64
        CommitterEmail = ConvertFrom-Base64Utf8 -Encoded $Entry.CommitterEmailB64
        CommitterDate = [int64]$Entry.CommitterDate
        Subject = ConvertFrom-Base64Utf8 -Encoded $Entry.SubjectB64
        Body = ConvertFrom-Base64Utf8 -Encoded $Entry.BodyB64
    }
}

function Get-StoredEntryTextB64 {
    param(
        [Parameter(Mandatory)] $Entry,
        [Parameter(Mandatory)][string] $PlainProperty,
        [Parameter(Mandatory)][string] $B64Property
    )

    if ($null -ne $Entry.PSObject.Properties[$B64Property] -and $Entry.$B64Property) {
        return $Entry.$B64Property
    }

    $plain = if ($null -ne $Entry.PSObject.Properties[$PlainProperty]) { $Entry.$PlainProperty } else { '' }
    return ConvertTo-Base64Utf8 -Text $plain
}

function Parse-GitCommitObject {
    param(
        [Parameter(Mandatory)]
        [string] $Raw
    )

    $raw = ConvertTo-UnixLineEndings -Text $Raw
    $authorName = $null
    $authorEmail = $null
    $authorDate = 0
    $committerName = $null
    $committerEmail = $null
    $committerDate = 0

    foreach ($line in ($raw -split "`n")) {
        if ($line -match '^author (.+?) <([^>]*)> (\d+) ') {
            $authorName = $Matches[1].Trim()
            $authorEmail = $Matches[2]
            $authorDate = [int64]$Matches[3]
        }
        elseif ($line -match '^committer (.+?) <([^>]*)> (\d+) ') {
            $committerName = $Matches[1].Trim()
            $committerEmail = $Matches[2]
            $committerDate = [int64]$Matches[3]
        }
    }

    if (-not $authorName) {
        $preview = ($raw -split "`n" | Select-Object -First 6) -join '; '
        throw "Could not parse author from git commit object. Header: $preview"
    }

    if (-not $committerName) {
        $committerName = $authorName
        $committerEmail = $authorEmail
    }

    if ($committerDate -eq 0) {
        $committerDate = $authorDate
    }

    $blankIdx = $raw.IndexOf("`n`n")
    $message = if ($blankIdx -ge 0) { $raw.Substring($blankIdx + 2) } else { '' }
    $message = $message.TrimEnd("`n")
    $msgParts = $message -split "`n", 2
    $subject = $msgParts[0]
    $body = if ($msgParts.Count -gt 1) { $msgParts[1].TrimEnd() } else { '' }

    return [pscustomobject]@{
        AuthorName = $authorName
        AuthorEmail = $authorEmail
        AuthorDate = $authorDate
        CommitterName = $committerName
        CommitterEmail = $committerEmail
        CommitterDate = $committerDate
        Subject = $subject
        Body = $body
    }
}
