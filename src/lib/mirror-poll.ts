import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import type { MirrorSyncConfig } from '../types/mirror-sync-config.ts';
import { getMirrorPollRepoNames, loadSyncConfig, type SyncConfig } from './config.ts';
import type { SyncLogger } from './log.ts';
import { getMirrorSyncConfigPath } from './repos.ts';

const GITHUB_API_VERSION = '2026-03-10';

export interface MirrorPollGitHub {
  getBranchSha(repo: string, branch: string): Promise<string | null>;
  dispatchMirrorSync(repo: string): Promise<void>;
}

export function loadMirrorSyncConfigFile(repoRoot: string, repoName: string): MirrorSyncConfig | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  return JSON.parse(readFileSync(configPath, 'utf8')) as MirrorSyncConfig;
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

class GitHubApiError extends Error {
  status: number;

  constructor(status: number, body: string) {
    super(`GitHub API ${status}: ${body}`);
    this.status = status;
  }
}

async function githubRequest<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<T | undefined> {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(init?.headers ?? {})
    }
  });
  if (res.status === 404) {
    throw new GitHubApiError(404, await res.text());
  }
  if (!res.ok) {
    throw new GitHubApiError(res.status, await res.text());
  }
  if (res.status === 204) {
    return undefined;
  }
  return (await res.json()) as T;
}

async function dispatchWithRetry(
  token: string,
  owner: string,
  repo: string,
  logger: SyncLogger,
  maxAttempts = 4
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await githubRequest(
        token,
        `/repos/${owner}/${repo}/actions/workflows/mirror-sync.yml/dispatches`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'sync' })
        }
      );
      return;
    } catch (error) {
      const status = error instanceof GitHubApiError ? error.status : undefined;
      const retryable = status === undefined || status >= 500 || status === 429;
      if (!retryable || attempt === maxAttempts) {
        throw error;
      }
      const delayMs = 1000 * 2 ** (attempt - 1);
      logger.write(
        `Dispatch attempt ${attempt} failed (${status ?? 'unknown'}), retry in ${delayMs}ms`,
        'Warn'
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export function createMirrorPollGitHub(token: string, owner: string, logger: SyncLogger): MirrorPollGitHub {
  return {
    async getBranchSha(repo, branch) {
      try {
        const data = await githubRequest<{ commit: { sha: string } }>(
          token,
          `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`
        );
        return data?.commit.sha ?? null;
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          return null;
        }
        throw error;
      }
    },
    async dispatchMirrorSync(repo) {
      await dispatchWithRetry(token, owner, repo, logger);
    }
  };
}

export async function runMirrorPoll(input: {
  RepoRoot: string;
  Config: SyncConfig;
  MirrorOwner: string;
  GitHub: MirrorPollGitHub;
  Logger: SyncLogger;
}): Promise<void> {
  const mirrorOwner = input.MirrorOwner;
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
    await input.GitHub.dispatchMirrorSync(repo);
    input.Logger.write(`Triggered mirror-sync on ${mirrorOwner}/${repo}`);
  }
}
