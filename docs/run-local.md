# Run locally

Requires **Node.js 22.18+**, **Yarn**, **git**, and network (mirror
clone/fetch).

From the repository root:

```bash
yarn fetch-mirrors
yarn retrieve-history
yarn merge-queue
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

Save every commit entry to JSON (large files):

```bash
yarn retrieve-history --skip-fetch --save-full-json
yarn merge-queue --skip-fetch --save-full-json
```

Writes `history-*-full.json` and `merged-queue-full.json`.

Skip re-fetch if mirrors already exist:

```bash
yarn fetch-mirrors --skip-fetch
yarn retrieve-history --skip-fetch
yarn merge-queue --skip-fetch
```

Full sync (retrieve, merge, replay, push):

```bash
yarn sync --destination-path .work/destination/msys2-uwp
```

Local replay without push (throttle for dev):

```bash
yarn sync --dry-run --skip-fetch --max-commits 5
yarn sync --skip-fetch --max-commits 10 --destination-path .work/destination/msys2-uwp
```

Log to a file under `.work/cache/replay-log/` (`--log-file` suppresses console
`[sync]` info lines; warnings/errors still print). Each run truncates the log
unless you pass `--log-append`. Do not use repo-root log files (`out.txt`,
`msys.txt`).

```bash
yarn sync --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log
```

Throttled dry-run with log file:

```bash
yarn sync --dry-run --skip-fetch --max-commits 5 --log-file .work/cache/replay-log/sync-dryrun.log
```

Resume after interrupt or failure (uses `.work/cache/replay-log/replay-checkpoint.json`):

```bash
yarn sync --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log --log-append --resume
yarn sync --clear-checkpoint
```

Bootstrap from scratch (reset sync branches, force-push):

```bash
yarn sync --clean --destination-path .work/destination/msys2-uwp
```

Unit tests:

```bash
yarn test
yarn typecheck
```
