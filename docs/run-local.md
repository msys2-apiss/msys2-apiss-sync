# Run locally (testing)

Operational sync (push, resume, bootstrap): [`usage.md`](usage.md).

Requires **Node.js 26+**, **Yarn**, **git**, and network when fetching mirrors.

## Unit tests

```bash
yarn test
yarn typecheck
```

## Pipeline steps

Run retrieve and merge without replay (inspect `[sync]` output and JSON under
`.work/cache/replay-log/`):

```bash
yarn fetch-mirrors --skip-fetch
yarn retrieve-history --skip-fetch
yarn merge-queue --skip-fetch
```

Save every commit entry to JSON (large files):

```bash
yarn retrieve-history --skip-fetch --save-full-json
yarn merge-queue --skip-fetch --save-full-json
```

Writes `history-*-full.json` and `merged-queue-full.json`.

## Dry-run and throttle

Replay locally without push:

```bash
yarn sync --dry-run --skip-fetch --max-commits 5
yarn sync --skip-fetch --max-commits 10 --destination-path .work/destination/msys2-apiss
```

## Log capture

`--log-file` suppresses console `[sync]` info lines; warnings and errors still
print. Each run truncates the log unless you pass `--log-append`. Use paths under
`.work/cache/replay-log/`, not repo-root files (`out.txt`, `msys.txt`).

```bash
yarn sync --dry-run --skip-fetch --log-file .work/cache/replay-log/sync-dryrun.log
yarn sync --dry-run --skip-fetch --max-commits 5 --log-file .work/cache/replay-log/sync-dryrun.log
```
