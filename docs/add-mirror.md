# Add a mirror

Checklist for adding a new `msys2-apiss/*` mirror repo. Use this doc when asked to
add a mirror; do not invent a GitHub Actions bootstrap workflow in this repo.

Local clones are **working copies** under `.work/mirrors/<repo>/`, checked out on
branch **`sync`**, so you can edit the mirror-sync workflow and squash before push.

Design: [`PLAN.md`](PLAN.md). Mirror templates: [`config/mirror-template/`](../config/mirror-template/).
Ops: [`usage.md`](usage.md).

## Branch layout

Every mirror repo uses two branches:

| Branch | Role |
|--------|------|
| `sync` (default on GitHub) | Local working copy branch; **exactly one commit** with `.github/workflows/mirror-sync.yml` and `.github/mirror-sync.json` only |
| `master` (or first `Branches[].Mirror` in config) | Pure upstream mirror; no workflow files |

The `sync` branch tip must be a **single commit** whose **parent is the first
commit** of the first synced mirror branch (usually `origin/master` root):

```text
A = first commit of master
A <- S = sync tip (workflow/config only)
A <- ... <- master tip
```

`yarn fetch-mirrors` always checks out `sync` and warns if the layout differs.
Rebuild `sync` locally:

```bash
ROOT=$(git -C .work/mirrors/my-tool rev-list --max-parents=0 origin/master)
git -C .work/mirrors/my-tool checkout -B sync "$ROOT"
# applied by yarn fetch-mirrors from config/mirror-sync/*.json and
# config/mirror-template/mirror-sync.yml
git -C .work/mirrors/my-tool add .github
git -C .work/mirrors/my-tool commit \
  -m "Mirror sync workflow from msys2-apiss-sync" \
  -m "https://github.com/msys2-apiss/msys2-apiss-sync/tree/main/config/mirror-sync
https://github.com/msys2-apiss/msys2-apiss-sync/blob/main/config/mirror-template/mirror-sync.yml"
git -C .work/mirrors/my-tool push --force-with-lease origin sync
```

Replay and mirror tips still read **`origin/master`** (or the configured mirror
branch); local edits on `sync` do not affect replay until pushed.

### Auto-repair `sync` layout

`yarn fetch-mirrors` repairs invalid `sync` branches (single commit on the mirror-branch
root) and applies `config/mirror-sync/` templates only when they differ from the
mirror working copy.

After editing `.github/` locally on `sync`:

```bash
yarn fix-mirror-sync --skip-fetch --repo glibc
yarn fix-mirror-sync --skip-fetch --repo glibc --push
```

