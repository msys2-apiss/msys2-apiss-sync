import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { getSyncRepoRoot } from '../../src/lib/config.ts';
import { getWorkDirectory } from '../../src/lib/log.ts';
import {
  buildReverseTopologicalQueueShas,
  precomputeForkSafeFlagsFromParentMap,
  precomputeForkSafeFlagsForQueue,
  shasToMinimalQueueEntries
} from '../../src/lib/fork-safe.ts';
import {
  deserializeCommitParentMap,
  getMirrorParentGraphCachePath,
  loadSerializedMirrorParentGraph
} from '../../src/lib/replay-graph.ts';
import type { CommitParentMap } from '../../src/lib/queue.ts';

function forkParentMap(): CommitParentMap {
  return new Map<string, readonly string[]>([
    ['base', []],
    ['left', ['base']],
    ['right', ['base']]
  ]);
}

describe('buildReverseTopologicalQueueShas', () => {
  test('orders a linear chain root to tip', () => {
    const parentMap: CommitParentMap = new Map([
      ['c1', []],
      ['c2', ['c1']],
      ['c3', ['c2']]
    ]);
    expect(buildReverseTopologicalQueueShas(parentMap, 'c3')).toEqual(['c1', 'c2', 'c3']);
  });

  test('orders a fork with tip on first-parent mainline', () => {
    const parentMap = forkParentMap();
    expect(buildReverseTopologicalQueueShas(parentMap, 'right')).toEqual(['base', 'left', 'right']);
  });
});

describe('precomputeForkSafeFlagsFromParentMap', () => {
  test('marks fork siblings unsafe on side branch', () => {
    const parentMap = forkParentMap();
    const result = precomputeForkSafeFlagsFromParentMap(parentMap, 'right');
    expect(result.Shas).toEqual(['base', 'left', 'right']);
    expect(result.Flags).toEqual([true, false, true]);
  });

  test('matches explicit queue order', () => {
    const parentMap = forkParentMap();
    const queue = shasToMinimalQueueEntries(['base', 'left', 'right']);
    const flags = precomputeForkSafeFlagsForQueue(queue, parentMap, 'right');
    expect(flags).toEqual([true, false, true]);
  });

  test('suffix flags match full-history flags', () => {
    const parentMap = forkParentMap();
    const full = precomputeForkSafeFlagsFromParentMap(parentMap, 'right');
    const suffix = precomputeForkSafeFlagsFromParentMap(parentMap, 'right', {
      QueueShas: ['left', 'right']
    });
    expect(suffix.Flags).toEqual(full.Flags.slice(1));
  });

  test('mainline commit stays safe with parallel side sibling in suffix', () => {
    const parentMap: CommitParentMap = new Map([
      ['base', []],
      ['main', ['base']],
      ['side', ['base']]
    ]);
    const queue = shasToMinimalQueueEntries(['base', 'main', 'side']);
    const flags = precomputeForkSafeFlagsForQueue(queue, parentMap, 'main');
    expect(flags).toEqual([true, true, false]);
  });
});

describe('saved parent map cache', () => {
  test('derives queue order from cached ports graph', () => {
    const cacheDir = join(getWorkDirectory(getSyncRepoRoot()), 'cache', 'replay-graph');
    if (!existsSync(cacheDir)) {
      return;
    }

    const portsCachePath = getMirrorParentGraphCachePath(
      cacheDir,
      'Ports',
      'master',
      'aac3de013fac752c5d052883f4de45b574005bc2'
    );
    if (!existsSync(portsCachePath)) {
      return;
    }

    const serialized = loadSerializedMirrorParentGraph(portsCachePath)!;
    const parentMap = deserializeCommitParentMap(serialized);
    const shas = buildReverseTopologicalQueueShas(parentMap, serialized.TipSha);
    expect(shas.length).toBe(serialized.Parents.length);
    expect(shas[shas.length - 1]).toBe(serialized.TipSha);
  });
});
