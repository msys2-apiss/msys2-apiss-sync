import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import type { Logger } from '../../src/git/log.ts';
import {
  computeRepoToolingDigest,
  loadDigestMap,
  pinRepoDigest,
  repoNeedsBootstrap,
  saveDigestMap
} from '../../src/lib/tooling-digest.ts';
import { TOOLING_DIGEST_PATH } from '../../src/types/constants.ts';

function writeDigestInputs(
  root: string,
  input: {
    mirrorSyncYml?: string;
    mirrorMergeYml?: string;
    mirrorMergeJson?: string;
    mirrorSyncJson?: Record<string, string>;
    toolings?: Record<string, string>;
    mirrorPollJson?: string;
  }
): void {
  mkdirSync(join(root, 'config', 'mirror-template', 'toolings'), { recursive: true });
  mkdirSync(join(root, 'config', 'mirror-sync'), { recursive: true });

  writeFileSync(
    join(root, 'config/mirror-template/mirror-sync.yml'),
    input.mirrorSyncYml ?? 'name: sync\n',
    'utf8'
  );
  writeFileSync(
    join(root, 'config/mirror-template/mirror-merge.yml'),
    input.mirrorMergeYml ?? 'name: merge\n',
    'utf8'
  );
  writeFileSync(
    join(root, 'config/mirror-merge.json'),
    input.mirrorMergeJson ?? '{}\n',
    'utf8'
  );

  for (const [repo, content] of Object.entries(input.mirrorSyncJson ?? {})) {
    writeFileSync(join(root, 'config/mirror-sync', `${repo}.json`), content, 'utf8');
  }

  for (const [name, content] of Object.entries(input.toolings ?? {})) {
    writeFileSync(join(root, 'config/mirror-template/toolings', name), content, 'utf8');
  }

  if (input.mirrorPollJson !== undefined) {
    writeFileSync(join(root, 'config/mirror-poll.json'), input.mirrorPollJson, 'utf8');
  }
}

function expectedDigest(root: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const rel of [...paths].sort()) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(join(root, rel)));
  }
  return hash.digest('hex');
}