| Flag | Purpose |
|------|---------|
| `--repo <name>` | One mirror (default: all in `config/sync.json`) |
| `--skip-fetch` | Keep local `.github/` edits; do not reset to `origin/sync` |
| `--push` | Push repaired `sync` to GitHub (`--force-with-lease`) |
| `--force` | Re-squash `sync` even when layout is already valid |
| `--message <text>` | Commit message (default: subject + links to [config/mirror-sync](https://github.com/msys2-apiss/msys2-apiss-sync/tree/main/config/mirror-sync) and [mirror-sync.yml](https://github.com/msys2-apiss/msys2-apiss-sync/blob/main/config/mirror-template/mirror-sync.yml)) |

## Local mirror path

All mirrors live here (gitignored):

```text
.work/mirrors/<repo-name>/
```

Examples:

| GitHub repo | Local working copy |
|-------------|-------------------|
| `msys2-apiss/MSYS2-packages` | `.work/mirrors/MSYS2-packages` |
| `msys2-apiss/MINGW-packages` | `.work/mirrors/MINGW-packages` |
| `msys2-apiss/mingw-w64` | `.work/mirrors/mingw-w64` |
| `msys2-apiss/glibc` | `.work/mirrors/glibc` |

Per-mirror JSON configs live in **`config/mirror-sync/<repo-name>.json`** (canonical
source). `yarn fetch-mirrors` copies templates to `.work/mirrors/<repo>/.github/`
on branch **`sync`** only when files differ or the branch layout is invalid.

Example: `config/mirror-sync/MINGW-packages.json` for `msys2-apiss/MINGW-packages`.

```bash
yarn fetch-mirrors
yarn fetch-mirrors --skip-fetch   # re-apply when config/mirror-sync/*.json changed
yarn fetch-mirrors --skip-fetch --push-sync   # apply and push sync when local differs from origin
```

## Mirror-only vs package mirror

| Kind | Replay into `msys2-apiss` | Registration |
|------|---------------------------|----------------|
| Package mirror | yes (`ports/` or `ports-mingw/`) | `Sources.*` + name in `Mirrors.Repos` + `config/mirror-sync/<repo>.json` |
| Mirror-only | no | entry in `Mirrors.Repos` + `config/mirror-sync/<repo>.json` |

Use mirror-only for upstream repos that are mirrored on GitHub but not replayed
into the destination (e.g. `mingw-w64`, `glibc`).

## Steps: mirror-only repo

### 1. Add `config/mirror-sync/<repo-name>.json`

Create `config/mirror-sync/my-tool.json` (copy from `glibc.json` or
`mingw-w64.json` and edit):

```json
{
  "UpstreamUrl": "https://example.com/upstream.git",
  "Url": "https://example.com/upstream",
  "Description": "My upstream tool",
  "Branches": [{ "Upstream": "master", "Mirror": "master" }],
  "Notify": { "Enabled": false }
}
```

Register the repo name in `config/sync.json` `Mirrors.Repos`:

```json
"Mirrors": {
  "Repos": [
    "MSYS2-packages",
    "MINGW-packages",
    "my-tool"
  ],
  "SyncIntervalMinutes": 15,
  "DispatchEventType": "upstream-updated"
}
```

Top-level `"Owner": "msys2-apiss"` applies to all mirror repos and the destination.

All mirror metadata (`UpstreamUrl`, `Url`, `Description`, branches, notify)
lives in `config/mirror-sync/<repo-name>.json` only.

### 2. Bootstrap on GitHub

Run (creates the GitHub repo with `gh` when missing, pushes content root +
`sync`, registers workflow, runs first sync, restores default branch):

```bash
yarn fetch-mirrors --repo my-tool --push-sync
```

This fetches upstream commit graph blob:none, checks out the root commit only
locally, pushes that as `master`/`main`, pushes `sync`, triggers `mirror-sync`
on GitHub (full upstream fetch happens in CI), then sets default back to the
content branch without waiting for the run to finish.

Later, `yarn fetch-mirrors` clones into `.work/mirrors/my-tool/` on branch
**`sync`** and applies `config/mirror-sync/my-tool.json` when templates differ.

Re-push workflow templates after config edits:

```bash
yarn fetch-mirrors --skip-fetch --push-sync
```

On first bootstrap, `--push-sync` temporarily sets default branch to `sync` so
GitHub registers `mirror-sync.yml`, triggers mirror-sync, then immediately sets
default back to the content branch (`master` or configured mirror branch). It
does not wait for the run to finish. Later `--push-sync` and `mirror-poll`
dispatch on ref `sync` when the repo already has Actions and default branch is
the content branch.

Or manually:

```bash
# after pushing content root + sync locally
gh api repos/msys2-apiss/my-tool -X PATCH -f default_branch=sync
gh workflow run mirror-sync.yml --repo msys2-apiss/my-tool --ref sync
gh run watch --repo msys2-apiss/my-tool $(gh run list --repo msys2-apiss/my-tool --workflow mirror-sync.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh api repos/msys2-apiss/my-tool -X PATCH -f default_branch=master
```

Mirror-only repos do not need remote secrets. Package mirrors with
`Notify.Enabled: true` need `SYNC_DISPATCH_TOKEN` on the mirror repo (see
[`usage.md`](usage.md)). Repos with `PushViaSsh` true need `MIRROR_PUSH_SSH_KEY`.
Set secrets with `gh secret set` on each mirror repo.

Or squash local `.github/` edits without re-fetching templates:

```bash
yarn fix-mirror-sync --skip-fetch --repo my-tool --push
```

Remove manual copy steps for templates; edit `config/mirror-sync/*.json` in
msys2-apiss-sync, re-run `yarn fetch-mirrors --skip-fetch --push-sync`.

`mirror-poll.yml` on `msys2-apiss-sync` picks up any repo listed in
`Mirrors.Repos`.

### 3. Local squash / workflow edits

Work in `.work/mirrors/my-tool/` (already on **`sync`** after `yarn fetch-mirrors`):

```bash
# edit .github/workflows/mirror-sync.yml or .github/mirror-sync.json
yarn fix-mirror-sync --skip-fetch --repo my-tool
yarn fix-mirror-sync --skip-fetch --repo my-tool --push
```

`fix-mirror-sync` squashes `.github/` into one commit whose parent is the first
commit of `origin/master`. Use `--push` when ready for GitHub.

## Steps: package mirror (replay)

Package mirrors already exist for `MSYS2-packages` and `MINGW-packages`. Adding
another replayed source requires a `Sources.*` entry, destination path mapping,
and replay code changes -- see [`PLAN.md`](PLAN.md). For those mirrors, the local
path is still `.work/mirrors/<repo>/`.

Use `Notify.Enabled: true` in `config/mirror-sync/<repo>.json` and set
`SYNC_DISPATCH_TOKEN` on the mirror repo with `gh secret set`. That secret is
used for `repository_dispatch` to `msys2-apiss-sync` after mirror-sync advances
content.

## Verify

```bash
yarn fetch-mirrors
yarn test tests/sync/config.test.ts
```

Expect log lines like:

```text
[sync] mingw-w64 mirror: .work/mirrors/mingw-w64 (sync = abc12345, master = def67890)
```

Check remote tip:

```bash
git -C .work/mirrors/my-tool rev-parse origin/master
```

## Related

- [`apply-patches-usage.md`](apply-patches-usage.md) -- apply mapped commits from
  package mirrors into a destination branch
- [`config/mirror-template/mirror-sync.yml`](../config/mirror-template/mirror-sync.yml) -- shared
  workflow installed on each mirror `sync` branch
