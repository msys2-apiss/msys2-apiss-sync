import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';
import type { MirrorSyncBranchPair, MirrorSyncConfig } from '../types/mirror-sync-config.ts';

export type { Logger } from '../git/log.ts';

export const MIRROR_MERGE_DISPATCH_EVENT = 'workflow_dispatch_mirror_merge';

export interface MirrorSyncBranchResult {
  Upstream: string;
  Mirror: string;
  BeforeSha: string | null;
  AfterSha: string;
  Advanced: boolean;
}

export interface MirrorSyncResult {
  Advanced: boolean;
  PrimarySha: string | null;
  PrimaryRef: string | null;
  /** True when mirror advanced and Notify.Enabled: dispatch Block 4 CI. */
  DispatchMirrorMerge: boolean;
  Notify: {
    Enabled: boolean;
    Repository?: string;
    EventType?: string;
  };
  Branches: MirrorSyncBranchResult[];
}

export interface MirrorSyncOptions {
  RepoPath: string;
  Config: MirrorSyncConfig;
  Logger: Logger;
}

export function loadMirrorSyncConfig(path: string): MirrorSyncConfig {
  if (!existsSync(path)) {
    throw new Error(`Missing ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as MirrorSyncConfig;
}

export function validateMirrorSyncConfig(config: MirrorSyncConfig): void {
  if (!config.UpstreamUrl) {
    throw new Error('UpstreamUrl is required');
  }
  if (!config.Branches?.length) {
    throw new Error('Branches must contain at least one entry');
  }
  for (const branch of config.Branches) {
    if (!branch.Upstream || !branch.Mirror) {
      throw new Error('Each Branches entry must include Upstream and Mirror');
    }
  }
}

export function mirrorBranchNeedsUpdate(beforeSha: string | null, afterSha: string): boolean {
  return beforeSha !== afterSha;
}

export function getMirrorSyncNotify(config: MirrorSyncConfig): MirrorSyncResult['Notify'] {
  if (!config.Notify?.Enabled) {
    return { Enabled: false };
  }
  return {
    Enabled: true,
    Repository: config.Notify.Repository,
    EventType: config.Notify.EventType ?? MIRROR_MERGE_DISPATCH_EVENT
  };
}

export function shouldDispatchMirrorMerge(result: Pick<MirrorSyncResult, 'Advanced' | 'Notify'>): boolean {
  return result.Advanced && result.Notify.Enabled;
}

function getRefSha(repoPath: string, ref: string): string | null {
  try {
    return runGitText(repoPath, ['rev-parse', ref]).trim() || null;
  } catch {
    return null;
  }
}

function ensureUpstreamRemote(repoPath: string, upstreamUrl: string): void {
  try {
    runGit(repoPath, ['remote', 'add', 'upstream', upstreamUrl], {}, 1);
  } catch {
    runGit(repoPath, ['remote', 'set-url', 'upstream', upstreamUrl], {}, 1);
  }
}

function syncMirrorBranch(input: {
  RepoPath: string;
  Branch: MirrorSyncBranchPair;
  Logger: Logger;
}): MirrorSyncBranchResult {
  const { RepoPath, Branch, Logger } = input;
  Logger.write(`Syncing ${Branch.Upstream} -> ${Branch.Mirror}`);

  runGit(RepoPath, ['fetch', 'upstream', Branch.Upstream], {}, 5, Logger);
  try {
    runGit(RepoPath, ['fetch', 'origin', Branch.Mirror], {}, 5, Logger);
  } catch {
    // First push for an empty mirror may not have origin/<branch> yet.
  }

  const beforeSha = getRefSha(RepoPath, `origin/${Branch.Mirror}`);
  const afterSha = runGitText(RepoPath, ['rev-parse', `upstream/${Branch.Upstream}`]).trim();
  if (!mirrorBranchNeedsUpdate(beforeSha, afterSha)) {
    Logger.write(`No upstream changes for ${Branch.Mirror}.`);
    return {
      Upstream: Branch.Upstream,
      Mirror: Branch.Mirror,
      BeforeSha: beforeSha,
      AfterSha: afterSha,
      Advanced: false
    };
  }

  Logger.write(`Advanced ${Branch.Mirror} from ${beforeSha ?? '<none>'} to ${afterSha}`);
  runGit(RepoPath, ['push', 'origin', `upstream/${Branch.Upstream}:refs/heads/${Branch.Mirror}`], {}, 5, Logger);
  return {
    Upstream: Branch.Upstream,
    Mirror: Branch.Mirror,
    BeforeSha: beforeSha,
    AfterSha: afterSha,
    Advanced: true
  };
}

export function runMirrorSync(input: MirrorSyncOptions): MirrorSyncResult {
  validateMirrorSyncConfig(input.Config);
  ensureUpstreamRemote(input.RepoPath, input.Config.UpstreamUrl);

  const branches = input.Config.Branches.map((branch) =>
    syncMirrorBranch({
      RepoPath: input.RepoPath,
      Branch: branch,
      Logger: input.Logger
    })
  );
  const advancedBranches = branches.filter((branch) => branch.Advanced);

  if (input.Config.SyncTags ?? true) {
    input.Logger.write('Syncing tags from upstream');
    runGit(input.RepoPath, ['fetch', 'upstream', '--tags'], {}, 5, input.Logger);
    try {
      runGit(input.RepoPath, ['push', 'origin', '--tags'], {}, 5, input.Logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.Logger.write(`Tag push failed: ${message}`, 'Warn');
    }
  }

  const primary = advancedBranches[0] ?? null;
  const notify = getMirrorSyncNotify(input.Config);
  const advanced = advancedBranches.length > 0;
  return {
    Advanced: advanced,
    PrimarySha: primary?.AfterSha ?? null,
    PrimaryRef: primary ? `refs/heads/${primary.Mirror}` : null,
    Notify: notify,
    Branches: branches,
    DispatchMirrorMerge: advanced && notify.Enabled
  };
}

export function writeGitHubOutput(path: string, result: MirrorSyncResult): void {
  const lines = [`advanced=${result.Advanced ? 'true' : 'false'}`];
  if (result.Advanced && result.PrimarySha && result.PrimaryRef) {
    lines.push(`sha=${result.PrimarySha}`);
    lines.push(`ref=${result.PrimaryRef}`);
  }
  lines.push(`notify=${result.Notify.Enabled ? 'true' : 'false'}`);
  lines.push(`dispatch_mirror_merge=${result.DispatchMirrorMerge ? 'true' : 'false'}`);
  if (result.Notify.Enabled) {
    lines.push(`notify_repository=${result.Notify.Repository ?? ''}`);
    lines.push(`notify_event_type=${result.Notify.EventType ?? ''}`);
  }
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}
