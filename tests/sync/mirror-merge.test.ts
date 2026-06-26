import { describe, expect, test } from 'vitest';

import {
  formatMirrorMergeCursorSummary,
  resolveMirrorMergeMode
} from '../../src/mirror-merge/index.ts';
import type { SyncConfig } from '../../src/mirror-merge/config.ts';

const testConfig: SyncConfig = {
  ReplaySpecVersion: 4,
  Owner: 'msys2-apiss',
  Destination: {
    Repo: 'msys2-apiss',
    BaseCommit: 'a'.repeat(40),
    ReplayTip: 'upstream'
  },
  Sources: [
    {
      Repo: 'MSYS2-packages',
      Branch: 'master',
      DestSubdir: 'ports',
      SortKey: 'ports',
      CursorBranch: 'upstream-ports',
      UpstreamRepo: 'msys2/MSYS2-packages',
      CommitMessage: '[{SortKey}] {Subject}{BodyBlock}Source: {UpstreamRepo}@{UpstreamSha}'
    },
    {
      Repo: 'MINGW-packages',
      Branch: 'master',
      DestSubdir: 'ports-mingw',
      SortKey: 'ports-mingw',
      CursorBranch: 'upstream-ports-mingw',
      UpstreamRepo: 'msys2/MINGW-packages',
      CommitMessage: '[{SortKey}] {Subject}{BodyBlock}Source: {UpstreamRepo}@{UpstreamSha}'
    }
  ],
  Mirrors: {
    Repos: ['MSYS2-packages', 'MINGW-packages'],
    SyncIntervalMinutes: 15,
    DispatchEventType: 'workflow_dispatch_mirror_merge'
  },
  Replay: {
    MinReplayAgeMinutes: 5,
    SkipEmptyTreeDiff: true,
    LineEnding: 'LF'
  },
  PollIntervalMinutes: 60,
  DailyReconciliationCron: '0 3 * * *'
};

describe('resolveMirrorMergeMode', () => {
  test('bootstraps when clean is requested', () => {
    expect(resolveMirrorMergeMode({ Clean: true, AllSyncBranchesExist: true })).toBe('bootstrap');
  });

  test('bootstraps when any sync branch is missing', () => {
    expect(resolveMirrorMergeMode({ Clean: false, AllSyncBranchesExist: false })).toBe('bootstrap');
  });

  test('runs incremental when all sync branches exist', () => {
    expect(resolveMirrorMergeMode({ Clean: false, AllSyncBranchesExist: true })).toBe('incremental');
  });
});

describe('formatMirrorMergeCursorSummary', () => {
  test('prints source cursors in config source order', () => {
    expect(formatMirrorMergeCursorSummary(testConfig, {
      ports: '1234567890abcdef',
      'ports-mingw': null
    })).toBe('ports=12345678 ports-mingw=none');
  });
});
