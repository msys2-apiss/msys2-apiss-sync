import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorCloneUrl,
  getMirrorSyncConfigPath,
  getMirrorSyncWorkflowTemplatePath,
  getSyncRepoRoot,
  MIRROR_SYNC_BRANCH,
  type SyncConfig
} from './config.ts';
import {
  assertWorkingCopyMirror,
  commitToolingBranchAtRoot,
  fetchOriginBranchOptional,
  fetchRemoteBranchGraph,
  firstCommitOfBranch,
  isToolingLayoutValid,
  refExists
} from './layout.ts';
import { ghRemoteHasBranch, ghRepoClone } from '../git/gh.ts';
import { applyMirrorSyncToolings, mirrorSyncToolingsMatch } from './toolings.ts';
import { githubSshPushUrl, runGit, runGitText, testGitAncestor } from '../git/index.ts';
import type { Logger } from '../git/log.ts';

export const MIRROR_SYNC_COMMIT_MESSAGE =
  'Mirror sync workflow from msys2-apiss-sync\n\n' +
  'https://github.com/msys2-apiss/msys2-apiss-sync/tree/main/config/mirror-sync\n' +
  'https://github.com/msys2-apiss/msys2-apiss-sync/blob/main/config/mirror-template/mirror-sync.yml';

function contentDefaultRef(mirrorPath: string, contentBranch: string): string {
  const originContent = `origin/${contentBranch}`;
  return refExists(mirrorPath, originContent) ? originContent : contentBranch;
}

