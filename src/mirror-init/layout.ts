import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

export function refExists(repoPath: string, ref: string): boolean {
  try {
    runGitText(repoPath, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

export function firstCommitOfBranch(repoPath: string, branch: string): string {
  const raw = runGitText(repoPath, ['rev-list', '--max-parents=0', branch]).trim();
  const first = raw.split('\n')[0]?.trim();
  if (!first) {
    throw new Error(`Could not resolve first commit of ${branch} in ${repoPath}`);
  }
  return first;
}

export function fetchRemoteBranchGraph(
  repoPath: string,
  remote: string,
  branch: string,
  logger: Logger
): void {
  runGit(
    repoPath,
    [
      'fetch',
      '--filter=blob:none',
      remote,
      `refs/heads/${branch}:refs/remotes/${remote}/${branch}`
    ],
    {},
    5,
    logger
  );
}

export function fetchOriginBranchOptional(
  repoPath: string,
  branch: string,
  logger: Logger
): void {
  try {
    fetchRemoteBranchGraph(repoPath, 'origin', branch, logger);
  } catch {
    // Remote branch may not exist.
  }
}

function syncParent(repoPath: string, commit: string): string | null {
  const parents = runGitText(repoPath, ['rev-list', '--parents', '-n', '1', commit]).trim().split(/\s+/);
  return parents.length > 1 ? parents[1]! : null;
}

export function isToolingLayoutValid(
  repoPath: string,
  defaultRef: string,
  toolingBranch: string
): boolean {
  if (!refExists(repoPath, defaultRef) || !refExists(repoPath, toolingBranch)) {
    return false;
  }
  const root = firstCommitOfBranch(repoPath, defaultRef);
  const ahead = runGitText(repoPath, ['rev-list', '--count', toolingBranch, `^${defaultRef}`]).trim();
  if (ahead !== '1') {
    return false;
  }
  return syncParent(repoPath, toolingBranch) === root;
}

export function assertWorkingCopyMirror(mirrorPath: string): void {
  const resolved = realpathSync(mirrorPath);
  if (existsSync(join(resolved, 'objects')) && !existsSync(join(resolved, '.git'))) {
    throw new Error(
      `${mirrorPath} is a bare clone. Remove the directory and re-run yarn mirror-init ` +
        'for a working copy under .work/mirrors/.'
    );
  }
}

export function commitToolingBranchAtRoot(input: {
  RepoPath: string;
  DefaultRef: string;
  ToolingBranch: string;
  Paths: string[];
  Message: string;
  Logger: Logger;
  RestoreFromRef?: string;
}): void {
  const root = firstCommitOfBranch(input.RepoPath, input.DefaultRef);
  const restoreFrom = input.RestoreFromRef ?? input.ToolingBranch;
  const restoreSha = refExists(input.RepoPath, restoreFrom)
    ? runGitText(input.RepoPath, ['rev-parse', restoreFrom]).trim()
    : null;
  runGit(input.RepoPath, ['checkout', '-B', input.ToolingBranch, root], {}, 5, input.Logger);
  if (restoreSha && restoreSha !== root) {
    runGit(input.RepoPath, ['checkout', restoreSha, '--', ...input.Paths], {}, 5, input.Logger);
  }
  runGit(input.RepoPath, ['add', ...input.Paths], {}, 5, input.Logger);
  runGit(input.RepoPath, ['commit', '-m', input.Message], {}, 5, input.Logger);
}