describe('computeRepoToolingDigest', () => {
  test('hashes sorted paths with null separator for mirror inputs', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-'));
    try {
      writeDigestInputs(root, {
        mirrorSyncJson: { elfutils: '{"UpstreamUrl":"https://example.com/up.git"}\n' },
        toolings: { 'mirror-sync.mjs': 'export {}\n' }
      });

      const paths = [
        'config/mirror-sync/elfutils.json',
        'config/mirror-template/mirror-sync.yml',
        'config/mirror-template/toolings/mirror-sync.mjs'
      ];
      expect(computeRepoToolingDigest(root, 'elfutils', 'mirror')).toBe(expectedDigest(root, paths));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('hashes destination workflow, merge config, and toolings', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-dest-'));
    try {
      writeDigestInputs(root, {
        toolings: { 'mirror-merge.mjs': 'export {}\n' }
      });

      const paths = [
        'config/mirror-merge.json',
        'config/mirror-template/mirror-merge.yml',
        'config/mirror-template/toolings/mirror-merge.mjs'
      ];
      expect(computeRepoToolingDigest(root, 'msys2-apiss', 'destination')).toBe(
        expectedDigest(root, paths)
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('mirror JSON change affects one repo only', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-mirror-only-'));
    try {
      writeDigestInputs(root, {
        mirrorSyncJson: {
          a: '{"UpstreamUrl":"https://example.com/a.git"}\n',
          b: '{"UpstreamUrl":"https://example.com/b.git"}\n'
        }
      });

      const digestA = computeRepoToolingDigest(root, 'a', 'mirror');
      const digestB = computeRepoToolingDigest(root, 'b', 'mirror');
      expect(digestA).not.toBe(digestB);

      writeFileSync(
        join(root, 'config/mirror-sync/b.json'),
        '{"UpstreamUrl":"https://example.com/changed.git"}\n',
        'utf8'
      );
      expect(computeRepoToolingDigest(root, 'a', 'mirror')).toBe(digestA);
      expect(computeRepoToolingDigest(root, 'b', 'mirror')).not.toBe(digestB);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('shared template or tooling change affects all repos', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-shared-'));
    try {
      writeDigestInputs(root, {
        mirrorSyncJson: { a: '{"UpstreamUrl":"https://example.com/a.git"}\n' }
      });

      const mirrorBefore = computeRepoToolingDigest(root, 'a', 'mirror');
      const destBefore = computeRepoToolingDigest(root, 'msys2-apiss', 'destination');

      writeFileSync(
        join(root, 'config/mirror-template/mirror-sync.yml'),
        'name: sync-changed\n',
        'utf8'
      );

      expect(computeRepoToolingDigest(root, 'a', 'mirror')).not.toBe(mirrorBefore);
      expect(computeRepoToolingDigest(root, 'msys2-apiss', 'destination')).toBe(destBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores mirror-poll.json and digest.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-ignore-'));
    try {
      writeDigestInputs(root, {
        mirrorSyncJson: { a: '{"UpstreamUrl":"https://example.com/a.git"}\n' }
      });

      const before = computeRepoToolingDigest(root, 'a', 'mirror');
      writeFileSync(join(root, 'config/mirror-poll.json'), '{"Owner":"changed"}\n', 'utf8');
      writeFileSync(join(root, 'config/digest.json'), '{"a":"deadbeef"}\n', 'utf8');
      expect(computeRepoToolingDigest(root, 'a', 'mirror')).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('throws when required mirror config is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-missing-'));
    try {
      writeDigestInputs(root, {});
      expect(() => computeRepoToolingDigest(root, 'missing', 'mirror')).toThrow(
        'Missing digest input file: config/mirror-sync/missing.json'
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('loadDigestMap', () => {
  test('returns empty map when digest.json is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-load-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      expect(loadDigestMap(root)).toEqual({});
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('loads repo entries from digest.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-load2-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(
        join(root, TOOLING_DIGEST_PATH),
        '{"MSYS2-packages":"abc","msys2-apiss":"def"}\n',
        'utf8'
      );
      expect(loadDigestMap(root)).toEqual({
        'MSYS2-packages': 'abc',
        'msys2-apiss': 'def'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('warns and returns empty map on invalid JSON', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-invalid-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      writeFileSync(join(root, TOOLING_DIGEST_PATH), 'not-json', 'utf8');
      const warnings: string[] = [];
      const logger: Logger = {
        write(message, level) {
          if (level === 'Warn') {
            warnings.push(message);
          }
        },
        close() {}
      };
      expect(loadDigestMap(root, logger)).toEqual({});
      expect(warnings.some((line) => line.includes('treating as empty map'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('saveDigestMap', () => {
  test('writes sorted keys with trailing newline', () => {
    const root = mkdtempSync(join(tmpdir(), 'msys2-apiss-sync-digest-save-'));
    try {
      mkdirSync(join(root, 'config'), { recursive: true });
      saveDigestMap(root, { b: '2', a: '1' });
      const path = join(root, TOOLING_DIGEST_PATH);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe('{\n  "a": "1",\n  "b": "2"\n}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repoNeedsBootstrap', () => {
  test('true when repo key missing or digest differs', () => {
    const map = { pinned: 'abc' };
    expect(repoNeedsBootstrap(map, 'pinned', 'abc')).toBe(false);
    expect(repoNeedsBootstrap(map, 'pinned', 'def')).toBe(true);
    expect(repoNeedsBootstrap(map, 'new-repo', 'abc')).toBe(true);
    expect(repoNeedsBootstrap({}, 'any', 'abc')).toBe(true);
  });
});

describe('pinRepoDigest', () => {
  test('sets repo digest in map', () => {
    const map: Record<string, string> = {};
    pinRepoDigest(map, 'elfutils', 'deadbeef');
    expect(map).toEqual({ elfutils: 'deadbeef' });
  });
});
