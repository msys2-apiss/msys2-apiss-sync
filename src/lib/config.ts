import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SourceKey } from '../types/replay-entry.ts';

export interface SourceConfigEntry {
  Owner: string;
  Repo: string;
  Branch: string;
  DestSubdir: string;
  SortKey: string;
}

export interface MirrorOnlyEntry {
  UpstreamUrl: string;
  Branch: string;
}

export type MirrorOnlyKey = string;

export function getMirrorRepoNameByKey(config: SyncConfig, key: string): string | undefined {
  const value = (config.Mirrors as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

export interface SyncConfig {
  ReplaySpecVersion: number;
  Destination: {
    Owner: string;
    Repo: string;
    Url?: string;
    BaseCommit: string;
    Branches: {
      Replay: string;
      CursorPorts: string;
      CursorPortsMingw: string;
    };
  };
  Sources: Record<SourceKey, SourceConfigEntry>;
  Mirrors: {
    Owner: string;
    Ports: string;
    PortsMingw: string;
    MingwW64?: string;
    Glibc?: string;
    SyncIntervalMinutes: number;
    DispatchEventType: string;
  };
  MirrorOnly?: Partial<Record<MirrorOnlyKey, MirrorOnlyEntry>>;
  Replay: {
    MinReplayAgeMinutes?: number;
    SkipEmptyTreeDiff: boolean;
    LineEnding: string;
    CommitMessagePrefix: boolean;
  };
  PollIntervalMinutes: number;
  DailyReconciliationCron: string;
}

export function getSyncRepoRoot(startPath = dirname(fileURLToPath(import.meta.url))): string {
  let current = startPath;
  while (true) {
    try {
      readFileSync(join(current, 'config', 'sync.json'), 'utf8');
      return current;
    } catch (error) {
      const parent = dirname(current);
      if (parent === current) {
        throw new Error('Could not locate sync repo root (config/sync.json not found).');
      }
      current = parent;
    }
  }
}

export function loadSyncConfig(repoRoot = getSyncRepoRoot(), configPath?: string): SyncConfig {
  const path = configPath ?? join(repoRoot, 'config', 'sync.json');
  return JSON.parse(readFileSync(path, 'utf8')) as SyncConfig;
}

export function getSourceRepoSlug(sourceEntry: SourceConfigEntry): string {
  return `${sourceEntry.Owner}/${sourceEntry.Repo}`;
}

export function getSourceCloneUrl(sourceEntry: SourceConfigEntry): string {
  return `https://github.com/${getSourceRepoSlug(sourceEntry)}.git`;
}

export function getDestinationCloneUrl(config: SyncConfig): string {
  return config.Destination.Url ?? `https://github.com/${config.Destination.Owner}/${config.Destination.Repo}.git`;
}

export function getMirrorCloneUrl(config: SyncConfig, mirrorKey: SourceKey): string {
  return getMirrorCloneUrlByRepoName(config, config.Mirrors[mirrorKey]);
}

export function getMirrorCloneUrlByRepoName(config: SyncConfig, repoName: string): string {
  return `https://github.com/${config.Mirrors.Owner}/${repoName}.git`;
}

export function getMirrorPollRepoNames(config: SyncConfig): string[] {
  const repos = [config.Mirrors.Ports, config.Mirrors.PortsMingw];
  if (config.MirrorOnly) {
    for (const key of Object.keys(config.MirrorOnly)) {
      const repo = getMirrorRepoNameByKey(config, key);
      if (repo) {
        repos.push(repo);
      }
    }
  }
  return repos;
}

export function getMirrorOnlyEntryForRepo(
  config: SyncConfig,
  repoName: string
): MirrorOnlyEntry | null {
  if (!config.MirrorOnly) {
    return null;
  }
  for (const key of Object.keys(config.MirrorOnly)) {
    const entry = config.MirrorOnly[key];
    const repo = getMirrorRepoNameByKey(config, key);
    if (entry && repo === repoName) {
      return entry;
    }
  }
  return null;
}

export function getSourceConfigEntry(config: SyncConfig, sourceKey: SourceKey): SourceConfigEntry {
  return config.Sources[sourceKey];
}
