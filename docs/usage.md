# Usage

How to run sync on GitHub and on your machine.

Pipeline: `msys2/*` upstream -> `msys2-apiss/*` mirrors -> `msys2-apiss/msys2-apiss`
on branches `upstream`, `upstream-ports`, `upstream-ports-mingw`.

Local testing and debugging: [`run-local.md`](run-local.md). Design and flags:
[`PLAN.md`](PLAN.md).

## GitHub (`gh`)

Requires the [GitHub CLI](https://cli.github.com/) (`gh auth login`) with access to
`msys2-apiss`. Mirror repos need `SYNC_DISPATCH_TOKEN`; `msys2-apiss-sync` needs
`MSYS2_APISS_SYNC_TOKEN`.

### 1. Refresh mirrors from upstream

Run on branch `sync` (workflows live there, not on `master`). Run both mirrors, or
only the repo that changed.

```bash
gh workflow run mirror-sync.yml --repo msys2-apiss/MSYS2-packages --ref sync
gh workflow run mirror-sync.yml --repo msys2-apiss/MINGW-packages --ref sync
```

### 2. Watch mirror runs

```bash
gh run watch --repo msys2-apiss/MSYS2-packages
gh run watch --repo msys2-apiss/MINGW-packages
```

If upstream `master` advanced, the workflow fast-forwards mirror `master` and
dispatches `msys2-apiss-sync`. If there were no upstream changes, skip to step 3
only when you still need a destination replay.

### 3. Replay destination

Usually automatic after step 2. Trigger manually when mirrors are already current
or dispatch did not run:

```bash
gh workflow run sync-upstream.yml --repo msys2-apiss/msys2-apiss-sync
gh run watch --repo msys2-apiss/msys2-apiss-sync
```

### 4. Verify

```bash
gh run list --repo msys2-apiss/msys2-apiss-sync --workflow sync-upstream.yml --limit 5
```

Check destination branch tips on `msys2-apiss/msys2-apiss` (`upstream`,
`upstream-ports`, `upstream-ports-mingw`).

### Recovery and special cases

| Goal | Command |
|------|---------|
| Resume after failure | Repeat step 3 (incremental from branch cursors) |
| Reset branches, full replay | `gh workflow run sync-upstream.yml --repo msys2-apiss/msys2-apiss-sync -f clean=true` |
| Clean rebuild (confirm) | `gh workflow run sync-rebuild.yml --repo msys2-apiss/msys2-apiss-sync -f confirm=rebuild` |
| Bootstrap full history | `gh workflow run sync-bootstrap.yml --repo msys2-apiss/msys2-apiss-sync -f confirm=bootstrap` |

## Local machine

Requires **Node.js 26+**, **Yarn**, **git**, and network (mirror clone/fetch).

From the repository root.

### Full sync (retrieve, merge, replay, push)

```bash
yarn fetch-mirrors
yarn retrieve-history
yarn merge-queue
yarn sync --destination-path .work/destination/msys2-apiss
```

Or one step:

```bash
yarn sync --destination-path .work/destination/msys2-apiss
```

Each script prints `[sync]` progress. Summary JSON is written under
`.work/cache/replay-log/`.

### Skip re-fetch

When mirrors already exist under `.work/mirrors/`:

```bash
yarn sync --skip-fetch --destination-path .work/destination/msys2-apiss
```

### Resume after interrupt or failure

Re-run without `--clean`. Branch cursors in the destination clone hold progress.

```bash
yarn sync --skip-fetch --destination-path .work/destination/msys2-apiss --log-file sync-run.log --log-append
```

### Bootstrap from scratch

Reset sync branches and replay from history root:

```bash
yarn sync --clean --destination-path .work/destination/msys2-apiss
```
