import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { getSyncRepoRoot, loadSyncConfig } from '../../src/lib/config.ts';
import {
  advanceSyncCursorDestShasIfSafe,
  getDestinationBranchSha,
  resolveSyncRetrieveCursorsFromBranches,
  setDestinationBranchSha
} from '../../src/lib/repos.ts';
import {
  buildCommitParentMapForShas,
  buildFirstParentSpine,
  precomputeReplayCursorBranchSafeFlags,
  precomputeSourceCursorBranchSafeFlags,
  testSyncCursorBranchUpdateSafe
} from '../../src/lib/queue.ts';
import { formatReplayCommitMessage } from '../../src/lib/replay.ts';
import type { ReplayEntry } from '../../src/types/replay-entry.ts';

const config = loadSyncConfig(getSyncRepoRoot());

function runGit(repoPath: string, args: string[]): string {
  const result = spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function initRepo(repoPath: string): void {
  spawnSync('git', ['init', '-b', 'master', repoPath], {
    encoding: 'utf8',
    windowsHide: true
  });
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

function writeRepoFile(repoPath: string, relativePath: string, text: string): void {
  const fullPath = join(repoPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, text, 'utf8');
}

function newPortsEntry(sha: string): ReplayEntry {
  return {
    Sha: sha,
    SourceId: 'ports',
    SortKey: 'ports',
    DestSubdir: 'ports',
    UpstreamRepo: 'msys2/MSYS2-packages',
    CommitterDateUnix: 1,
    AuthorDateUnix: 1,
    AuthorName: 'Author',
    AuthorEmail: 'author@example.com',
    CommitterName: 'Committer',
    CommitterEmail: 'committer@example.com',
    Subject: 'subject',
    Body: ''
  };
}

function commitDestinationReplay(
  destPath: string,
  relativePath: string,
  input: {
    SortKey: 'ports' | 'ports-mingw';
    Subject: string;
    UpstreamRepo: string;
    UpstreamSha: string;
  }
): string {
  const fullPath = join(destPath, relativePath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, `${relativePath}\n`, 'utf8');
  runGit(destPath, ['add', relativePath]);
  runGit(destPath, [
    'commit',
    '-m',
    formatReplayCommitMessage({
      SortKey: input.SortKey,
      Metadata: { Subject: input.Subject, Body: '' },
      UpstreamRepo: input.UpstreamRepo,
      UpstreamSha: input.UpstreamSha
    })
  ]);
  return runGit(destPath, ['rev-parse', 'HEAD']).trim();
}

function buildPortsForkMirror(mirrorPath: string): { Base: string; Left: string; Right: string } {
  initRepo(mirrorPath);

  writeRepoFile(mirrorPath, 'base.txt', 'base\n');
  runGit(mirrorPath, ['add', 'base.txt']);
  runGit(mirrorPath, ['commit', '-m', 'base']);
  const base = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  writeRepoFile(mirrorPath, 'left.txt', 'left\n');
  runGit(mirrorPath, ['add', 'left.txt']);
  runGit(mirrorPath, ['commit', '-m', 'left']);
  const left = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  runGit(mirrorPath, ['checkout', base]);
  writeRepoFile(mirrorPath, 'right.txt', 'right\n');
  runGit(mirrorPath, ['add', 'right.txt']);
  runGit(mirrorPath, ['commit', '-m', 'right']);
  const right = runGit(mirrorPath, ['rev-parse', 'HEAD']).trim();

  return { Base: base, Left: left, Right: right };
}

describe('testSyncCursorBranchUpdateSafe', () => {
  test('allows cursor advance at fork root before siblings diverge', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-fork-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 0,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks cursor advance while a fork sibling remains in the queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-fork-block-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 1,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('allows cursor advance after the last fork sibling is processed', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-fork-done-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      expect(testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 2,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('precomputeSourceCursorBranchSafeFlags', () => {
  test('marks first-parent mainline safe and parent2 side branches unsafe', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-spine-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];
      const spine = buildFirstParentSpine(parentMap, Right);
      const flags = precomputeSourceCursorBranchSafeFlags(queue, parentMap, Right);

      expect(spine.has(Base)).toBe(true);
      expect(spine.has(Right)).toBe(true);
      expect(spine.has(Left)).toBe(false);
      expect(flags).toEqual([true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('precomputeReplayCursorBranchSafeFlags', () => {
  test('matches testSyncCursorBranchUpdateSafe for fork queue positions', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-precompute-'));
    try {
      const mirrorPath = join(root, 'mirror');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];
      const flags = precomputeReplayCursorBranchSafeFlags({
        Queue: queue,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap
      });

      for (let index = 0; index < queue.length; index++) {
        expect(flags[index]).toBe(testSyncCursorBranchUpdateSafe({
          Queue: queue,
          Index: index,
          ParentMapPorts: parentMap,
          ParentMapMingw: parentMap,
          TipShaPorts: Right,
          TipShaMingw: Right
        }));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('advanceSyncCursorDestShasIfSafe', () => {
  test('keeps upstream-ports on fork root when sibling remains', () => {
    expect(advanceSyncCursorDestShasIfSafe({
      SourceId: 'ports',
      ReplayTipSha: 'left-dest',
      CursorBranchSafe: false,
      LastPortsDestSha: 'base-dest',
      LastMingwDestSha: null
    })).toEqual({
      PortsDestSha: 'base-dest',
      PortsMingwDestSha: null
    });
  });

  test('advances upstream-ports after fork-safe replay', () => {
    expect(advanceSyncCursorDestShasIfSafe({
      SourceId: 'ports',
      ReplayTipSha: 'right-dest',
      CursorBranchSafe: true,
      LastPortsDestSha: 'base-dest',
      LastMingwDestSha: null
    })).toEqual({
      PortsDestSha: 'right-dest',
      PortsMingwDestSha: null
    });
  });
});

describe('fork-safe cursor branches after abort', () => {
  test('upstream-ports stays at fork root when replay aborted on a sibling line', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-cursor-abort-'));
    try {
      const mirrorPath = join(root, 'mirror-ports');
      const destPath = join(root, 'destination');
      const { Base, Left, Right } = buildPortsForkMirror(mirrorPath);
      initRepo(destPath);

      const baseDestSha = commitDestinationReplay(destPath, 'ports/base.txt', {
        SortKey: 'ports',
        Subject: 'base',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: Base
      });
      const leftDestSha = commitDestinationReplay(destPath, 'ports/left.txt', {
        SortKey: 'ports',
        Subject: 'left',
        UpstreamRepo: 'msys2/MSYS2-packages',
        UpstreamSha: Left
      });

      runGit(destPath, ['checkout', '-B', 'upstream', leftDestSha]);
      setDestinationBranchSha(destPath, 'upstream-ports', baseDestSha);

      const parentMap = buildCommitParentMapForShas(mirrorPath, [Base, Left, Right]);
      const queue = [newPortsEntry(Base), newPortsEntry(Left), newPortsEntry(Right)];

      const unsafeAtLeft = !testSyncCursorBranchUpdateSafe({
        Queue: queue,
        Index: 1,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap,
        TipShaPorts: Right,
        TipShaMingw: Right
      });
      expect(unsafeAtLeft).toBe(true);

      const nextCursorDestShas = advanceSyncCursorDestShasIfSafe({
        SourceId: 'ports',
        ReplayTipSha: leftDestSha,
        CursorBranchSafe: false,
        LastPortsDestSha: baseDestSha,
        LastMingwDestSha: null
      });
      setDestinationBranchSha(destPath, 'upstream-ports', nextCursorDestShas.PortsDestSha!);

      expect(getDestinationBranchSha(destPath, 'upstream-ports')).toBe(baseDestSha);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).PortsUpstreamSha).toBe(Base);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).PortsUpstreamSha).not.toBe(Left);
      expect(resolveSyncRetrieveCursorsFromBranches(destPath, config).PortsUpstreamSha).not.toBe(Right);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
