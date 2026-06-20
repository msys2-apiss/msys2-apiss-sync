import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { checkoutDestinationReplayBranch, resolveUpstreamCursorSha, setDestinationBranchSha } from '../../src/lib/repos.ts';
import { formatReplayCommitMessage } from '../../src/lib/replay.ts';

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

describe('setDestinationBranchSha', () => {
  test('updates checked-out branch without branch -f', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'first.txt'), 'first\n', 'utf8');
      runGit(repoPath, ['add', 'first.txt']);
      runGit(repoPath, ['commit', '-m', 'first']);
      const first = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['checkout', '-B', 'upstream']);
      setDestinationBranchSha(repoPath, 'upstream', first);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(first);
      expect(runGit(repoPath, ['rev-parse', 'upstream']).trim()).toBe(first);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('updates unchecked branch with branch -f', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'first.txt'), 'first\n', 'utf8');
      runGit(repoPath, ['add', 'first.txt']);
      runGit(repoPath, ['commit', '-m', 'first']);
      const first = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      writeFileSync(join(repoPath, 'second.txt'), 'second\n', 'utf8');
      runGit(repoPath, ['add', 'second.txt']);
      runGit(repoPath, ['commit', '-m', 'second']);
      const second = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      runGit(repoPath, ['checkout', '-B', 'upstream', first]);
      setDestinationBranchSha(repoPath, 'upstream-ports', second);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(first);
      expect(runGit(repoPath, ['rev-parse', 'upstream-ports']).trim()).toBe(second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkoutDestinationReplayBranch', () => {
  test('removes untracked files that block checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-checkout-'));
    try {
      const repoPath = join(root, 'repo');
      initTestRepo(repoPath);

      writeFileSync(join(repoPath, 'tracked.txt'), 'tracked\n', 'utf8');
      runGit(repoPath, ['add', 'tracked.txt']);
      runGit(repoPath, ['commit', '-m', 'tracked']);
      const tip = runGit(repoPath, ['rev-parse', 'HEAD']).trim();

      mkdirSync(join(repoPath, 'ports-mingw/nested'), { recursive: true });
      writeFileSync(join(repoPath, 'ports-mingw/block.txt'), 'untracked\n', 'utf8');
      writeFileSync(join(repoPath, 'ports-mingw/nested/other.txt'), 'other\n', 'utf8');

      checkoutDestinationReplayBranch(repoPath, 'upstream', tip);

      expect(runGit(repoPath, ['rev-parse', 'HEAD']).trim()).toBe(tip);
      expect(runGit(repoPath, ['symbolic-ref', '--short', 'HEAD']).trim()).toBe('upstream');
      expect(() => runGit(repoPath, ['status', '--porcelain'])).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolveUpstreamCursorSha', () => {
  test('reads upstream sha from destination replay commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-cursor-'));
    try {
      const destPath = join(root, 'destination');
      initTestRepo(destPath);

      const upstreamSha = 'f'.repeat(40);

      mkdirSync(join(destPath, 'ports'), { recursive: true });
      writeFileSync(join(destPath, 'ports/foo.txt'), 'foo\n', 'utf8');
      runGit(destPath, ['add', 'ports/foo.txt']);
      runGit(destPath, [
        'commit',
        '-m',
        formatReplayCommitMessage({
          SortKey: 'ports',
          Metadata: { Subject: 'sync foo', Body: '' },
          UpstreamRepo: 'msys2/MSYS2-packages',
          UpstreamSha: upstreamSha
        })
      ]);
      const destSha = runGit(destPath, ['rev-parse', 'HEAD']).trim();

      expect(resolveUpstreamCursorSha(destPath, destSha, 'msys2/MSYS2-packages')).toBe(upstreamSha);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('returns null when commit message has no source footer', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-repos-cursor-empty-'));
    try {
      const destPath = join(root, 'destination');
      initTestRepo(destPath);
      runGit(destPath, ['commit', '--allow-empty', '-m', 'base']);
      const destSha = runGit(destPath, ['rev-parse', 'HEAD']).trim();

      expect(resolveUpstreamCursorSha(destPath, destSha, 'msys2/MSYS2-packages')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
