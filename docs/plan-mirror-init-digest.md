# mirror-init tooling digest (planned)

Implementation note for simplifying mirror-init bootstrap/skip logic.
Status: **implemented** -- see `src/lib/tooling-digest.ts` and mirror-init wiring.

## Background (already shipped)

Block 3/4 CI downloads tooling at runtime instead of committing on mirror/destination
repos:

- `mirror-sync.yml` downloads `mirror-sync.mjs` and per-repo JSON from
  `config/mirror-template/mirror-sync/<repo>.json` on `msys2-apiss-sync` `main`.
- `mirror-merge.yml` downloads `mirror-merge.mjs` and `config/mirror-merge.json`.
- `yarn mirror-init` installs **workflow YAML only** on tooling branches
  (`msys2-apiss-mirror-sync`, `msys2-apiss-mirror-merge`).
- `yarn pack-toolings` builds `config/mirror-template/toolings/*.mjs` only.

See [`docs/mirror-init.md`](mirror-init.md) and [`docs/plan-workflow.md`](plan-workflow.md).

## What to remove (partial / abandoned work)

The repo still contains an **intermediate** digest design that should be replaced:

| Remove / revert | Notes |
|-----------------|-------|
| `ToolingSha256` on `config/mirror-merge.json` and `config/mirror-template/mirror-sync/*.json` | Never commit digests in those files |
| `src/mirror-init/tooling-sha.ts` | Per-workflow SHA + pin into per-repo JSON |
| `writeJsonToolingSha256`, workflow-only hashing in `src/lib/tooling-digest.ts` | Replace with config-tree digest |
| Digest logic in `mirror-sync` / `mirror-merge` CLIs | Digest is **mirror-init only**, not CI |
| `TOOLING_DIGEST_CANARY_REPO` / elfutils canary pin to GitHub | User rejected remote/canary pinning |
| `pack-toolings` writing any digest | Bundles only |

Also clean up types: drop `ToolingSha256?` from
`src/types/mirror-sync-config.ts` and `src/mirror-merge/config.ts`.

## New design (target)

### Digest input

**SHA256 of all files under `config/`**, recursively:

- Walk every file under `config/` (not directories).
- Sort paths **stably** (lexicographic, forward slashes, relative to `config/`).
- **Exclude** `config/digest.json` from the hash (otherwise updating the map
  changes the digest being recorded).
- Hash: for each sorted relative path, update SHA256 with path bytes + `\0` +
  file bytes (or equivalent stable separator so path boundaries are unambiguous).

This automatically covers:

- `mirror-merge.json`, `mirror-poll.json`
- `mirror-template/mirror-sync.yml`, `mirror-template/mirror-merge.yml`
- `mirror-template/toolings/mirror-sync.mjs`, `mirror-template/toolings/mirror-merge.mjs`
- All `mirror-template/mirror-sync/*.json`
- Any future file added under `config/`

No hand-maintained file list.

### Digest map

Optional file: **`config/digest.json`**

```json
{
  "msys2-apiss": "<hex-sha256>",
  "MSYS2-packages": "<hex-sha256>",
  "elfutils": "<hex-sha256>"
}
```

- Keys: **GitHub repo name** -- destination repo from `mirror-poll.json`
  `Destination.Repo`, mirror repos from `Repos[]`.
- Values: digest hex from the config-tree hash at last successful bootstrap for
  that repo.
- Updated **only** by operator running **`yarn mirror-init --push`** after a
  successful bootstrap/push for that repo -- not by `pack-toolings`, not by CI.

#### When `config/digest.json` does not exist

This is the normal state before the first successful `yarn mirror-init --push`.

| Case | Behavior |
|------|----------|
| File missing | `loadDigestMap()` returns `{}` (no error, no log unless verbose) |
| File is `{}` | Same as missing for every repo: all targets need bootstrap |
| Repo key missing in map | That repo needs bootstrap |
| Repo key present but value `!== currentDigest` | Bootstrap |
| Repo key present and value `=== currentDigest` | Skip apply/push/dispatch |

Implementation rules:

- **`loadDigestMap(repoRoot)`**: if `config/digest.json` is absent, return `{}`.
  Do not create the file on read. Do not fail mirror-init.
- **`saveDigestMap(repoRoot, map)`**: write `config/digest.json` only from
  `--push` after a successful bootstrap for at least one repo (create file on
  first pin; overwrite on later pins).
- **`repoNeedsBootstrap(map, repo, digest)`**: return true when
  `map[repo] === undefined` or `map[repo] !== digest` (missing file and missing
  key are equivalent).
