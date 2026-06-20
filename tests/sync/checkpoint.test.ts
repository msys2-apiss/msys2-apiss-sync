import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import {
  buildCommitParentMapForShas,
  precomputeReplayCheckpointSafeFlags,
  testReplayCheckpointSafe
} from '../../src/lib/queue.ts';
import type { ReplayEntry } from '../../src/types/replay-entry.ts';

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

function initTestRepo(repoPath: string): void {
  spawnSync('git', ['init', repoPath], {
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

function newTestEntry(sha: string): ReplayEntry {
  return {
    Sha: sha,
    SourceId: 'ports-mingw',
    SortKey: 'ports-mingw',
    DestSubdir: 'ports-mingw',
    UpstreamRepo: 'msys2/MINGW-packages',
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

describe('testReplayCheckpointSafe', () => {
  test('allows checkpoint at a fork root before parallel branches diverge', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-checkpoint-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

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

      const parentMap = buildCommitParentMapForShas(mirrorPath, [base, left, right]);
      const queue = [newTestEntry(base), newTestEntry(left), newTestEntry(right)];

      expect(testReplayCheckpointSafe({
        Queue: queue,
        Index: 0,
        LastPortsSha: null,
        LastPortsMingwSha: base,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap
      })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('blocks checkpoint while a sibling branch commit remains in the queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-checkpoint-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

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

      const parentMap = buildCommitParentMapForShas(mirrorPath, [base, left, right]);
      const queue = [newTestEntry(base), newTestEntry(left), newTestEntry(right)];

      expect(testReplayCheckpointSafe({
        Queue: queue,
        Index: 1,
        LastPortsSha: null,
        LastPortsMingwSha: left,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap
      })).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('precomputeReplayCheckpointSafeFlags', () => {
  test('matches per-index fork-safe checks', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-checkpoint-'));
    try {
      const mirrorPath = join(root, 'mirror');
      initTestRepo(mirrorPath);

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

      const parentMap = buildCommitParentMapForShas(mirrorPath, [base, left, right]);
      const queue = [newTestEntry(base), newTestEntry(left), newTestEntry(right)];
      const flags = precomputeReplayCheckpointSafeFlags({
        Queue: queue,
        ParentMapPorts: parentMap,
        ParentMapMingw: parentMap
      });

      expect(flags).toEqual([true, false, true]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
