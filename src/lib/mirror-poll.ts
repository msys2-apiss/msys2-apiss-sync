import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';
import { getMirrorPollRepoNames, loadSyncConfig, type SyncConfig } from './config.ts';
import {
  ghCommandAvailable,
  ghDispatchMirrorSyncWorkflow,
  ghGetBranchSha,
  ghMirrorSyncRunInProgress,
  ghMirrorSyncWorkflowRegistered,
  getGhRepoDefaultBranch,
  requireGhCommand,
  setGhRepoDefaultBranch
} from './gh-cli.ts';
import type { SyncLogger } from './log.ts';
import { getMirrorSyncConfigPath } from './repos.ts';

export interface MirrorPollGitHub {
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  dispatchMirrorSync(repo: string, contentBranch: string): Promise<void>;
}

export function loadMirrorSyncConfigFile(repoRoot: string, repoName: string): MirrorSyncConfig | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as MirrorSyncConfig;
}

export function getMirrorContentBranch(repoRoot: string, repoName: string): string {
  const mirrorConfig = loadMirrorSyncConfigFile(repoRoot, repoName);
  const branch = mirrorConfig?.Branches?.[0]?.Mirror;
  if (!branch) {
    throw new Error(`config/mirror-sync/${repoName}.json: missing Branches[0].Mirror`);
  }
  return branch;
}

