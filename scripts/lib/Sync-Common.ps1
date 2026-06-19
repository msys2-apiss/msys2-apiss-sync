#requires -Version 7.0

if (-not (Get-Variable -Name SyncLogFile -Scope Script -ErrorAction SilentlyContinue)) {
    $script:SyncLogFile = $null
}
if (-not (Get-Variable -Name SyncLogWriter -Scope Script -ErrorAction SilentlyContinue)) {
    $script:SyncLogWriter = $null
}
if (-not (Get-Variable -Name SyncLogQuietConsole -Scope Script -ErrorAction SilentlyContinue)) {
    $script:SyncLogQuietConsole = $false
}

function Set-SyncLogFile {
    param(
        [Parameter(Mandatory)][string] $Path,
        [switch] $Append,
        [switch] $QuietConsole
    )

    Close-SyncLogFile

    $dir = Split-Path -Parent $Path
    if ($dir -and -not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $script:SyncLogFile = $Path
    $script:SyncLogQuietConsole = [bool]$QuietConsole

    $encoding = [System.Text.UTF8Encoding]::new($false)
    try {
        $fileStream = [System.IO.FileStream]::new(
            $Path,
            [System.IO.FileMode]::OpenOrCreate,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
        if ($Append) {
            $null = $fileStream.Seek(0, [System.IO.SeekOrigin]::End)
        }
        else {
            $fileStream.SetLength(0)
        }
    }
    catch {
        $fallbackDir = if ($dir) { $dir } else { (Get-Location).Path }
        $fallback = Join-Path $fallbackDir ('sync-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')
        Write-Warning "Could not open log file '$Path' ($($_.Exception.Message)); using '$fallback'."
        $script:SyncLogFile = $fallback
        $fileStream = [System.IO.FileStream]::new(
            $fallback,
            [System.IO.FileMode]::Create,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::ReadWrite
        )
    }

    $script:SyncLogWriter = [System.IO.StreamWriter]::new($fileStream, $encoding)
    $script:SyncLogWriter.AutoFlush = $true
}

function Close-SyncLogFile {
    if ($script:SyncLogWriter) {
        $script:SyncLogWriter.Dispose()
        $script:SyncLogWriter = $null
    }
}

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
    $line = "$prefix $Message"
    $writeConsole = (-not $script:SyncLogQuietConsole) -or ($Level -ne 'Info')
    if ($writeConsole) {
        Write-Host $line
    }
    if ($script:SyncLogWriter) {
        $script:SyncLogWriter.WriteLine($line)
    }
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

    $attempt = 0
    $lastOutput = $null

    while ($attempt -lt $MaxAttempts) {
        $attempt++

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

        if ($process.ExitCode -eq 0) {
            if ($stdout) { return $stdout }
            return $stderr
        }

        $lastOutput = if ($stderr) { $stderr.Trim() } else { $stdout.Trim() }
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

function Get-SyncRepoRoot {
    param([string] $StartPath = $PSScriptRoot)

    $current = Resolve-Path -LiteralPath $StartPath
    while ($true) {
        $configPath = Join-Path $current.Path 'config/config.psd1'
        if (Test-Path -LiteralPath $configPath) {
            return $current.Path
        }
        $parent = Split-Path -Parent $current.Path
        if (-not $parent -or $parent -eq $current.Path) {
            throw 'Could not locate sync repo root (config/config.psd1 not found).'
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
