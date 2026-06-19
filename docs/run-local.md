# Run locally

Requires **PowerShell 7+**, **git**, and network (mirror clone/fetch).

From the repository root:

```powershell
./scripts/Fetch-Mirrors.ps1
./scripts/Retrieve-History.ps1
./scripts/Merge-Queue.ps1
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

Save every commit entry to JSON (large files):

```powershell
./scripts/Retrieve-History.ps1 -SkipFetch -SaveFullJson
./scripts/Merge-Queue.ps1 -SkipFetch -SaveFullJson
```

Writes `history-*-full.json` and `merged-queue-full.json`.

Skip re-fetch if mirrors already exist:

```powershell
./scripts/Fetch-Mirrors.ps1 -SkipFetch
./scripts/Retrieve-History.ps1 -SkipFetch
./scripts/Merge-Queue.ps1 -SkipFetch
```

Full sync (retrieve, merge, replay, push):

```powershell
./scripts/Sync-Upstream.ps1 -DestinationPath .work/destination/msys2-uwp
```

Local replay without push (throttle for dev):

```powershell
./scripts/Sync-Upstream.ps1 -DryRun -SkipFetch -MaxCommits 5
./scripts/Sync-Upstream.ps1 -SkipFetch -MaxCommits 10 -DestinationPath .work/destination/msys2-uwp
```

Log to a file only (`-LogFile` suppresses console `[sync]` info lines; warnings/errors
still print). Each run truncates the log unless you pass `-LogAppend`.

Option A ¡ª close `out.txt` in the editor, then:

```powershell
./scripts/Sync-Upstream.ps1 -DryRun -SkipFetch -LogFile out.txt
```

Option B ¡ª log to a path the editor is not holding open:

```powershell
./scripts/Sync-Upstream.ps1 -DryRun -SkipFetch -LogFile .work/cache/replay-log/sync-dryrun.log
```

Throttled dry-run with log file:

```powershell
./scripts/Sync-Upstream.ps1 -DryRun -SkipFetch -MaxCommits 5 -LogFile .work/cache/replay-log/sync-dryrun.log
```

Resume after interrupt or failure (uses `.work/cache/replay-log/replay-checkpoint.json`):

```powershell
./scripts/Sync-Upstream.ps1 -DryRun -SkipFetch -LogFile .work/cache/replay-log/sync-dryrun.log -LogAppend -Resume
./scripts/Sync-Upstream.ps1 -ClearCheckpoint   # discard checkpoint, start fresh
```

Bootstrap from scratch (reset sync branches, force-push):

```powershell
./scripts/Sync-Upstream.ps1 -Clean -DestinationPath .work/destination/msys2-uwp
```

Unit tests:

```powershell
./tests/Test-Sync.ps1
npm test
```

Minimal-safe-editing checker (after `npm install`):

```powershell
npm run build
npm run msec:check
npm test -- tests/minimal-safe-editing-check
```
