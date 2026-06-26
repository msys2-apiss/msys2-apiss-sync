import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

import {
  getMirrorSyncNotify,
  mirrorBranchNeedsUpdate,
  runMirrorSync,
  validateMirrorSyncConfig
} from '../../src/mirror-sync/index.ts';
import type { SyncLogger } from '../../src/lib/log.ts';
import type { MirrorSyncConfig } from '../../src/types/mirror-sync-config.ts';

const noopLogger: SyncLogger = {
  write() {},
  close() {}
};

function runGit(repoPath: string | null, args: string[]): string {
  const result = spawnSync('git', repoPath ? ['-C', repoPath, ...args] : args, {
    encoding: 'utf8',
    windowsHide: true
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout).trim());
  }
  return result.stdout;
}

function initRepo(repoPath: string): void {
  runGit(null, ['init', '-b', 'master', repoPath]);
  runGit(repoPath, ['config', 'user.name', 'Test User']);
  runGit(repoPath, ['config', 'user.email', 'test@example.com']);
}

function mirrorConfig(upstreamUrl: string, overrides: Partial<MirrorSyncConfig> = {}): MirrorSyncConfig {
  return {
    UpstreamUrl: upstreamUrl,
    Branches: [{ Upstream: 'master', Mirror: 'master' }],
    SyncTags: false,
    ...overrides
  };
}

describe('mirrorBranchNeedsUpdate', () => {
  test('requires update when origin is missing or differs', () => {
    expect(mirrorBranchNeedsUpdate(null, 'abc')).toBe(true);
    expect(mirrorBranchNeedsUpdate('abc', 'def')).toBe(true);
    expect(mirrorBranchNeedsUpdate('abc', 'abc')).toBe(false);
  });
});

describe('validateMirrorSyncConfig', () => {
  test('requires an upstream url and branch mappings', () => {
    expect(() => validateMirrorSyncConfig(mirrorConfig('https://example.com/upstream.git'))).not.toThrow();
    expect(() => validateMirrorSyncConfig({ ...mirrorConfig(''), UpstreamUrl: '' })).toThrow('UpstreamUrl');
    expect(() => validateMirrorSyncConfig({ ...mirrorConfig('https://example.com/upstream.git'), Branches: [] }))
      .toThrow('Branches');
  });
});

describe('getMirrorSyncNotify', () => {
  test('returns configured package mirror notification target', () => {
    expect(getMirrorSyncNotify(mirrorConfig('https://example.com/upstream.git', {
      Notify: {
        Enabled: true,
        Repository: 'msys2-apiss/msys2-apiss-sync',
        EventType: 'workflow_dispatch_mirror_merge'
      }
    }))).toEqual({
      Enabled: true,
      Repository: 'msys2-apiss/msys2-apiss-sync',
      EventType: 'workflow_dispatch_mirror_merge'
    });
  });
});

describe('runMirrorSync', () => {
  test('pushes an upstream branch into the mirror origin', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-mirror-sync-'));
    try {
      const upstreamPath = join(root, 'upstream');
      const mirrorPath = join(root, 'mirror');
      const originPath = join(root, 'origin.git');

      initRepo(upstreamPath);
      writeFileSync(join(upstreamPath, 'pkg.txt'), 'pkg\n', 'utf8');
      runGit(upstreamPath, ['add', 'pkg.txt']);
      runGit(upstreamPath, ['commit', '-m', 'upstream package']);
      const upstreamTip = runGit(upstreamPath, ['rev-parse', 'HEAD']).trim();

      runGit(null, ['init', '--bare', originPath]);
      initRepo(mirrorPath);
      runGit(mirrorPath, ['remote', 'add', 'origin', originPath]);

      const first = runMirrorSync({
        RepoPath: mirrorPath,
        Config: mirrorConfig(upstreamPath),
        Logger: noopLogger
      });
      expect(first.Advanced).toBe(true);
      expect(first.PrimarySha).toBe(upstreamTip);
      expect(runGit(originPath, ['rev-parse', 'master']).trim()).toBe(upstreamTip);

      const second = runMirrorSync({
        RepoPath: mirrorPath,
        Config: mirrorConfig(upstreamPath),
        Logger: noopLogger
      });
      expect(second.Advanced).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
