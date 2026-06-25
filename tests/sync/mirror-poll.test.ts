import { describe, expect, test } from 'vitest';

import { mirrorRepoNeedsSync, type MirrorPollGitHub } from '../../src/lib/mirror-poll.ts';
import type { MirrorSyncConfig } from '../../src/types/mirror-sync-config.ts';
import type { SyncLogger } from '../../src/lib/log.ts';

const noopLogger: SyncLogger = {
  write() {},
  close() {}
};

function mirrorConfig(overrides: Partial<MirrorSyncConfig> = {}): MirrorSyncConfig {
  return {
    UpstreamUrl: 'https://example.com/upstream.git',
    Branches: [{ Upstream: 'master', Mirror: 'master' }],
    ...overrides
  };
}

function fakeGitHub(branchSha: string | null): MirrorPollGitHub {
  return {
    async getBranchSha() {
      return branchSha;
    },
    async dispatchMirrorSync(_repo, _contentBranch) {}
  };
}

describe('mirrorRepoNeedsSync', () => {
  test('returns false when mirror and upstream SHAs match', async () => {
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorConfig: mirrorConfig(),
      GitHub: fakeGitHub('abc123'),
      Logger: noopLogger,
      GetUpstreamSha: () => 'abc123'
    });
    expect(needsSync).toBe(false);
  });

  test('returns true when mirror SHA differs from upstream', async () => {
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorConfig: mirrorConfig(),
      GitHub: fakeGitHub('abc123'),
      Logger: noopLogger,
      GetUpstreamSha: () => 'def456'
    });
    expect(needsSync).toBe(true);
  });

  test('returns true when mirror branch is missing', async () => {
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorConfig: mirrorConfig(),
      GitHub: fakeGitHub(null),
      Logger: noopLogger,
      GetUpstreamSha: () => 'def456'
    });
    expect(needsSync).toBe(true);
  });

  test('returns true when mirror-sync config is missing', async () => {
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: 'mirror',
      MirrorConfig: null,
      GitHub: fakeGitHub(null),
      Logger: noopLogger
    });
    expect(needsSync).toBe(true);
  });
});
