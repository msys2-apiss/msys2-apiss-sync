import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import { setDestinationBranchSha } from '../../src/lib/repos.ts';

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
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-repos-'));
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
    const root = mkdtempSync(join(tmpdir(), 'msys2-uwp-sync-repos-'));
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
