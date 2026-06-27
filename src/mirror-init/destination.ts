import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorMergeWorkflowTemplatePath,
  MIRROR_MERGE_BRANCH,
  type SyncConfig
} from './config.ts';
import {
  fetchOriginBranchOptional,
  fetchRemoteBranchGraph,
  firstCommitOfBranch,
  isToolingLayoutValid,
  refExists
} from './layout.ts';
import { ghRemoteHasBranch, ghRepoClone } from '../git/gh.ts';
import { runGit, runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

const MIRROR_MERGE_COMMIT_MESSAGE =
  'Install mirror-merge workflow from msys2-apiss-sync template';

function mergeWorkflowMatchesTemplate(repoPath: string, templatePath: string): boolean {
  try {
    const remote = runGitText(repoPath, [
      'show',
      `${MIRROR_MERGE_BRANCH}:.github/workflows/mirror-merge.yml`
    ]);
    return remote.replace(/\r\n/g, '\n') === readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return false;
  }
}

export function installMirrorMergeWorkflow(input: {
  RepoRoot: string;
  WorkDirectory: string;
  Config: SyncConfig;
  Push: boolean;
  Logger: Logger;
}): boolean {
  const owner = input.Config.Owner;
  const repo = input.Config.Destination.Repo;
  const defaultBranch = input.Config.Destination.DefaultBranch ?? 'main';
  const templatePath = getMirrorMergeWorkflowTemplatePath(input.RepoRoot);
  if (!existsSync(templatePath)) {
    throw new Error(`Missing mirror-merge template: ${templatePath}`);
  }

  const repoPath = join(input.WorkDirectory, 'mirror-merge-ci');
  if (!existsSync(repoPath)) {
    ghRepoClone(owner, repo, repoPath, input.Logger);
  } else {
    runGit(repoPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  }

  fetchRemoteBranchGraph(repoPath, 'origin', defaultBranch, input.Logger);
  fetchOriginBranchOptional(repoPath, MIRROR_MERGE_BRANCH, input.Logger);

  const originDefault = `origin/${defaultBranch}`;
  if (!refExists(repoPath, originDefault)) {
    throw new Error(`Cannot install ${MIRROR_MERGE_BRANCH}: missing ${originDefault}`);
  }

  if (
    isToolingLayoutValid(repoPath, originDefault, MIRROR_MERGE_BRANCH) &&
    mergeWorkflowMatchesTemplate(repoPath, templatePath)
  ) {
    input.Logger.write(`${owner}/${repo}: ${MIRROR_MERGE_BRANCH} workflow already matches template`);
    return false;
  }

  const root = firstCommitOfBranch(repoPath, originDefault);
  runGit(repoPath, ['checkout', '-B', MIRROR_MERGE_BRANCH, root], {}, 5, input.Logger);
  const workflowsDir = join(repoPath, '.github', 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  copyFileSync(templatePath, join(workflowsDir, 'mirror-merge.yml'));
  runGit(repoPath, ['add', '.github/workflows/mirror-merge.yml'], {}, 5, input.Logger);
  runGit(repoPath, ['commit', '-m', MIRROR_MERGE_COMMIT_MESSAGE], {}, 5, input.Logger);
  input.Logger.write(`Updated ${MIRROR_MERGE_BRANCH} workflow on ${owner}/${repo}`);

  if (!input.Push) {
    return true;
  }
  if (!ghRemoteHasBranch(owner, repo, MIRROR_MERGE_BRANCH)) {
    runGit(repoPath, ['push', '-u', 'origin', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
  } else {
    runGit(repoPath, ['push', 'origin', MIRROR_MERGE_BRANCH], {}, 5, input.Logger);
  }
  input.Logger.write(`Pushed ${MIRROR_MERGE_BRANCH} to ${owner}/${repo}`);
  return true;
}
