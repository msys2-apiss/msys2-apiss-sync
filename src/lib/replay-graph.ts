import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { CommitParentMap } from './queue.ts';
import { writeJsonFile } from './log.ts';

export interface SerializedMirrorParentGraph {
  Branch: string;
  TipSha: string;
  Parents: [string, string[]][];
}

export function serializeCommitParentMap(
  branch: string,
  tipSha: string,
  parentMap: CommitParentMap
): SerializedMirrorParentGraph {
  const parents: [string, string[]][] = [];
  for (const [sha, parentList] of parentMap) {
    parents.push([sha, [...parentList]]);
  }
  return {
    Branch: branch,
    TipSha: tipSha,
    Parents: parents
  };
}

export function deserializeCommitParentMap(serialized: SerializedMirrorParentGraph): CommitParentMap {
  const parentMap = new Map<string, readonly string[]>();
  for (const [sha, parentList] of serialized.Parents) {
    parentMap.set(sha, parentList);
  }
  return parentMap;
}

export function getMirrorParentGraphCachePath(
  cacheDir: string,
  sourceKey: string,
  branch: string,
  tipSha: string
): string {
  return join(cacheDir, `parent-map-${sourceKey}-${branch}-${tipSha}.json`);
}

export function saveMirrorParentGraph(
  cachePath: string,
  branch: string,
  tipSha: string,
  parentMap: CommitParentMap
): void {
  writeJsonFile(cachePath, serializeCommitParentMap(branch, tipSha, parentMap));
}

export function loadSerializedMirrorParentGraph(cachePath: string): SerializedMirrorParentGraph | null {
  if (!existsSync(cachePath)) {
    return null;
  }

  return JSON.parse(readFileSync(cachePath, 'utf8')) as SerializedMirrorParentGraph;
}

export function loadMirrorParentGraph(cachePath: string): CommitParentMap | null {
  const serialized = loadSerializedMirrorParentGraph(cachePath);
  if (!serialized) {
    return null;
  }

  return deserializeCommitParentMap(serialized);
}

export async function loadOrBuildMirrorCommitParentMap(input: {
  CachePath: string;
  Branch: string;
  TipSha: string;
  Build: () => Promise<CommitParentMap>;
}): Promise<CommitParentMap> {
  const cached = loadMirrorParentGraph(input.CachePath);
  if (cached) {
    return cached;
  }

  const parentMap = await input.Build();
  saveMirrorParentGraph(input.CachePath, input.Branch, input.TipSha, parentMap);
  return parentMap;
}