function loadMirrorUpstreamUrl(repoRoot: string, repoName: string): string | null {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  if (!existsSync(configPath)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as { UpstreamUrl?: string };
  return parsed.UpstreamUrl ?? null;
}

function normalizeText(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

function mirrorSyncFilesMatchTemplates(
  mirrorPath: string,
  repoRoot: string,
  repoName: string,
  toolingsRoot: string
): boolean {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  const workflowPath = getMirrorSyncWorkflowTemplatePath(repoRoot);
  const mirrorJson = join(mirrorPath, '.github', 'mirror-sync.json');
  const mirrorYml = join(mirrorPath, '.github', 'workflows', 'mirror-sync.yml');
  if (!existsSync(mirrorJson) || !existsSync(mirrorYml)) {
    return false;
  }
  const jsonEqual =
    JSON.stringify(JSON.parse(readFileSync(mirrorJson, 'utf8'))) ===
    JSON.stringify(JSON.parse(readFileSync(configPath, 'utf8')));
  const ymlEqual =
    normalizeText(readFileSync(mirrorYml, 'utf8')) === normalizeText(readFileSync(workflowPath, 'utf8'));
  return jsonEqual && ymlEqual && mirrorSyncToolingsMatch(mirrorPath, toolingsRoot);
}

function copyMirrorSyncTemplates(mirrorPath: string, repoRoot: string, repoName: string, logger: Logger): void {
  const configPath = getMirrorSyncConfigPath(repoRoot, repoName);
  const workflowPath = getMirrorSyncWorkflowTemplatePath(repoRoot);
  const githubDir = join(mirrorPath, '.github');
  const workflowsDir = join(githubDir, 'workflows');
  mkdirSync(workflowsDir, { recursive: true });
  copyFileSync(configPath, join(githubDir, 'mirror-sync.json'));
  copyFileSync(workflowPath, join(workflowsDir, 'mirror-sync.yml'));
  applyMirrorSyncToolings(mirrorPath, getSyncRepoRoot(), logger);
  logger.write(`Applied config/mirror-sync/${repoName}.json to ${mirrorPath}`);
}

export function mirrorOriginHasContent(
  owner: string,
  repoName: string,
  contentBranch: string
): boolean {
  return (
    ghRemoteHasBranch(owner, repoName, contentBranch) ||
    ghRemoteHasBranch(owner, repoName, MIRROR_SYNC_BRANCH)
  );
}

export function bootstrapMirrorFromUpstreamRoot(input: {
  UpstreamUrl: string;
  OriginUrl: string;
  MirrorPath: string;
  ContentBranch: string;
  RepoName: string;
  Logger: Logger;
}): void {
  input.Logger.write(
    `Bootstrapping ${input.RepoName}: fetch upstream ${input.ContentBranch} commit graph (blob:none)`
  );
  runGit(null, ['init', input.MirrorPath], {}, 5, input.Logger);
  runGit(input.MirrorPath, ['remote', 'add', 'upstream', input.UpstreamUrl], {}, 5, input.Logger);
  runGit(input.MirrorPath, ['remote', 'add', 'origin', input.OriginUrl], {}, 5, input.Logger);
  fetchRemoteBranchGraph(input.MirrorPath, 'upstream', input.ContentBranch, input.Logger);
  const root = firstCommitOfBranch(input.MirrorPath, `upstream/${input.ContentBranch}`);
  runGit(input.MirrorPath, ['checkout', '-B', input.ContentBranch, root], {}, 5, input.Logger);
  runGit(
    input.MirrorPath,
    ['update-ref', `refs/remotes/origin/${input.ContentBranch}`, root],
    {},
    5,
    input.Logger
  );
  runGit(input.MirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, root], {}, 5, input.Logger);
}

export function repairSyncBranchLayout(
  mirrorPath: string,
  contentBranch: string,
  logger: Logger,
  options?: { CommitMessage?: string; Force?: boolean }
): boolean {
  assertWorkingCopyMirror(mirrorPath);
  const defaultRef = contentDefaultRef(mirrorPath, contentBranch);
  if (!refExists(mirrorPath, defaultRef)) {
    throw new Error(`Cannot repair ${MIRROR_SYNC_BRANCH}: missing ${defaultRef}`);
  }
  if (!options?.Force && isToolingLayoutValid(mirrorPath, defaultRef, MIRROR_SYNC_BRANCH)) {
    return false;
  }
  if (!refExists(mirrorPath, MIRROR_SYNC_BRANCH) && !refExists(mirrorPath, `origin/${MIRROR_SYNC_BRANCH}`)) {
    throw new Error(`${mirrorPath}: no .github on ${MIRROR_SYNC_BRANCH}. Apply mirror-sync templates first.`);
  }
  const restoreFrom = refExists(mirrorPath, MIRROR_SYNC_BRANCH)
    ? MIRROR_SYNC_BRANCH
    : `origin/${MIRROR_SYNC_BRANCH}`;
  commitToolingBranchAtRoot({
    RepoPath: mirrorPath,
    DefaultRef: defaultRef,
    ToolingBranch: MIRROR_SYNC_BRANCH,
    Paths: ['.github'],
    Message: options?.CommitMessage ?? MIRROR_SYNC_COMMIT_MESSAGE,
    Logger: logger,
    RestoreFromRef: restoreFrom
  });
  logger.write(`Repaired ${MIRROR_SYNC_BRANCH} on ${mirrorPath}`);
  return true;
}

export function applyMirrorSyncTemplate(input: {
  MirrorPath: string;
  RepoName: string;
  ContentBranch: string;
  Logger: Logger;
  RepoRoot?: string;
}): boolean {
  const repoRoot = input.RepoRoot ?? getSyncRepoRoot();
  const toolingsRoot = getSyncRepoRoot();
  const configPath = getMirrorSyncConfigPath(repoRoot, input.RepoName);
  const workflowPath = getMirrorSyncWorkflowTemplatePath(repoRoot);

  if (!existsSync(configPath)) {
    input.Logger.write(`No config/mirror-sync/${input.RepoName}.json template`, 'Warn');
    return false;
  }
  if (!existsSync(workflowPath)) {
    throw new Error(`Missing mirror workflow template: ${workflowPath}`);
  }
  if (!refExists(input.MirrorPath, MIRROR_SYNC_BRANCH)) {
    return false;
  }

  fetchOriginBranchOptional(input.MirrorPath, input.ContentBranch, input.Logger);
  const defaultRef = contentDefaultRef(input.MirrorPath, input.ContentBranch);
  const layoutValid = isToolingLayoutValid(input.MirrorPath, defaultRef, MIRROR_SYNC_BRANCH);
  const filesInSync = mirrorSyncFilesMatchTemplates(
    input.MirrorPath,
    repoRoot,
    input.RepoName,
    toolingsRoot
  );
  if (layoutValid && filesInSync) {
    input.Logger.write(`${input.RepoName}: ${MIRROR_SYNC_BRANCH} templates already in sync`);
    return false;
  }

  const root = firstCommitOfBranch(input.MirrorPath, defaultRef);
  runGit(input.MirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, root], {}, 5, input.Logger);
  if (!filesInSync) {
    copyMirrorSyncTemplates(input.MirrorPath, repoRoot, input.RepoName, input.Logger);
  } else if (refExists(input.MirrorPath, `origin/${MIRROR_SYNC_BRANCH}`)) {
    runGit(
      input.MirrorPath,
      ['checkout', `origin/${MIRROR_SYNC_BRANCH}`, '--', '.github'],
      {},
      5,
      input.Logger
    );
  }
  runGit(input.MirrorPath, ['add', '-A', '.github'], {}, 5, input.Logger);
  runGit(input.MirrorPath, ['commit', '-m', MIRROR_SYNC_COMMIT_MESSAGE], {}, 5, input.Logger);
  return true;
}

