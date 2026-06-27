# Mirror-init and mirror-poll plan (msys2-apiss-sync)

Manage **msys2-apiss/** mirror repositories from **this repo** (`msys2-apiss-sync`).

Covers **Blocks 1-3** (init -> poll -> mirror-sync). Block 4 mirror-merge:
[`plan-sync-merge.md`](plan-sync-merge.md).

**Entry point:** a **local checkout** of `msys2-apiss/msys2-apiss-sync`. All operator
commands (`yarn mirror-init`, `yarn mirror-poll`, `yarn mirror-merge`) run from here.

| Entry | Where it runs | Block |
|-------|---------------|-------|
| **`mirror-init`** | **Tooling repo** local checkout | **1** -- init mirrors; copy Block 3 templates to mirror branch **`msys2-apiss-mirror-sync`**; copy Block 4 `mirror-merge.yml` to tooling branch **`msys2-apiss-mirror-merge`**. With **`--push`**: push then trigger Block 2 |
| **`mirror-poll`** | Tooling repo local checkout or CI cron | **2** -- poll only; triggers Block 3 on **mirror repos** |
| **`mirror-sync.yml`** | **Each `msys2-apiss/*` mirror repo** | **3** -- installed by Block 1; fetch upstream, push `master`; package mirrors dispatch Block 4 CI |

Block order: **1 mirror-init -> 2 mirror-poll -> 3 mirror-sync -> 4 mirror-merge**. Block 1 copies
[`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) onto mirror branch
**`msys2-apiss-mirror-sync`** on each mirror repo and
[`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) onto tooling branch
**`msys2-apiss-mirror-merge`**. Block 2 triggers Block 3 on mirror repos (ref
**`msys2-apiss-mirror-sync`**). Block 3 package mirrors dispatch Block 4 CI on the
tooling repo (ref **`msys2-apiss-mirror-merge`**).

Each mirror's `UpstreamUrl` in `config/mirror-sync/*.json` may point at `msys2/*`,
SourceForge, sourceware, etc. -- upstream is **config only**, not a workflow actor.

**Center design (blocks, repos, CI):** [`plan-workflow.md`](plan-workflow.md).

Checklist for new mirrors: [`add-mirror.md`](add-mirror.md). Ops: [`usage.md`](usage.md).

---

## Scope

| In scope | Out of scope |
|----------|----------------|
| [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on tooling `main` (Block 2) | Block 4 algorithm detail (see plan-sync-merge.md) |
| Block 3 on each **`msys2-apiss/*` mirror repo** (installed by Block 1) | Block 3 workflow on tooling repo (template only) |
| Block 4 [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on tooling branch **`msys2-apiss-mirror-merge`** (installed by Block 1) | Workflows on mirror content branches (`master`) |
| `yarn mirror-init` / `fetch-mirrors` -- tooling repo local checkout (Block 1) | |
| `yarn mirror-poll` -- direct Block 2 poll (no init) | |
| `yarn fix-mirror-sync` | |
| `config/mirror-sync/*.json` | |

Workflows on mirror branch `msys2-apiss-mirror-sync` and tooling branch `msys2-apiss-mirror-merge`
only; mirror content branches stay pure upstream.

---

## Tooling repo layout (Block 4 CI target)

On **`msys2-apiss/msys2-apiss-sync`** (tooling repo):

| Branch | Role |
|--------|------|
| `main` | TypeScript, config, templates; Block 2 [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) |
| `msys2-apiss-mirror-merge` | Block 4 CI: `.github/workflows/mirror-merge.yml` only (installed by Block 1) |

Block 1 copies [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) from template
onto branch `msys2-apiss-mirror-merge` and pushes to origin (same install pattern as Block 3
on mirror repos). Block 3 package mirrors dispatch this workflow via `workflow_dispatch_mirror_merge`.

---

## Blocks 1-2 entry points (from local checkout)

| Block | Step | Command |
|-------|------|---------|
| **1** | Init (first) | `yarn mirror-init` / `yarn fetch-mirrors` |
| **2** | Poll (standalone or after `--push`) | `yarn mirror-poll`; [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml); **`yarn mirror-init --push`** |

| Command | Role |
|---------|------|
| **`yarn mirror-init`** | Block 1 only: ensure `.work/mirrors/<repo>/`; apply/copy Block 3 templates to mirror (no poll) |
| **`yarn mirror-init --push [--repo <name>]`** | Block 1: push mirror branch + content to **mirror repo** on GitHub; **then Block 2 poll** |
| **`yarn mirror-poll`** | Block 2 only (skip Block 1): compare tips; dispatch Block 3 when behind |

**Naming:** `mirror-init` replaces `fetch-mirrors` (clearer: init/update local mirror
working copies, not "fetch" in the git sense). During migration keep
`fetch-mirrors` as a yarn script alias until callers and docs are updated.

Block 1 runs from the **local checkout** (init/repair/templates only). Block 2 runs via
**`yarn mirror-poll`**, **`mirror-poll.yml`** cron, or **`yarn mirror-init --push`**
(after push). Mirror sync always happens in Block 3, never in Block 1.

Block map and operator flows: [`plan-workflow.md`](plan-workflow.md).

---

## Mirror repo layout (Block 3 target)

Each **`msys2-apiss/*` mirror repo** (not the tooling repo):

| Branch | Role |
|--------|------|
| `master` (or `Branches[].Mirror`) | Pure upstream mirror; fast-forward only; **no workflow files** |
| `msys2-apiss-mirror-sync` | Mirror branch: `.github/workflows/mirror-sync.yml` + `.github/mirror-sync.json` (single config commit; parent = first commit of content branch) |

**Template source (tooling repo only):** canonical config at
`config/mirror-sync/<repo>.json` and workflow at
[`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml).
Block 1 (`applyMirrorSyncTemplate`) copies these into each mirror's local working copy
under `.work/mirrors/<repo>/` when they differ, then `--push` pushes to the mirror repo.

The `msys2-apiss-mirror-sync` branch parent must be the first commit of the content branch
(single config commit). `yarn fix-mirror-sync` repairs layout.

---

## Mirror-sync behavior (Block 3 -- on each mirror repo)

Block 3 runs on **each `msys2-apiss/*` mirror repo**, not on the tooling repo.
Block 1 installs the workflow from the tooling template; Block 2 triggers it.

Canonical template: [`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) in
**tooling repo**. Deployed copy on each mirror repo, mirror branch `msys2-apiss-mirror-sync`.
Only Block 3 runs these sync steps. Block 2 poll triggers Block 3 via
`workflow_dispatch_mirror_sync` on **that mirror repo** when tips differ.
Block 1 never runs mirror-sync; it copies templates. Block 2 poll (not plain
`mirror-init`) triggers Block 3.

For each `Branches[]` entry in mirror config:

1. Ensure `upstream` remote = `UpstreamUrl`
2. `git fetch upstream <UpstreamBranch>`
3. Compare `upstream/<UpstreamBranch>` with `origin/<MirrorBranch>`
4. If different: `git push origin upstream/...:refs/heads/<MirrorBranch>` (retries; SSH if `PushViaSsh`)
5. If `SyncTags` (default true): fetch and push tags

Block 3 ends after mirror `master` push. **Package mirrors** with `Notify.Enabled` dispatch
Block 4 CI on tooling repo ([`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml)
on branch `msys2-apiss-mirror-merge`). Local Block 4: `yarn mirror-merge`; see
[`plan-sync-merge.md`](plan-sync-merge.md).

**Reuse local clone:** do not delete `.work/mirrors/<repo>` when only `msys2-apiss-mirror-sync`
is missing; bootstrap sync branch in place (see `repos.ts`). Broken copies are removed
and re-initialized; complete clones are reused without recloning.

**Hard errors:** broken working copy (no valid HEAD), missing config, push failure after
retries, `gh` not authenticated when notify required.

---

## mirror-init details (Block 1)

CLI: `src/cli/fetch-mirrors.ts` (rename to `mirror-init.ts` in Phase 1).

Block 1 must not assume a local clone already exists. `mirror-init` detects the
working copy state under `.work/mirrors/<repo>/`, repairs or bootstraps, copies Block 3
templates (`mirror-sync.yml`, `mirror-sync.json`) via `applyMirrorSyncTemplate`; install
Block 4 [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on tooling branch
`msys2-apiss-mirror-merge`. With **`--push`**: push branches, then invoke Block 2 poll
(`runMirrorPoll`, scoped by `--repo` when set).

**Branches installed by Block 1:**

| Target | Branch | Files |
|--------|--------|-------|
| Each `msys2-apiss/*` mirror repo (Block 3) | **`msys2-apiss-mirror-sync`** | `.github/workflows/mirror-sync.yml`, `.github/mirror-sync.json` |
| Tooling repo `msys2-apiss/msys2-apiss-sync` (Block 4 CI) | **`msys2-apiss-mirror-merge`** | `.github/workflows/mirror-merge.yml` |

Block 3 runs only on mirror branch **`msys2-apiss-mirror-sync`**; mirror content branch
(`master`) stays workflow-free.

| Flag | Purpose |
|------|---------|
| `--push` | Push content + `msys2-apiss-mirror-sync` branch to origin, then Block 2 poll |
| `--repo <name>` | Single mirror from `Mirrors.Repos` |
| `--skip-fetch` | Optional: skip `git fetch origin` during ensure-init |

### Local working copy states (Block 1)

| State | Detection | Action |
|-------|-----------|--------|
| **None** | No `.work/mirrors/<repo>/` | If GitHub origin has content branch or `msys2-apiss-mirror-sync`: clone origin. If origin empty: `git init`, fetch upstream root only, create content + sync branches |
| **Broken** | Path exists but not a valid working copy (no `.git`, bare clone, no HEAD) | Remove directory and re-run ensure-init from **None** |
| **Incomplete** | Valid git repo but missing `msys2-apiss-mirror-sync`, invalid sync-branch layout, or missing origin refs | `git fetch origin` (unless `--skip-fetch`); bootstrap local `msys2-apiss-mirror-sync` from first commit of content branch; repair layout; apply config template |
| **Complete** | Content branch + valid `msys2-apiss-mirror-sync` layout | Fetch origin (unless `--skip-fetch`); apply config when template differs; ready for `--push` |

Origin on GitHub is checked separately (`mirrorOriginHasContent`): empty origin uses
upstream bootstrap; non-empty origin uses clone or fetch.

After ensure-init, call Block 2 poll **only with `--push`** (replace direct
`startMirrorSyncAfterPush` dispatch): push branches to origin first, then `runMirrorPoll`.
Without `--push`, Block 1 stops after local repair/template apply; run
`yarn mirror-poll` or wait for CI cron to trigger Block 3. `yarn fix-mirror-sync` remains
for layout-only repair without poll.

**New empty mirror:** `ensureGhMirrorRepo`, bootstrap content root, push `master` +
`msys2-apiss-mirror-sync`, then Block 2 poll -> Block 3.

**Large mirrors (gcc):** `PushViaSsh` uses local deploy key / `git@github.com` push URL;
ensure-init reuses a complete local clone instead of recloning when possible.

---

## mirror-poll details (Block 2 -- poll or triggered by `--push`)

**Role:** poll only. Compare tips; trigger Block 3 when a mirror is behind. Runs from
**local checkout**, **CI cron**, or **`yarn mirror-init --push`** (after push).

**GitHub Actions:** [`.github/workflows/mirror-poll.yml`](../.github/workflows/mirror-poll.yml)
on **`msys2-apiss/msys2-apiss-sync`**.

| Item | Value |
|------|--------|
| Triggers | **`yarn mirror-poll`**; CI cron / `workflow_dispatch_mirror_sync` on [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml); **`yarn mirror-init --push`** (after push, respects `--repo`) |
| Runs | `node src/cli/mirror-poll.ts` (sparse checkout `config/` + `src/`) |
| Code | `src/cli/mirror-poll.ts`, `src/lib/mirror-poll.ts` |

**Direct Block 2:** `yarn mirror-poll` on an operator checkout (poll only, no init).

**Via Block 1:** only **`yarn mirror-init --push`** ends with Block 2 poll (respects
`--repo`). Plain `yarn mirror-init` does not poll.

Uses `mirrorRepoNeedsSync`: read mirror `<MirrorBranch>` tip via GitHub API and
upstream `<UpstreamBranch>` tip via `git ls-remote` on `UpstreamUrl`; no local
upstream fetch. When SHAs differ, dispatch Block 3
[`mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) on that mirror repo
(same as manual `gh workflow run mirror-sync.yml --ref msys2-apiss-mirror-sync`).

Keep: workflow registration bootstrap on mirror repos when dispatch fails (404),
in-progress run skip, default-branch dance for first dispatch.

---

## What to remove / keep

| Item | Action |
|------|--------|
| [`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) | **Keep** in tooling repo (Block 3 template; Block 1 copies to mirror repos) |
| Block 3 workflow on each mirror repo's `msys2-apiss-mirror-sync` branch | **Keep** (installed by Block 1) |
| `ghDispatchMirrorSyncWorkflow`, workflow registration helpers | **Keep** (Block 2 -> Block 3) |
| Mirror repo secrets | **Keep** `SYNC_DISPATCH_TOKEN`, `MIRROR_PUSH_SSH_KEY` for Block 3 |
| Tooling repo secret | **Keep** `SYNC_DISPATCH_TOKEN` on `msys2-apiss-sync` for Block 2 [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) |
| [`mirror-merge.yml`](../config/mirror-template/mirror-merge.yml) on tooling branch **`msys2-apiss-mirror-merge`** | **Keep** (Block 4 CI; installed by Block 1) |
| [`mirror-poll.yml`](../.github/workflows/mirror-poll.yml) on tooling `main` | **Keep** (Block 2) |

---

## Mirror list (reference)

| Mirror | UpstreamUrl (config) | Feeds mirror-merge |
|--------|----------------------|------------------|
| `msys2-apiss/MSYS2-packages` | `msys2/MSYS2-packages` | yes (`ports/`) |
| `msys2-apiss/MINGW-packages` | `msys2/MINGW-packages` | yes (`ports-mingw/`) |
| `msys2-apiss/mingw-w64` | SourceForge mingw-w64 | no |
| `msys2-apiss/glibc` | sourceware glibc | no |
| Others in `Mirrors.Repos` | per `config/mirror-sync/*.json` | per `Notify.Enabled` |

Package mirrors feed Block 4 mirror-merge; others do not. After Blocks 1-3, run Block 4 from
the same **`msys2-apiss-sync`** checkout (`yarn mirror-merge --skip-fetch`).

---

## Implementation phases

### Phase 1 -- Wire Block 1 `--push` -> Block 2

- `mirror-init --push`: push branches to origin, then `runMirrorPoll` (scoped by `--repo`)
- Plain `mirror-init`: no poll; operator uses `yarn mirror-poll` or CI cron
- Block 2 continues dispatching Block 3 when SHAs differ

### Phase 2 -- Config, templates, Block 4 workflow branch

- `applyMirrorSyncTemplate`: workflow yml + JSON on mirror `msys2-apiss-mirror-sync`
- Install `mirror-merge.yml` on tooling branch `msys2-apiss-mirror-merge`
- Ensure `config/mirror-sync/*.json` stays canonical

### Phase 3 -- Rename and docs

- Rename yarn script `fetch-mirrors` -> `mirror-init` (keep alias)
- Rename `src/cli/fetch-mirrors.ts` -> `mirror-init.ts`
- Update [`usage.md`](usage.md), [`add-mirror.md`](add-mirror.md), rules, AGENTS.md

### Phase 4 -- Tests

- `mirror-poll.test.ts` / `mirror-init` tests for `--push` triggers Block 2

---

## Operational model

All commands below run from a **local checkout** of `msys2-apiss/msys2-apiss-sync`.

| Task | Command |
|------|---------|
| Init + push + poll (Block 1 -> Block 2) | `yarn mirror-init --push [--repo <name>]` |
| Init only (Block 1) | `yarn mirror-init [--repo <name>]` |
| Poll only (Block 2) | `yarn mirror-poll` |
| Scheduled poll (CI, no local machine) | `mirror-poll.yml` on GitHub |
| Mirror-merge CI (Block 4) | `workflow_dispatch_mirror_merge` from Block 3 or `gh workflow run mirror-merge.yml --repo msys2-apiss/msys2-apiss-sync --ref msys2-apiss-mirror-merge` |
| Mirror-merge local (Block 4) | `yarn mirror-merge [--skip-fetch]` |
| Fix config branch layout | `yarn fix-mirror-sync [--skip-fetch] [--push]` |
| Block 3 direct (bypass poll) | `gh workflow run mirror-sync.yml --repo msys2-apiss/<name> --ref msys2-apiss-mirror-sync` |