export function getUpstreamRefSha(upstreamUrl: string, branch: string, logger: SyncLogger): string | null {
  try {
    const out = execSync(`git ls-remote "${upstreamUrl}" "refs/heads/${branch}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (!out) {
      return null;
    }
    return out.split(/\s+/)[0] ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(`Could not read upstream ${upstreamUrl} ${branch}: ${message}; will dispatch`, 'Warn');
    return null;
  }
}

export async function mirrorRepoNeedsSync(input: {
  RepoName: string;
  MirrorConfig: MirrorSyncConfig | null;
  GitHub: MirrorPollGitHub;
  Logger: SyncLogger;
  GetUpstreamSha?: (upstreamUrl: string, branch: string) => string | null;
}): Promise<boolean> {
  const getUpstreamSha = input.GetUpstreamSha ?? ((url, branch) => getUpstreamRefSha(url, branch, input.Logger));

  if (!input.MirrorConfig) {
    input.Logger.write(`No config/mirror-sync/${input.RepoName}.json; dispatching ${input.RepoName}`, 'Warn');
    return true;
  }

  const { UpstreamUrl, Branches } = input.MirrorConfig;
  if (!UpstreamUrl || !Branches?.length) {
    input.Logger.write(`Invalid mirror-sync config for ${input.RepoName}; dispatching`, 'Warn');
    return true;
  }

  for (const entry of Branches) {
    const upstreamSha = getUpstreamSha(UpstreamUrl, entry.Upstream);
    if (!upstreamSha) {
      return true;
    }

    const mirrorSha = await input.GitHub.getBranchSha(input.RepoName, entry.Mirror);
    if (!mirrorSha) {
      input.Logger.write(
        `${input.RepoName}: missing mirror branch ${entry.Mirror}; dispatching mirror-sync`
      );
      return true;
    }
    if (mirrorSha !== upstreamSha) {
      input.Logger.write(
        `${input.RepoName}: ${entry.Mirror} ${mirrorSha.slice(0, 8)} != upstream ${upstreamSha.slice(0, 8)}`
      );
      return true;
    }
    input.Logger.write(`${input.RepoName}: ${entry.Mirror} matches upstream ${upstreamSha.slice(0, 8)}`);
  }

  return false;
}

class MirrorSyncDispatchNotFoundError extends Error {}

function mirrorSyncRunInProgress(owner: string, repo: string): boolean {
  return ghMirrorSyncRunInProgress(owner, repo) ?? false;
}

async function dispatchMirrorSyncWorkflow(input: {
  Owner: string;
  RepoName: string;
  Logger?: SyncLogger;
}): Promise<boolean> {
  requireGhCommand();
  const repoSlug = `${input.Owner}/${input.RepoName}`;
  if (input.Logger && mirrorSyncRunInProgress(input.Owner, input.RepoName)) {
    input.Logger.write(`Skip mirror-sync dispatch on ${repoSlug}: run already in progress`);
    return false;
  }
  const result = ghDispatchMirrorSyncWorkflow(input.Owner, input.RepoName, input.Logger);
  if (result.ok) {
    return true;
  }
  if (result.skipped) {
    return false;
  }
  if (result.notFound) {
    throw new MirrorSyncDispatchNotFoundError();
  }
  throw new Error(`gh workflow run failed for ${repoSlug}`);
}

async function dispatchWithRetry(
  owner: string,
  repo: string,
  contentBranch: string,
  logger: SyncLogger,
  maxAttempts = 4
): Promise<void> {
  let bootstrapped = false;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await dispatchMirrorSyncWorkflow({ Owner: owner, RepoName: repo, Logger: logger });
      return;
    } catch (error) {
      if (error instanceof MirrorSyncDispatchNotFoundError && !bootstrapped) {
        bootstrapped = true;
        logger.write(`${repo}: mirror-sync not registered; bootstrapping workflow`, 'Warn');
        await ensureMirrorSyncWorkflowRegistered({
          Owner: owner,
          RepoName: repo,
          ContentBranch: contentBranch,
          Logger: logger
        });
        continue;
      }
      if (error instanceof MirrorSyncDispatchNotFoundError) {
        throw new Error(
          `${owner}/${repo}: mirror-sync.yml not found for workflow_dispatch after bootstrap. ` +
            'See docs/add-mirror.md.'
        );
      }
      if (attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      logger.write(
        `Dispatch attempt ${attempt} failed, retry in ${delayMs}ms`,
        'Warn'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function mirrorSyncWorkflowRegistered(owner: string, repoName: string): boolean {
  requireGhCommand();
  return ghMirrorSyncWorkflowRegistered(owner, repoName) ?? false;
}

async function waitForMirrorSyncWorkflowRegistered(input: {
  Owner: string;
  RepoName: string;
  Logger: SyncLogger;
  maxAttempts?: number;
}): Promise<boolean> {
  const maxAttempts = input.maxAttempts ?? 5;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (mirrorSyncWorkflowRegistered(input.Owner, input.RepoName)) {
      return true;
    }
    if (attempt === maxAttempts) {
      return false;
    }
    const delayMs = 2000;
    input.Logger.write(
      `${input.RepoName}: waiting for mirror-sync workflow registration (${attempt}/${maxAttempts})`,
      'Warn'
    );
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

export function mirrorSyncReadyState(input: {
  WorkflowRegistered: boolean;
}): 'normal' | 'bootstrap' {
  return input.WorkflowRegistered ? 'normal' : 'bootstrap';
}

export async function mirrorRepoReadyForNormalSync(
  owner: string,
  repoName: string
): Promise<boolean> {
  return mirrorSyncWorkflowRegistered(owner, repoName);
}

async function ensureMirrorSyncWorkflowRegistered(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
}): Promise<void> {
  if (mirrorSyncWorkflowRegistered(input.Owner, input.RepoName)) {
    return;
  }
  input.Logger.write(
    `${input.RepoName}: registering mirror-sync (temporary default branch sync)`
  );
  const currentDefault = getGhRepoDefaultBranch(input.Owner, input.RepoName);
  if (currentDefault !== 'sync') {
    setGhRepoDefaultBranch(input.Owner, input.RepoName, 'sync', input.Logger);
  }
  const ready = await waitForMirrorSyncWorkflowRegistered(input);
  if (!ready) {
    throw new Error(
      `${input.Owner}/${input.RepoName}: mirror-sync workflow did not register after ` +
        'setting default branch to sync'
    );
  }
}

async function restoreMirrorContentDefaultBranch(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
}): Promise<void> {
  if (input.ContentBranch === 'sync' || !ghCommandAvailable()) {
    return;
  }
  const currentDefault = getGhRepoDefaultBranch(input.Owner, input.RepoName);
  if (currentDefault === null || currentDefault === input.ContentBranch) {
    return;
  }
  setGhRepoDefaultBranch(
    input.Owner,
    input.RepoName,
    input.ContentBranch,
    input.Logger
  );
}

async function runMirrorSyncDispatch(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
}): Promise<void> {
  if (!ghCommandAvailable()) {
    return;
  }
  if (await mirrorRepoReadyForNormalSync(input.Owner, input.RepoName)) {
    input.Logger.write(`${input.RepoName}: mirror ready; triggering mirror-sync`);
    await dispatchMirrorSyncWorkflow({
      Owner: input.Owner,
      RepoName: input.RepoName,
      Logger: input.Logger
    });
    return;
  }

  input.Logger.write(`${input.RepoName}: bootstrapping mirror-sync before trigger`);
  if (!mirrorSyncWorkflowRegistered(input.Owner, input.RepoName)) {
    await ensureMirrorSyncWorkflowRegistered(input);
  }

  const triggered = await dispatchMirrorSyncWorkflow({
    Owner: input.Owner,
    RepoName: input.RepoName,
    Logger: input.Logger
  });
  if (triggered) {
    input.Logger.write(`Triggered mirror-sync on ${input.Owner}/${input.RepoName}`);
  }
}

/** After push to sync: bootstrap when needed, dispatch mirror-sync, restore default (gh). */
export async function startMirrorSyncAfterPush(input: {
  Owner: string;
  RepoName: string;
  ContentBranch: string;
  Logger: SyncLogger;
}): Promise<void> {
  await runMirrorSyncDispatch(input);
  await restoreMirrorContentDefaultBranch(input);
}

export function createMirrorPollGitHub(owner: string, logger: SyncLogger): MirrorPollGitHub {
  return {
    async getBranchSha(repo, branch) {
      return ghGetBranchSha(owner, repo, branch);
    },
    async dispatchMirrorSync(repo, contentBranch) {
      await dispatchWithRetry(owner, repo, contentBranch, logger);
    }
  };
}

export async function runMirrorPoll(input: {
  RepoRoot: string;
  Config: SyncConfig;
  GitHub: MirrorPollGitHub;
  Logger: SyncLogger;
}): Promise<void> {
  const mirrorOwner = input.Config.Owner;
  for (const repo of getMirrorPollRepoNames(input.Config)) {
    const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, repo);
    const needsSync = await mirrorRepoNeedsSync({
      RepoName: repo,
      MirrorConfig: mirrorConfig,
      GitHub: input.GitHub,
      Logger: input.Logger
    });
    if (!needsSync) {
      input.Logger.write(`Skip mirror-sync on ${mirrorOwner}/${repo}: branch HEAD matches upstream`);
      continue;
    }
    const contentBranch = mirrorConfig?.Branches?.[0]?.Mirror ?? 'master';
    await input.GitHub.dispatchMirrorSync(repo, contentBranch);
    input.Logger.write(`Triggered mirror-sync on ${mirrorOwner}/${repo}`);
  }
}