- **Invalid JSON** (file exists but unreadable): log a warning and treat as
  `{}` so the operator gets a full re-bootstrap instead of a hard failure.

Do not commit `config/digest.json` until you intend to record pinned state.
Fresh clones without the file always bootstrap on first `--push`.

### Bootstrap vs skip

For each target repo during `yarn mirror-init`:

| Condition | Action |
|-----------|--------|
| `digest.json` missing or `{}` | **Bootstrap** every repo (same as no pins) |
| `digest.json[repo]` missing | **Bootstrap** that repo |
| `digest.json[repo] !== currentConfigDigest` | **Bootstrap** that repo |
| `digest.json[repo] === currentConfigDigest` | **Skip** apply/push/dispatch for that repo |

**Bootstrap** here means the existing mirror-init tooling path:

- Destination: checkout root, install `mirror-merge.yml`, push tooling branch.
- Mirror: checkout root, install `mirror-sync.yml`, push tooling branch, optional
  dispatch.

**Skip** means:

- Skip repo init entirely (no clone/fetch/checkout/layout checks).
- Do not re-apply workflow template, push tooling branch, or dispatch Block 3/4.
- On `--push` with all repos pinned: skip repo init; mirror-poll still runs at end unless **`--no-poll`**.

After **successful** `--push` bootstrap for a repo, set
`digest.json[repo] = currentConfigDigest` and save `config/digest.json`.

Plain `yarn mirror-init` (no `--push`) may still apply locally when digest
mismatches, but must **not** write `digest.json`.

## Code changes (checklist)

### New / rewrite

- **`src/lib/tooling-digest.ts`**
  - `computeConfigTreeDigest(repoRoot): string`
  - `loadDigestMap(repoRoot): Record<string, string>` -- missing file -> `{}`
  - `saveDigestMap(repoRoot, map): void` -- creates file on first write
  - `repoNeedsBootstrap(map, repo, digest): boolean` -- true if key absent
  - `pinRepoDigest(map, repo, digest): void` (mutate + save)
- **`src/types/constants.ts`**: `TOOLING_DIGEST_PATH = 'config/digest.json'`

### mirror-init

- **`src/mirror-init/index.ts`**
  - At start: `currentDigest = computeConfigTreeDigest(repoRoot)`,
    `digestMap = loadDigestMap(repoRoot)`.
  - Pass `needsBootstrap` (or digest + map) into init/push helpers.
  - After successful `--push` per repo: `pinRepoDigest(digestMap, repoName, currentDigest)`.
  - Remove imports from `tooling-sha.ts`.
- **`src/mirror-init/mirror.ts`**
  - `applyMirrorSyncTemplate`: if `!repoNeedsBootstrap`, log skip and return false.
  - Remove `mirrorInitToolingInstallUpToDate`, `mirrorSyncToolingPushUpToDate`.
- **`src/mirror-init/destination.ts`**
  - Same for merge template; remove `destinationToolingPushUpToDate`.
- **Delete** `src/mirror-init/tooling-sha.ts`.

### Tests

- **`tests/sync/tooling-digest.test.ts`**: stable sort, exclude `digest.json`,
  map load/save, bootstrap decision; **`loadDigestMap` when file absent -> `{}`**.
- Update **`tests/sync/repos.test.ts`** if apply/skip behavior changes.
- Remove tests that expect `ToolingSha256` in per-repo JSON.

### Docs (optional follow-up)

- Short note in [`docs/mirror-init.md`](mirror-init.md): digest map, when it updates,
  that changing anything under `config/` triggers re-bootstrap on next `--push`.

## Operator flow

```bash
# After changing anything under config/ (templates, mirror-merge.json, bundles, etc.)
yarn pack-toolings          # if .mjs sources changed
yarn mirror-init --push     # bootstraps repos whose digest.json entry is stale/missing
# commit config/digest.json when entries were updated
```

Second run with unchanged `config/`:

```bash
yarn mirror-init --push     # should skip push/dispatch for repos already pinned
```

## Out of scope

- CI mirror-sync / mirror-merge digest checks (remote repos).
- Per-repo digest in `mirror-sync/*.json` or `mirror-merge.json`.
- Automatic digest commit from GitHub Actions.

## Related paths

| Path | Role |
|------|------|
| `config/` | Digest input (all files except `digest.json`) |
| `config/digest.json` | Optional repo -> digest map (`--push` creates/updates) |
| `src/mirror-init/` | Apply/skip/pin logic |
| `src/lib/tooling-digest.ts` | Hash + map I/O |
| `config/mirror-template/toolings/*.mjs` | Included in config tree digest after `pack-toolings` |
