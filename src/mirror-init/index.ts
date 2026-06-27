import { printMirrorInitCliHelp, readFlag, readStringOption, wantsHelp } from './args.ts';
import {
  getMirrorContentBranch,
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  getWorkDirectory,
  loadMirrorSyncConfigFile,
  loadSyncConfig,
  MIRROR_SYNC_BRANCH
} from './config.ts';
import { installMirrorMergeWorkflow } from './destination.ts';
import { ghDispatchMirrorSyncWorkflow, ghRepoCreate, requireGhAuthenticated } from '../git/gh.ts';
import {
  initializeNamedMirrorRepository,
  mirrorOriginHasContent,
  pushMirrorContentBranch,
  pushMirrorSyncBranch
} from './repos.ts';
import { runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';
import { WORKFLOW_DISPATCH_MIRROR_SYNC } from '../types/constants.ts';

function createLogger(): Logger {
  return {
    write(message, level = 'Info') {
      const prefix =
        level === 'Warn' ? '[mirror-init][warn]' : level === 'Error' ? '[mirror-init][error]' : '[mirror-init]';
      console.log(`${prefix} ${message}`);
    },
    close() {}
  };
}

function getBranchTip(mirrorPath: string, branch: string): string {
  return runGitText(mirrorPath, ['rev-parse', branch]).trim();
}

function dispatchMirrorSyncAfterPush(owner: string, repoName: string, logger: Logger): void {
  logger.write(`Dispatching ${WORKFLOW_DISPATCH_MIRROR_SYNC} on ${owner}/${repoName}`);
  const result = ghDispatchMirrorSyncWorkflow(owner, repoName, logger);
  if (result.ok) {
    logger.write(`dispatched ${owner}/${repoName}`);
    return;
  }
  if (result.skipped) {
    return;
  }
  if (result.notFound) {
    throw new Error(
      `${WORKFLOW_DISPATCH_MIRROR_SYNC} failed for ${owner}/${repoName}: mirror-sync.yml not found`
    );
  }
  if (result.forbidden) {
    throw new Error(
      `${WORKFLOW_DISPATCH_MIRROR_SYNC} failed for ${owner}/${repoName} (403): ` +
        'gh cannot dispatch mirror-sync; check gh auth or SYNC_DISPATCH_TOKEN'
    );
  }
  const suffix = result.detail ? `: ${result.detail}` : '';
  throw new Error(`${WORKFLOW_DISPATCH_MIRROR_SYNC} failed for ${owner}/${repoName}${suffix}`);
}

async function pushMirrorRepo(input: {
  RepoRoot: string;
  RepoName: string;
  MirrorPath: string;
  ContentBranch: string;
  Config: ReturnType<typeof loadSyncConfig>;
  Logger: Logger;
}): Promise<void> {
  const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, input.RepoName);
  const isNewMirror = !mirrorOriginHasContent(input.Config.Owner, input.RepoName, input.ContentBranch);
  if (isNewMirror) {
    input.Logger.write(`${input.RepoName}: new mirror; ensuring GitHub repo exists`);
    ghRepoCreate({
      Owner: input.Config.Owner,
      RepoName: input.RepoName,
      Description: mirrorConfig?.Description,
      Url: mirrorConfig?.Url,
      Logger: input.Logger
    });
  }
  pushMirrorContentBranch(input.MirrorPath, input.ContentBranch, input.RepoName, input.Logger);
  pushMirrorSyncBranch(input.MirrorPath, input.RepoName, input.Logger);
}

export async function runMirrorInit(input: {
  Push?: boolean;
  SkipFetch?: boolean;
  RepoFilter?: string;
}): Promise<void> {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';

  if (input.Push) {
    requireGhAuthenticated();
  }

  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const work = getWorkDirectory(repoRoot);
  const logger = createLogger();

  logger.write('start');

  if (input.RepoFilter && !getMirrorPollRepoNames(config).includes(input.RepoFilter)) {
    throw new Error(`Unknown mirror repo: ${input.RepoFilter}`);
  }

  for (const repoName of getMirrorPollRepoNames(config)) {
    if (input.RepoFilter && input.RepoFilter !== repoName) {
      continue;
    }
    const contentBranch = getMirrorContentBranch(repoRoot, repoName);
    const mirrorPath = initializeNamedMirrorRepository({
      WorkDirectory: work,
      RepoName: repoName,
      ContentBranch: contentBranch,
      Config: config,
      SkipFetch: Boolean(input.SkipFetch),
      Logger: logger
    });
    if (input.Push) {
      await pushMirrorRepo({
        RepoRoot: repoRoot,
        RepoName: repoName,
        MirrorPath: mirrorPath,
        ContentBranch: contentBranch,
        Config: config,
        Logger: logger
      });
      dispatchMirrorSyncAfterPush(config.Owner, repoName, logger);
    }
    const syncTip = getBranchTip(mirrorPath, MIRROR_SYNC_BRANCH);
    const tip = getBranchTip(mirrorPath, contentBranch);
    logger.write(`${repoName}: ${mirrorPath} (msys2-apiss-mirror-sync=${syncTip.slice(0, 8)}, ${contentBranch}=${tip.slice(0, 8)})`);
  }

  installMirrorMergeWorkflow({
    RepoRoot: repoRoot,
    WorkDirectory: work,
    Config: config,
    Push: Boolean(input.Push),
    Logger: logger
  });

  logger.write('done');
}

export async function runMirrorInitCli(): Promise<void> {
  const args = process.argv.slice(2);
  if (wantsHelp(args)) {
    printMirrorInitCliHelp();
    return;
  }

  const logger = createLogger();
  try {
    await runMirrorInit({
      Push: readFlag(args, '--push'),
      SkipFetch: readFlag(args, '--skip-fetch'),
      RepoFilter: readStringOption(args, '--repo')
    });
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}