function maybeEnsureGithubSshPushUrl(mirrorPath: string, logger: Logger): void {
  const configPath = join(mirrorPath, '.github', 'mirror-sync.json');
  let pushViaSsh = false;
  try {
    pushViaSsh = (JSON.parse(readFileSync(configPath, 'utf8')) as { PushViaSsh?: boolean }).PushViaSsh === true;
  } catch {
    return;
  }
  if (!pushViaSsh) {
    return;
  }
  let originUrl: string;
  try {
    originUrl = runGitText(mirrorPath, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return;
  }
  const sshUrl = githubSshPushUrl(originUrl);
  if (!sshUrl) {
    return;
  }
  runGit(mirrorPath, ['remote', 'set-url', '--push', 'origin', sshUrl], {}, 5, logger);
  logger.write(`origin push URL: ${sshUrl}`);
}

export function pushMirrorContentBranch(
  mirrorPath: string,
  contentBranch: string,
  repoName: string,
  logger: Logger
): boolean {
  if (!refExists(mirrorPath, contentBranch)) {
    return false;
  }
  try {
    runGit(mirrorPath, ['fetch', 'origin', '--prune'], {}, 5, logger);
  } catch {
    // Empty origin during bootstrap.
  }
  const local = runGitText(mirrorPath, ['rev-parse', contentBranch]).trim();
  const originRef = `origin/${contentBranch}`;
  const remote = refExists(mirrorPath, originRef)
    ? runGitText(mirrorPath, ['rev-parse', originRef]).trim()
    : null;
  if (remote === local) {
    logger.write(`${repoName}: ${contentBranch} already on origin`);
    return false;
  }
  if (remote) {
    if (testGitAncestor(mirrorPath, local, remote)) {
      logger.write(`${repoName}: remote ${contentBranch} ahead of local; skip content push`);
      return false;
    }
    if (!testGitAncestor(mirrorPath, remote, local)) {
      logger.write(`${repoName}: ${contentBranch} diverges from origin; skip content push`, 'Warn');
      return false;
    }
  }
  maybeEnsureGithubSshPushUrl(mirrorPath, logger);
  runGit(mirrorPath, ['push', '-u', 'origin', `${contentBranch}:${contentBranch}`], {}, 5, logger);
  logger.write(`Pushed ${contentBranch} to origin for ${repoName}`);
  return true;
}

export function pushMirrorSyncBranch(
  mirrorPath: string,
  repoName: string,
  logger: Logger
): boolean {
  if (!refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
    return false;
  }
  const originSync = `origin/${MIRROR_SYNC_BRANCH}`;
  if (refExists(mirrorPath, originSync)) {
    const local = runGitText(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim();
    const remote = runGitText(mirrorPath, ['rev-parse', originSync]).trim();
    if (local === remote) {
      logger.write(`${repoName}: ${MIRROR_SYNC_BRANCH} already on origin`);
      return false;
    }
  }
  maybeEnsureGithubSshPushUrl(mirrorPath, logger);
  runGit(mirrorPath, ['push', '--force-with-lease', 'origin', MIRROR_SYNC_BRANCH], {}, 5, logger);
  logger.write(`Pushed ${MIRROR_SYNC_BRANCH} to origin for ${repoName}`);
  return true;
}

function ensureMirrorSyncBranch(mirrorPath: string, contentBranch: string, logger: Logger): void {
  fetchOriginBranchOptional(mirrorPath, MIRROR_SYNC_BRANCH, logger);
  fetchOriginBranchOptional(mirrorPath, contentBranch, logger);
  const defaultRef = contentDefaultRef(mirrorPath, contentBranch);
  if (refExists(mirrorPath, `origin/${MIRROR_SYNC_BRANCH}`)) {
    runGit(
      mirrorPath,
      ['checkout', '-B', MIRROR_SYNC_BRANCH, `origin/${MIRROR_SYNC_BRANCH}`],
      {},
      5,
      logger
    );
  } else if (!refExists(mirrorPath, MIRROR_SYNC_BRANCH)) {
    const root = firstCommitOfBranch(mirrorPath, defaultRef);
    runGit(mirrorPath, ['checkout', '-B', MIRROR_SYNC_BRANCH, root], {}, 5, logger);
  } else {
    runGit(mirrorPath, ['checkout', MIRROR_SYNC_BRANCH], {}, 5, logger);
  }
  if (!isToolingLayoutValid(mirrorPath, defaultRef, MIRROR_SYNC_BRANCH)) {
    repairSyncBranchLayout(mirrorPath, contentBranch, logger, { Force: true });
  }
}

function setGitRepoUtf8Encoding(repoPath: string): void {
  for (const [key, value] of [
    ['i18n.logOutputEncoding', 'utf-8'],
    ['i18n.commitEncoding', 'utf-8'],
    ['core.quotepath', 'false']
  ]) {
    runGit(repoPath, ['config', key, value]);
  }
}

export function initializeNamedMirrorRepository(input: {
  WorkDirectory: string;
  RepoName: string;
  ContentBranch: string;
  Config: SyncConfig;
  SkipFetch: boolean;
  Logger: Logger;
}): string {
  const mirrorRoot = join(input.WorkDirectory, 'mirrors');
  mkdirSync(mirrorRoot, { recursive: true });
  const mirrorPath = join(mirrorRoot, input.RepoName);
  const owner = input.Config.Owner;
  const repoRoot = getSyncRepoRoot();

  if (existsSync(mirrorPath) && (!existsSync(join(mirrorPath, '.git')) || !refExists(mirrorPath, 'HEAD'))) {
    input.Logger.write(`${input.RepoName}: invalid local mirror; re-initializing`, 'Warn');
    rmSync(mirrorPath, { recursive: true, force: true });
  }

  if (!existsSync(mirrorPath)) {
    if (mirrorOriginHasContent(owner, input.RepoName, input.ContentBranch)) {
      ghRepoClone(owner, input.RepoName, mirrorPath, input.Logger);
    } else {
      const upstreamUrl = loadMirrorUpstreamUrl(repoRoot, input.RepoName);
      if (!upstreamUrl) {
        throw new Error(
          `${input.RepoName}: empty origin and no UpstreamUrl; add config/mirror-sync/${input.RepoName}.json`
        );
      }
      bootstrapMirrorFromUpstreamRoot({
        UpstreamUrl: upstreamUrl,
        OriginUrl: getMirrorCloneUrl(input.Config, input.RepoName),
        MirrorPath: mirrorPath,
        ContentBranch: input.ContentBranch,
        RepoName: input.RepoName,
        Logger: input.Logger
      });
    }
  } else if (!input.SkipFetch) {
    assertWorkingCopyMirror(mirrorPath);
    input.Logger.write(`Fetching mirror working copy ${input.RepoName}`);
    runGit(mirrorPath, ['fetch', 'origin', '--prune'], {}, 5, input.Logger);
  } else {
    assertWorkingCopyMirror(mirrorPath);
  }

  ensureMirrorSyncBranch(mirrorPath, input.ContentBranch, input.Logger);
  applyMirrorSyncTemplate({
    MirrorPath: mirrorPath,
    RepoName: input.RepoName,
    ContentBranch: input.ContentBranch,
    Logger: input.Logger
  });
  setGitRepoUtf8Encoding(mirrorPath);
  return mirrorPath;
}
