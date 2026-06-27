# mirror-init (Block 1)

Operator workflow for **`yarn mirror-init`**. Pipeline blocks and CI:
[`plan-workflow.md`](plan-workflow.md). Commands and secrets: [`usage.md`](usage.md).
New mirror: [`add-mirror.md`](add-mirror.md).

Code: `src/mirror-init/`.

## Command

```bash
yarn mirror-init [--repo <name>] [--skip-fetch] [--push]
```

| Flag | Purpose |
|------|---------|
| `--repo <name>` | Single mirror from `config/sync.json` `Mirrors.Repos` |
| `--skip-fetch` | Skip `git fetch origin` during ensure-init |
| `--push` | Push to GitHub, dispatch Block 3, restore default branch (per repo) |

Examples:

```bash
yarn mirror-init --repo glibc
yarn mirror-init --repo glibc --push
yarn mirror-init --push
```

Requires `gh auth login` when using `--push`.

## What Block 1 installs

| Target | Branch | Files |
|--------|--------|-------|
| Each `msys2-apiss/*` mirror repo | **`msys2-apiss-mirror-sync`** | `.github/workflows/mirror-sync.yml`, `.github/mirror-sync.json`, toolings |
| Tooling repo `msys2-apiss/msys2-apiss-sync` | **`msys2-apiss-mirror-merge`** | `.github/workflows/mirror-merge.yml` |

**Content branch** (`master` or `Branches[].Mirror` in `config/mirror-sync/<repo>.json`):
pure upstream mirror; **no workflow files**.

Local working copy: `.work/mirrors/<repo>/`.

The **`msys2-apiss-mirror-sync`** tip must be a **single commit** whose **parent is the
first commit of the content branch**. `yarn fix-mirror-sync` repairs layout.

Templates: [`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml),
`config/mirror-sync/<repo>.json`. Block 1 copies into each mirror when they differ.

## Plain init (no `--push`)

For each repo in scope:

1. Detect/repair local state (none, broken, incomplete, complete).
2. Fetch origin (unless `--skip-fetch`).
3. Apply Block 3 templates on **`msys2-apiss-mirror-sync`** when they differ.
4. Install/update Block 4 `mirror-merge.yml` on **`msys2-apiss-mirror-merge`**.

No GitHub push. No Block 3 dispatch. Use `yarn mirror-poll` or CI cron later.

### Local working copy states

| State | Detection | Action |
|-------|-----------|--------|
| **None** | No `.work/mirrors/<repo>/` | Clone origin if non-empty; else bootstrap from upstream root |
| **Broken** | Invalid git repo (no HEAD, bare clone) | Remove and re-init from **None** |
| **Incomplete** | Missing sync branch or invalid layout | Fetch; bootstrap **`msys2-apiss-mirror-sync`**; apply templates |
| **Complete** | Content + valid sync branch | Fetch; apply templates when differ; ready for **`--push`** |

Origin on GitHub is checked separately (`mirrorOriginHasContent`): empty origin uses
upstream bootstrap; non-empty origin uses clone or fetch.

**Reuse local clone:** do not delete `.work/mirrors/<repo>` when only the sync branch is
missing; bootstrap in place. Complete clones are reused without recloning.

**Large mirrors (gcc):** `PushViaSsh` in mirror config; ensure-init reuses complete clones
when possible.

## `--push` workflow (per mirror repo)

For **each repo** in scope (one with `--repo`, or every entry in `Mirrors.Repos`
without it), in order:

### 1. Prepare and push

- Ensure GitHub repo exists (`gh repo create` when origin is empty).
- Push **content branch** to `origin`.
- Push **`msys2-apiss-mirror-sync`** to `origin`.

### 2. Default branch (when needed)

If GitHub has not registered `mirror-sync.yml` on **`msys2-apiss-mirror-sync`**
(for example first bootstrap), temporarily set the repo **default branch** to
**`msys2-apiss-mirror-sync`**.

### 3. Dispatch Block 3 (always)

After the sync branch is on origin, **always** dispatch mirror-sync (no tip comparison):

```bash
gh workflow run mirror-sync.yml \
  --repo msys2-apiss/<repo> \
  --ref msys2-apiss-mirror-sync \
  -f event_type=workflow_dispatch_mirror_sync
```

- Does **not** wait for the run to finish.
- Skip dispatch only when a `mirror-sync` run is already in progress on that repo.

### 4. Restore default branch (always)

Set default branch back to the **content branch** after dispatch, whether dispatch
succeeded, was skipped, or failed.

### End of run

After all mirrors in scope: install/update Block 4 CI on tooling branch
**`msys2-apiss-mirror-merge`** (push when **`--push`**).

## Manual equivalent (one repo)

After pushing content + sync branches locally:

```bash
gh api repos/msys2-apiss/<repo> -X PATCH -f default_branch=msys2-apiss-mirror-sync
gh workflow run mirror-sync.yml --repo msys2-apiss/<repo> --ref msys2-apiss-mirror-sync \
  -f event_type=workflow_dispatch_mirror_sync
gh api repos/msys2-apiss/<repo> -X PATCH -f default_branch=master
```

Replace `master` with the configured content branch when different.

## Related

- [`plan-workflow.md`](plan-workflow.md) -- Blocks 2-4 and pipeline map
- [`add-mirror.md`](add-mirror.md) -- add a new mirror
- [`usage.md`](usage.md) -- secrets and run commands
