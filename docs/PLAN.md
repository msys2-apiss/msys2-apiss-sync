# MSYS2-UWP upstream sync plan

Sync upstream package history from [msys2/MINGW-packages](https://github.com/msys2/MINGW-packages)
and [msys2/MSYS2-packages](https://github.com/msys2/MSYS2-packages) into
[msys2-uwp/msys2-uwp](https://github.com/msys2-uwp/msys2-uwp) on branch `upstream`.

## Goals

- Cross-platform PowerShell 7 (`pwsh`) scripts runnable locally and in CI.
- Incremental sync triggered within ~1-5 minutes of upstream activity (mirror + dispatch).
- Hourly poll as tolerance fallback so nothing is missed.
- Auto-push results to `msys2-uwp/msys2-uwp`.
- Preserve original commit dates when replaying history one commit at a time.
- **Deterministic replay**: re-running a full rebuild from the same upstream
  snapshot must produce the same commit order, trees, and SHAs.

## Non-goals (phase 1)

- UWP-specific patches (those live on other branches later).
- Building or validating PKGBUILDs during sync.
- Writing workflows into upstream `msys2/*` repos (we do not control them).

## Repository roles

| Repository | Role |
|------------|------|
| `msys2-uwp/msys2-uwp-sync` (this repo) | PowerShell sync engine, config, sync state, GitHub Actions |
| `msys2-uwp/msys2-uwp` | Destination monorepo; branch `upstream` holds replayed history only |
| `msys2-uwp/MSYS2-packages-mirror` | Fast mirror of `msys2/MSYS2-packages`; dispatches on push |
| `msys2-uwp/MINGW-packages-mirror` | Fast mirror of `msys2/MINGW-packages`; dispatches on push |

## Destination layout (branch `upstream`)

```
msys2-uwp/
  ports/          <-- tree from msys2/MSYS2-packages (master)
  ports-mingw/    <-- tree from msys2/MINGW-packages (master)
```

No sync metadata lives in the destination repo; it stays package content only.

## Base commit (replay root)

Replayed upstream history is **appended on top of** an existing root commit in
[msys2-uwp/msys2-uwp](https://github.com/msys2-uwp/msys2-uwp), not an orphan
branch.

| Field | Value |
|-------|-------|
| SHA | `6fc20894663468a04dd4986a8b1c15a9d5ae8649` |
| Message | `Create a git repository with empty .gitingore file.` |
| Role | Parent of the **first** replayed merge commit |

The first replayed commit must have this SHA as its sole parent. Bootstrap and
rebuild reset branch `upstream` to this commit, then replay. Incremental runs
append after the current `upstream` tip (which must descend from this base).

Configured in `config/sync.json` as `destination.baseCommit`. Do not rewrite
this commit from sync tooling.

| Upstream repo | Upstream path | Destination path |
|---------------|---------------|------------------|
| `msys2/MSYS2-packages` | `*` | `ports/*` |
| `msys2/MINGW-packages` | `*` | `ports-mingw/*` |

## Merge strategy: date-ordered replay

Upstream histories are **not** merged with `git merge`. Instead:

1. Fetch both upstream repos as read-only remotes.
2. Collect commits reachable from upstream `master` that are not yet replayed.
3. Merge pending commits by **replay rank** (committer date, author date, source id,
   SHA) while keeping each source in **git history order**.
4. Replay **one commit at a time** onto `upstream`:
   - Check out parent state.
   - Apply tree changes into the mapped subdirectory only.
   - Create a commit with the **original author, committer, dates, and message**
     (optionally prefix message with `[ports]` or `[ports-mingw]` for traceability).
5. Advance the per-repo cursor in this repo's `.sync/state.json`.
6. Push `upstream` on the destination; commit updated state to this repo.

This yields a single linear `upstream` branch whose commit timeline reflects
real upstream activity order across both repos.

## Deterministic replay (consistent history on re-do)

You will re-build the merged tree from time to time (bootstrap, rebuild after
rule changes, recovery). The replay engine must be a **pure function** of:

1. Pinned upstream commit ranges (per source ref)
2. `replaySpecVersion` in `config/sync.json` (algorithm version)
3. Path mapping (`ports/`, `ports-mingw/`)
4. `destination.baseCommit` (`6fc20894663468a04dd4986a8b1c15a9d5ae8649`)

Given the same inputs, every rebuild must yield **identical** `upstream`
history: same commit count, order, parents, trees, messages, and **SHAs**.

### Sort order (fixed tie-breakers)

Each source CSV keeps commits in **git history order** (`git log --reverse`).
Before replay, the two source lists are **merged** (not globally re-sorted):
at each step compare the replay rank of the two list heads and take the
smaller; this preserves relative order within `ports/` and within
`ports-mingw/` while interleaving by timeline.

Replay rank keys, in order:

| Key | Order | Notes |
|-----|-------|-------|
| Committer date | ASC | Unix epoch seconds from upstream |
| Author date | ASC | Unix epoch seconds from upstream |
| Source id | ASC | `ports` before `ports-mingw` (lexicographic) |
| Upstream full SHA | ASC | Hex string compare |

Incremental sync uses the **same merge** over the pending slice only. Because
replay is strictly append-only and cursors record upstream SHAs, incremental
runs must match what a full rebuild would have produced at the same upstream
tips.

**Replay age gate (incremental only):** commits with committer date newer than
`replay.minReplayAgeMinutes` (default 5, matches poll interval) are held back.
This avoids replaying very fresh upstream commits before the cross-repo timeline
stabilizes. Bootstrap, rebuild, and verify replay all history regardless of age.

### Commit metadata (fixed for SHA stability)

| Field | Value |
|-------|-------|
| Author name/email | Copied from upstream (`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`) |
| Author date | Copied from upstream (`GIT_AUTHOR_DATE`, upstream author epoch) |
| Committer name/email | Copied from upstream (`GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`) |
| Committer date | Copied from upstream (`GIT_COMMITTER_DATE`, upstream committer epoch; never wall-clock `now()`) |

Author and committer fields are preserved **independently** from upstream.
Replayed commit SHAs depend on upstream author/committer metadata plus the
normalized message template and tree mapping.

### Commit message (normalized, byte-stable)

Always use this exact template (LF line endings only):

```
[<source-id>] <upstream subject>

<upstream body, unchanged>

Source: <upstream-repo>@<upstream-full-sha>
```

- `<source-id>`: `ports` or `ports-mingw`
- `<upstream-repo>`: `msys2/MSYS2-packages` or `msys2/MINGW-packages`
- Empty upstream body: omit the blank line before `Source:`
- Merge commits: use `git diff-tree` against **first parent** only

### Tree application (deterministic)

- Map paths with a prefix rewrite only; no file content mutation.
- Use `git read-tree` / index updates; do not rely on filesystem timestamps.
- Skip commits that produce an empty tree diff after mapping (advance cursor).
- Never create merge commits on destination; always linear history.

### Modes

| Mode | When | Behavior |
|------|------|----------|
| Bootstrap | First run | Reset `upstream` to `baseCommit`, then full replay |
| Incremental | Scheduled / poll | Append pending commits after cursors |
| **Rebuild** | Manual / periodic verify | Re-play full history from pinned upstream tips; must match manifest |

**Rebuild procedure** (`Sync-Rebuild.ps1` / `-Mode Rebuild`):

1. Read pinned upstream SHAs from `config/sync.json` or `-UpstreamPin` params
   (default: current upstream branch tips at fetch time; log them).
2. Reset branch `upstream` to `destination.baseCommit` (or create `upstream`
   pointing at base if missing). For verify-only, use `upstream-verify-<id>`.
3. Run the same replay loop as bootstrap with deterministic rules above.
4. Compute manifest (see below); compare to `state.json` `manifest` section.
5. On match: force-push `upstream` and update state.
6. On mismatch: fail; do not push (algorithm bug or upstream history rewrite).

### Replay manifest (verification)

Stored in `.sync/state.json` under `manifest`, updated after every
successful bootstrap/rebuild:

```json
"manifest": {
  "replaySpecVersion": 3,
  "upstreamPins": {
    "ports": "<full-sha>",
    "ports-mingw": "<full-sha>"
  },
  "commitCount": 0,
  "destinationTipSha": "<full-sha>",
  "treeRootSha": "<full-sha of ports/ + ports-mingw/ trees at tip>"
}
```

`Sync-Verify.ps1` rebuilds to a temp branch and checks `destinationTipSha` and
`commitCount` without pushing. Run after changing replay rules or before a
scheduled full rebuild.

### Upstream history rewrite

If `msys2/*` force-pushes, pinned SHAs may disappear. Recovery:

1. Human confirms new upstream tips.
2. Bump or reset cursors; update pins.
3. Run `-Mode Rebuild`; manifest will change (expected).
4. Record old manifest in `.sync/manifest-history/` for audit.

### Bootstrap vs incremental

| Mode | When | Behavior |
|------|------|----------|
| Bootstrap | First run / `Sync-Bootstrap` | Replay full history (slow; run locally or as a dedicated workflow) |
| Incremental | Every trigger after bootstrap | Replay only commits after stored cursors |
| Rebuild | Manual / verify job | Full deterministic replay; compare manifest before force-push |

Bootstrap for ~69k combined commits may take hours. Run once with progress
logging; incremental runs should finish in minutes.

## Trigger model (mirror + dispatch, hourly poll tolerance)

We cannot install webhooks or workflows on upstream `msys2/*` repos. Use **owned
mirror repos** for near-push triggers, plus **hourly poll** as a safety net.

```mermaid
flowchart TB
  subgraph upstream [Upstream read-only]
    UP1["msys2/MSYS2-packages"]
    UP2["msys2/MINGW-packages"]
  end

  subgraph mirrors [msys2-uwp mirrors]
    M1["MSYS2-packages-mirror"]
    M2["MINGW-packages-mirror"]
    MSYNC["mirror sync every 1-5 min"]
  end

  subgraph sync_repo [msys2-uwp-sync]
    DISP["repository_dispatch"]
    POLL["schedule: hourly + daily"]
    RUN["Sync-Incremental.ps1"]
  end

  subgraph dest [msys2-uwp/msys2-uwp]
    PUSH["push upstream branch"]
  end

  UP1 --> MSYNC --> M1
  UP2 --> MSYNC --> M2
  M1 -->|push| DISP
  M2 -->|push| DISP
  POLL --> RUN
  DISP --> RUN
  RUN --> PUSH
```

### Primary: mirror + repository_dispatch (~1-5 min)

Two mirror repos under `msys2-uwp`, each tracking upstream `master`:

| Mirror repo | Upstream source |
|-------------|-----------------|
| `msys2-uwp/MSYS2-packages-mirror` | `msys2/MSYS2-packages` |
| `msys2-uwp/MINGW-packages-mirror` | `msys2/MINGW-packages` |

**Mirror sync workflow** (in each mirror repo, every 1-5 minutes):

1. `git fetch` from upstream `msys2/*`
2. Fast-forward mirror `master` if upstream moved
3. On push to mirror `master`, send `repository_dispatch` to `msys2-uwp-sync`

**Sync workflow** (`sync-upstream.yml` in this repo) listens for:

```yaml
on:
  repository_dispatch:
    types:
      - upstream-updated
      - msys2-packages-updated
      - mingw-packages-updated
```

Typical latency: mirror sync interval (1-5 min) + dispatch + replay run.

Example mirror workflows: [docs/examples/mirror-sync.yml](examples/mirror-sync.yml),
[docs/examples/mirror-dispatch.yml](examples/mirror-dispatch.yml).

### Tolerance: hourly poll + daily reconciliation

Scheduled poll is a **fallback**, not the primary trigger:

| Schedule | Cron | Purpose |
|----------|------|---------|
| Hourly | `0 * * * *` | Catch missed dispatches (mirror down, token expiry, etc.) |
| Daily | `0 3 * * *` | Full gap check against upstream tips |

`pollIntervalMinutes` in `config/sync.json` is **60** (matches hourly poll).

Compare upstream `master` SHAs to `lastUpstreamCheck` in `.sync/state.json`.
If either SHA changed, run incremental replay. Use GitHub Actions `concurrency`
to cancel in-progress runs when a newer trigger arrives.

### Replay age gate (timeline stability)

Independent of trigger type: incremental replay only applies commits whose
**committer date** is at least `replay.minReplayAgeMinutes` old (default 5). This
prevents cross-repo timeline reorder when fresh commits arrive close together.
See **Deterministic replay** above.

### Secrets (mirror + sync)

| Secret | Where | Purpose |
|--------|-------|---------|
| `MSYS2_UWP_SYNC_TOKEN` | `msys2-uwp-sync` | Write to `msys2-uwp/msys2-uwp`; commit `.sync/state.json` |
| `SYNC_DISPATCH_TOKEN` | Both mirror repos | PAT with `repo` scope to dispatch `msys2-uwp-sync` workflows |

`SYNC_DISPATCH_TOKEN` needs permission to call
[`repository_dispatch`](https://docs.github.com/en/rest/repos/repos#create-a-repository-dispatch-event)
on `msys2-uwp/msys2-uwp-sync`. Can be the same PAT as `MSYS2_UWP_SYNC_TOKEN`
if org policy allows one shared bot token.

### Setup checklist (mirror phase)

1. Create `msys2-uwp/MSYS2-packages-mirror` and `msys2-uwp/MINGW-packages-mirror`.
2. Add mirror sync + dispatch workflows from `docs/examples/`.
3. Store `SYNC_DISPATCH_TOKEN` in both mirror repos.
4. Enable `repository_dispatch` trigger in `sync-upstream.yml` (done).
5. Keep hourly + daily cron as tolerance fallback.

## PowerShell script layout

```
scripts/
  Sync-Upstream.ps1       # Main entry: bootstrap or incremental
  Sync-Bootstrap.ps1      # Full history replay
  Sync-Rebuild.ps1        # Deterministic full rebuild + manifest check
  Sync-Verify.ps1         # Rebuild to temp branch; compare manifest only
  Sync-Incremental.ps1    # New commits only
  lib/
    Sync-Config.ps1       # URLs, paths, branch names
    Sync-State.ps1        # Read/write .sync/state.json (includes manifest)
    Sync-Git.ps1          # Remotes, fetch, replay helpers
    Sync-GitHub.ps1       # gh/API helpers for SHA checks
config/
  sync.json               # Default config (overridable by env)
.github/
  workflows/
    sync-upstream.yml     # dispatch + hourly/daily poll + manual
    sync-bootstrap.yml    # Manual-only long bootstrap
docs/
  examples/
    mirror-sync.yml       # Template: mirror repo fast-forward from upstream
    mirror-dispatch.yml   # Template: dispatch sync on mirror push
```

All scripts target **PowerShell 7+** (`#requires -Version 7.0`) and use only
cmdlets plus `git` / `gh` on PATH (no Windows-only APIs).

## GitHub Actions design

### `sync-upstream.yml`

- **Triggers**:
  - `repository_dispatch`: `upstream-updated`, `msys2-packages-updated`, `mingw-packages-updated`
  - `schedule: '0 * * * *'` (hourly tolerance poll)
  - `schedule: '0 3 * * *'` (daily reconciliation)
  - `workflow_dispatch`
- **Runner**: `ubuntu-latest` with `pwsh` (or `windows-latest`; prefer Ubuntu for git performance)
- **Concurrency**: `group: sync-upstream`, `cancel-in-progress: true`
- **Steps**:
  1. Checkout `msys2-uwp-sync`
  2. Install/verify `git`, `pwsh`, `gh`
  3. Clone `msys2-uwp/msys2-uwp` with credentials
  4. Run `scripts/Sync-Upstream.ps1 -Mode Incremental`
  5. Push `upstream` on destination if commits were replayed
  6. Commit and push `.sync/state.json` to this repo when cursors changed

### `sync-bootstrap.yml`

- **Trigger**: `workflow_dispatch` only (with confirmation input)
- Same as above but `-Mode Bootstrap`

### `sync-rebuild.yml`

- **Trigger**: `workflow_dispatch` only
- Runs `-Mode Rebuild`; compares manifest; force-pushes only on match

### `sync-verify.yml`

- **Trigger**: `schedule: weekly` and `workflow_dispatch`
- Runs `Sync-Verify.ps1`; opens issue on mismatch (no push)

### Secrets (org/repo settings)

| Secret | Purpose |
|--------|---------|
| `MSYS2_UWP_SYNC_TOKEN` | PAT or GitHub App token with `contents: write` on `msys2-uwp/msys2-uwp` and this repo |
| `SYNC_DISPATCH_TOKEN` | PAT for mirror repos to dispatch `msys2-uwp-sync` (see mirror phase above) |

`GITHUB_TOKEN` in this repo is sufficient for reading public upstream repos.

## State file (`.sync/state.json` in this repo)

Lives at the root of **msys2-uwp-sync**, committed to git. It is the sync
engine's checkpoint file, not part of the destination tree.

**What it tracks:**

| Field | Purpose |
|-------|---------|
| `sources.*.lastReplayedSha` | Last upstream commit replayed; incremental sync starts after this |
| `lastUpstreamCheck` | Tip SHA seen on last poll; detects new upstream pushes without replaying |
| `lastSyncAt` | ISO timestamp of last successful sync run |
| `manifest.destinationTipSha` | Tip SHA of destination `upstream` after last successful sync |
| `manifest.commitCount` | Commits on `upstream` since `baseCommit` (for verify/rebuild) |
| `manifest.treeRootSha` | Fingerprint of `ports/` + `ports-mingw/` at tip (for verify/rebuild) |
| `manifest.replaySpecVersion` | Algorithm version when manifest was recorded |

**Why it lives here:**

- Destination repo stays clean package history only.
- CI and local runs share one cursor via git (no orphan state on the runner).
- Failed runs leave the last committed cursor intact; the next run resumes safely.

```json
{
  "version": 2,
  "destination": {
    "branch": "upstream",
    "baseCommit": "6fc20894663468a04dd4986a8b1c15a9d5ae8649"
  },
  "sources": {
    "ports": {
      "repo": "msys2/MSYS2-packages",
      "branch": "master",
      "lastReplayedSha": null
    },
    "ports-mingw": {
      "repo": "msys2/MINGW-packages",
      "branch": "master",
      "lastReplayedSha": null
    }
  },
  "lastSyncAt": null,
  "lastUpstreamCheck": {
    "ports": null,
    "ports-mingw": null
  },
  "manifest": {
    "replaySpecVersion": 3,
    "upstreamPins": {
      "ports": null,
      "ports-mingw": null
    },
    "commitCount": 0,
    "destinationTipSha": null,
    "treeRootSha": null
  }
}
```

## Commit message convention (replayed commits)

See **Deterministic replay** above. Messages are fully normalized; do not
vary format between bootstrap, incremental, and rebuild runs.

## Error handling

| Situation | Action |
|-----------|--------|
| Empty tree change (merge commit / empty) | Skip replay, advance cursor |
| Replay failure mid-batch | Stop; do not push; leave branch consistent at last good commit |
| Push rejected (non-ff) | Fail workflow; require manual investigation |
| Rebuild manifest mismatch | Fail; do not push; investigate algorithm or upstream rewrite |
| Upstream force-push | Document recovery: reset cursor after human review |

## Implementation phases

### Phase 0 - Plan and rules (current)

- [x] `docs/PLAN.md`
- [x] Cursor rules under `.cursor/rules/`
- [x] `AGENTS.md` for agent context

### Phase 1 - Config and state library

- [x] `config/sync.json`
- [x] `scripts/lib/*.ps1` (config, state, git helpers)

### Phase 2 - Replay engine

- [x] `Sync-Bootstrap.ps1` with progress and resumable cursor
- [x] `Sync-Rebuild.ps1`, `Sync-Verify.ps1`
- [x] `Sync-Incremental.ps1`
- [x] `Sync-Upstream.ps1` dispatcher

### Phase 3 - GitHub Actions

- [x] `sync-upstream.yml` (dispatch + hourly/daily poll + manual)
- [x] `sync-bootstrap.yml` (manual)
- [x] `sync-rebuild.yml`, `sync-verify.yml` (manual + weekly verify)
- [ ] Wire secrets in `msys2-uwp` org

### Phase 3.5 - Mirror repos + dispatch

- [ ] Create `msys2-uwp/MSYS2-packages-mirror` and `msys2-uwp/MINGW-packages-mirror`
- [ ] Deploy `docs/examples/mirror-sync.yml` (upstream fast-forward every 5 min)
- [ ] Deploy `docs/examples/mirror-dispatch.yml` (dispatch on mirror push)
- [ ] Store `SYNC_DISPATCH_TOKEN` in both mirror repos
- [ ] Verify end-to-end: upstream push -> mirror -> dispatch -> replay (~1-5 min)

### Phase 4 - Initial bootstrap

- [ ] Run bootstrap locally or via manual workflow
- [ ] Verify `upstream` branch on `msys2-uwp/msys2-uwp`
- [ ] Enable scheduled incremental sync

## Open decisions

1. **Bootstrap location**: local machine vs self-hosted runner (large clone/time).
2. **Default branch on `msys2-uwp`**: keep `main` empty until UWP work starts, or make `upstream` default?
3. **Weekly verify schedule**: day/time for `sync-verify.yml` cron.
4. **Mirror sync interval**: 1 min vs 5 min (trade GitHub Actions minutes vs latency).

## Local development

```powershell
# Clone both repos
git clone https://github.com/msys2-uwp/msys2-uwp-sync.git  # adjust remote
cd msys2-uwp-sync

# Dry run (no push)
./scripts/Sync-Upstream.ps1 -Mode Incremental -DestinationPath ../msys2-uwp -DryRun
```

Requires: PowerShell 7+, Git 2.30+, optional `gh` for API checks.
