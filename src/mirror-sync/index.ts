import { appendFileSync, existsSync, readFileSync } from 'node:fs';

import { runGit, runGitText } from '../lib/git.ts';
import type { SyncLogger } from '../lib/log.ts';
import type { MirrorSyncBranchPair, MirrorSyncConfig } from '../types/mirror-sync-config.ts';

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
  Logger: SyncLogger;
  PushTags?: boolean;
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
    EventType: config.Notify.EventType
  };
}

function getRefSha(repoPath: string, ref: string): string | null {
  try {
    return runGitText(repoPath, ['rev-parse', ref]).trim() || null;
  } catch {
    return null;
  }
}

function pushMirrorRef(repoPath: string, refspec: string, logger: SyncLogger): void {
  runGit(repoPath, ['push', 'origin', refspec], {}, 5, logger);
}

function pushMirrorTags(repoPath: string, logger: SyncLogger): void {
  try {
    runGit(repoPath, ['push', 'origin', '--tags'], {}, 5, logger);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(`Tag push failed: ${message}`, 'Warn');
  }
}

export function syncMirrorBranch(input: {
  RepoPath: string;
  Branch: MirrorSyncBranchPair;
  Logger: SyncLogger;
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
  const advanced = mirrorBranchNeedsUpdate(beforeSha, afterSha);
  if (!advanced) {
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
  pushMirrorRef(RepoPath, `upstream/${Branch.Upstream}:refs/heads/${Branch.Mirror}`, Logger);
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

  try {
    runGit(input.RepoPath, ['remote', 'add', 'upstream', input.Config.UpstreamUrl], {}, 1);
  } catch {
    runGit(input.RepoPath, ['remote', 'set-url', 'upstream', input.Config.UpstreamUrl], {}, 1);
  }

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
    if (input.PushTags ?? true) {
      pushMirrorTags(input.RepoPath, input.Logger);
    }
  }

  const primary = advancedBranches[0] ?? null;
  return {
    Advanced: advancedBranches.length > 0,
    PrimarySha: primary?.AfterSha ?? null,
    PrimaryRef: primary ? `refs/heads/${primary.Mirror}` : null,
    Notify: getMirrorSyncNotify(input.Config),
    Branches: branches
  };
}

export function writeGitHubOutput(path: string, result: MirrorSyncResult): void {
  const lines = [`advanced=${result.Advanced ? 'true' : 'false'}`];
  if (result.Advanced && result.PrimarySha && result.PrimaryRef) {
    lines.push(`sha=${result.PrimarySha}`);
    lines.push(`ref=${result.PrimaryRef}`);
  }
  lines.push(`notify=${result.Notify.Enabled ? 'true' : 'false'}`);
  if (result.Notify.Enabled) {
    lines.push(`notify_repository=${result.Notify.Repository ?? ''}`);
    lines.push(`notify_event_type=${result.Notify.EventType ?? ''}`);
  }
  appendFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}
