# Fork-safe cursor branch algorithm

When replay pauses or aborts, `upstream-ports` and `upstream-ports-mingw` must
point at destination commits whose `Source: ...@<sha>` footer is still a valid
resume cursor. Advancing a cursor branch to a **side-branch** upstream SHA would
pin resume to the wrong line; parallel fork siblings are still picked up on
resume via `git log --reverse <cursor>..<tip>` when the cursor stays on
**mainline**.

Implementation: `src/lib/fork-safe.ts` (`precomputeForkSafeFlagsForQueue`,
`precomputeForkSafeFlagsFromParentMap`) and `src/lib/queue.ts`
(`precomputeSourceCursorBranchSafeFlags`, `precomputeReplayCursorBranchSafeFlags`,
`testSyncCursorBranchUpdateSafe`).

See also `docs/PLAN.md` (Interrupted-run state, fork-safe cursor branches).

## Problem

For one source queue (git `log --reverse` order, oldest first), after replaying
entry at index `i` we may move that source's cursor branch to the destination
commit for `queue[i]`.

**Safe** at `i` when `queue[i]` is on the mirror **first-parent mainline** from
tip. **Unsafe** when it is on a side branch (parent2 line, package fork, etc.).

Resume uses `git log --reverse <cursor>..<tip>`. A mainline cursor still
includes parallel fork siblings not yet replayed. Side-branch cursors are never
safe positions.

## Mainline (first-parent spine)

1. Walk from mirror tip following **first parent only** (`parent1`).
2. Those commits are **mainline**.
3. All other queue commits are **side-branch**.

`buildFirstParentSpine(parentMap, tipSha)` does this in one walk from tip.

## Safe flags

Per queue index `i` for one source:

```text
safe[i] = queue[i] is on the first-parent spine from tip
```

Complexity: **O(n + s)** where `n` is queue length and `s` is spine length
(typically `s <= n`). One spine walk plus one membership test per queue entry.

No backward scan or suffix antichain.

## Example

Fork with `Right` on mainline (first-parent chain from tip):

```text
      Base
     /    \
  Left    Right
```

Queue: `Base`, `Left`, `Right`.

| Index | Commit | Mainline? | safe |
|-------|--------|-----------|------|
| 0     | Base   | yes       | yes  |
| 1     | Left   | no        | no   |
| 2     | Right  | yes       | yes  |

Mainline with a parallel side sibling still in the suffix:

```text
        Base
       /    \
    Main    Side
     \
      (tip on Main)
```

Queue: `Base`, `Main`, `Side`.

| Index | Commit | safe |
|-------|--------|------|
| 0     | Base   | yes  |
| 1     | Main   | yes  |
| 2     | Side   | no   |

`Main` is safe even though `Side` is still in the suffix; resume from `Main`
still replays `Side` via `Main..tip`.

## Per-source and merged queue

`precomputeReplayCursorBranchSafeFlags`:

1. Split merged queue into ports and ports-mingw lists (git order preserved).
2. Mark spine and set `safe[i]` on each list with that source's parent map and tip.
3. For merged index `i`, `safe[i] = portsSafe[portsIndex] && mingwSafe[mingwIndex]`.

## Prepare vs replay

| Phase   | Work |
|---------|------|
| Prepare | Parent maps (`rev-list --parents`), spine walk, O(1) lookup per queue entry |
| Replay  | O(1) flag lookup; git only for diff/commit; cursor branch writes only when safe |

Fetch history, prepare flags once, then replay.
