import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

let repoRoot = mkdtempSync(join(tmpdir(), 'mirror-init-fast-'));

vi.mock('../../src/mirror-init/config.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/mirror-init/config.ts')>();
  return {
    ...mod,
    getSyncRepoRoot: () => repoRoot,
    getWorkDirectory: (root: string) => join(root, '.work')
  };
});

const ghDispatchMirrorBlock = vi.fn();
const requireGhAuthenticated = vi.fn();

vi.mock('../../src/git/gh.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/git/gh.ts')>();
  return { ...mod, ghDispatchMirrorBlock, requireGhAuthenticated };
});

const initializeDestinationRepository = vi.fn(() => join(repoRoot, '.work', 'mirror-merge-ci'));
const initializeNamedMirrorRepository = vi.fn(() => join(repoRoot, '.work', 'mirrors', 'mirror-a'));

vi.mock('../../src/mirror-init/destination.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/mirror-init/destination.ts')>();
  return { ...mod, initializeDestinationRepository };
});

vi.mock('../../src/mirror-init/mirror.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/mirror-init/mirror.ts')>();
  return { ...mod, initializeNamedMirrorRepository };
});

function writeConfigTree(root: string): void {
  mkdirSync(join(root, 'config', 'mirror-template'), { recursive: true });
  mkdirSync(join(root, 'config', 'mirror-sync'), { recursive: true });
  writeFileSync(
    join(root, 'config/mirror-poll.json'),
    `${JSON.stringify({
      Owner: 'msys2-apiss',
      Destination: { Repo: 'dest' },
      Repos: ['mirror-a']
    })}\n`
  );
  writeFileSync(join(root, 'config/mirror-merge.json'), '{}\n');
  writeFileSync(
    join(root, 'config/mirror-sync/mirror-a.json'),
    '{"UpstreamUrl":"https://example.com/up.git","Branches":[{"Upstream":"master","Mirror":"master"}]}\n'
  );
  writeFileSync(join(root, 'config/mirror-template/mirror-sync.yml'), 'name: test\n');
  writeFileSync(join(root, 'config/mirror-template/mirror-merge.yml'), 'name: test\n');
}

describe('runMirrorInit digest fast path', () => {
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'mirror-init-fast-'));
    initializeDestinationRepository.mockClear();
    initializeNamedMirrorRepository.mockClear();
    ghDispatchMirrorBlock.mockClear();
    requireGhAuthenticated.mockClear();
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  test('skips repo init when all targets pinned', async () => {
    writeConfigTree(repoRoot);
    const { computeConfigTreeDigest } = await import('../../src/lib/tooling-digest.ts');
    const digest = computeConfigTreeDigest(repoRoot);
    writeFileSync(
      join(repoRoot, 'config/digest.json'),
      `${JSON.stringify({ dest: digest, 'mirror-a': digest })}\n`
    );

    vi.resetModules();
    const { runMirrorInit } = await import('../../src/mirror-init/index.ts');
    await runMirrorInit({ SkipFetch: true, NoPoll: true });

    expect(initializeDestinationRepository).not.toHaveBeenCalled();
    expect(initializeNamedMirrorRepository).not.toHaveBeenCalled();
    expect(ghDispatchMirrorBlock).not.toHaveBeenCalled();
    expect(requireGhAuthenticated).not.toHaveBeenCalled();
  });

  test('dispatches mirror-poll when all pinned unless --no-poll', async () => {
    writeConfigTree(repoRoot);
    const { computeConfigTreeDigest } = await import('../../src/lib/tooling-digest.ts');
    const { MIRROR_POLL_BLOCK } = await import('../../src/git/mirror-block-dispatch.ts');
    const digest = computeConfigTreeDigest(repoRoot);
    writeFileSync(
      join(repoRoot, 'config/digest.json'),
      `${JSON.stringify({ dest: digest, 'mirror-a': digest })}\n`
    );

    vi.resetModules();
    const { runMirrorInit } = await import('../../src/mirror-init/index.ts');
    await runMirrorInit({ SkipFetch: true });

    expect(initializeDestinationRepository).not.toHaveBeenCalled();
    expect(initializeNamedMirrorRepository).not.toHaveBeenCalled();
    expect(requireGhAuthenticated).toHaveBeenCalled();
    expect(ghDispatchMirrorBlock).toHaveBeenCalledWith(
      MIRROR_POLL_BLOCK,
      'msys2-apiss',
      'msys2-apiss-sync',
      'main',
      expect.any(Object)
    );
  });
});
