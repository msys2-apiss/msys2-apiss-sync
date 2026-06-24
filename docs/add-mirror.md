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
git -C .work/mirrors/my-tool commit -m "Mirror sync workflow"
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
| `--message <text>` | Commit message (default: previous `sync` tip subject) |

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

| Kind | Replay into `msys2-apiss` | `config/sync.json` |
|------|---------------------------|-------------------|
| Package mirror | yes (`ports/` or `ports-mingw/`) | `Sources.*` + `Mirrors.Ports` / `Mirrors.PortsMingw` |
| Mirror-only | no | `Mirrors.<Key>` + `MirrorOnly.<Key>` |

Use mirror-only for upstream repos that are mirrored on GitHub but not replayed
into the destination (e.g. `mingw-w64`, `glibc`).

## Steps: mirror-only repo

### 1. Add `config/mirror-sync/<repo-name>.json`

Create `config/mirror-sync/my-tool.json` (copy from `glibc.json` or
`mingw-w64.json` and edit):

```json
{
  "UpstreamUrl": "https://example.com/upstream.git",
  "Branches": [{ "Upstream": "master", "Mirror": "master" }],
  "Notify": { "Enabled": false }
}
```

Register the repo in `config/sync.json` (`Mirrors` + `MirrorOnly`). Example
`MirrorOnly` entry still needs `UpstreamUrl` and `Branch` for this repo's
fetch/poll metadata:

```json
"Mirrors": { "MyTool": "my-tool" },
"MirrorOnly": {
  "MyTool": {
    "UpstreamUrl": "https://example.com/upstream.git",
    "Branch": "master"
  }
}
```

### 2. Create GitHub mirror repo

1. Create empty repo `msys2-apiss/my-tool` on GitHub.
2. Clone locally into the standard path (or let `yarn fetch-mirrors` create it
   after the empty repo exists and has at least one push, or clone manually):

```bash
yarn fetch-mirrors
```

3. `yarn fetch-mirrors` clones into `.work/mirrors/my-tool/` on branch **`sync`**
   and applies `config/mirror-sync/my-tool.json`.

4. Push `sync` when ready:

```bash
yarn fetch-mirrors --skip-fetch --push-sync
```

Set repo secret `SYNC_DISPATCH_TOKEN` on every mirror (see [`usage.md`](usage.md)).
Required when upstream has `.github/workflows/*` (e.g. mingw-w64). Optional on
mirror-only repos whose upstream has no workflow files (e.g. glibc).

Or squash local `.github/` edits without re-fetching templates:

```bash
yarn fix-mirror-sync --skip-fetch --repo my-tool --push
```

Remove manual copy steps for templates; edit `config/mirror-sync/*.json` in
msys2-apiss-sync, re-run `yarn fetch-mirrors --skip-fetch --push-sync`.

`mirror-poll.yml` on `msys2-apiss-sync` picks up any repo listed in
`config/sync.json` (`Mirrors.*` + `MirrorOnly.*`).

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

Use `Notify.Enabled: true` in `.github/mirror-sync.json` and set
`SYNC_DISPATCH_TOKEN` on the mirror repo (PAT with `repo` and `workflow` scopes).
That secret is used for git push and for dispatch to `msys2-apiss-sync` after
push.

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
