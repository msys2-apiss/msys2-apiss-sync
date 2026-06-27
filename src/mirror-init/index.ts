import { printMirrorInitCliHelp, readFlag, readStringOption, wantsHelp } from './args.ts';
import {
  getMirrorContentBranch,
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  getWorkDirectory,
  loadMirrorPollConfig,
  loadMirrorSyncConfigFile
} from './config.ts';
import {
  initializeDestinationRepository,
  pushDestinationToolingBranch
} from './destination.ts';
import {
  initializeNamedMirrorRepository,
  mirrorOriginHasContent,
  pushMirrorContentBranchIfMissing,
  pushMirrorSyncBranch
} from './mirror.ts';
import {
  ghDispatchMirrorBlock,
  ghRepoCreate,
  MIRROR_MERGE_BLOCK,
  MIRROR_POLL_BLOCK,
  MIRROR_SYNC_BLOCK,
  requireGhAuthenticated
} from '../git/gh.ts';
import { runGitText } from '../git/index.ts';
import type { Logger } from '../git/log.ts';
import {
  computeConfigTreeDigest,
  loadDigestMap,
  pinRepoDigest,
  repoNeedsBootstrap,
  saveDigestMap
} from '../lib/tooling-digest.ts';
import {
  MIRROR_MERGE_BRANCH,
  MIRROR_SYNC_BRANCH,
  TOOLING_DEFAULT_BRANCH,
  TOOLING_REPO
} from '../types/constants.ts';

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

function pushDestinationRepo(input: {
  RepoPath: string;
  Owner: string;
  DestinationRepo: string;
  DefaultBranch: string;
  Logger: Logger;
}): void {
  pushDestinationToolingBranch({
    RepoPath: input.RepoPath,
    Owner: input.Owner,
    DestinationRepo: input.DestinationRepo,
    DefaultBranch: input.DefaultBranch,
    Logger: input.Logger
  });
  ghDispatchMirrorBlock(MIRROR_MERGE_BLOCK, input.Owner, input.DestinationRepo, input.DefaultBranch, input.Logger);
}

function pushMirrorRepo(input: {
  RepoRoot: string;
  RepoName: string;
  MirrorPath: string;
  ContentBranch: string;
  Owner: string;
  Logger: Logger;
}): void {
  const mirrorConfig = loadMirrorSyncConfigFile(input.RepoRoot, input.RepoName);
  if (!mirrorOriginHasContent(input.Owner, input.RepoName, input.ContentBranch)) {
    input.Logger.write(`${input.RepoName}: new mirror; ensuring GitHub repo exists`);
    ghRepoCreate({
      Owner: input.Owner,
      RepoName: input.RepoName,
      Description: mirrorConfig?.Description,
      Url: mirrorConfig?.Url,
      Logger: input.Logger
    });
  }
  pushMirrorContentBranchIfMissing(
    input.MirrorPath,
    input.ContentBranch,
    input.RepoName,
    input.Logger
  );
  pushMirrorSyncBranch(input.MirrorPath, input.RepoName, input.Logger);
  ghDispatchMirrorBlock(MIRROR_SYNC_BLOCK, input.Owner, input.RepoName, input.ContentBranch, input.Logger);
}

export async function runMirrorInit(input: {
  Push?: boolean;
  SkipFetch?: boolean;
  RepoFilter?: string;
  NoPoll?: boolean;
}): Promise<void> {
  process.env.LANG = 'C.UTF-8';
  process.env.LC_ALL = 'C.UTF-8';

  const repoRoot = getSyncRepoRoot();
  const mirrorPollConfig = loadMirrorPollConfig(repoRoot);
  const owner = mirrorPollConfig.Owner;
  const destinationRepo = mirrorPollConfig.Destination.Repo;
  const defaultBranch = mirrorPollConfig.Destination.DefaultBranch ?? 'main';
  const work = getWorkDirectory(repoRoot);
  const logger = createLogger();
  logger.write('start');

  if (input.Push || !input.NoPoll) {
    requireGhAuthenticated();
  }

  const currentDigest = computeConfigTreeDigest(repoRoot);
  const digestMap = loadDigestMap(repoRoot, logger);
  let digestMapDirty = false;

  if (input.RepoFilter && !getMirrorPollRepoNames(mirrorPollConfig).includes(input.RepoFilter)) {
    throw new Error(`Unknown mirror repo: ${input.RepoFilter}`);
  }

  const mirrorReposInScope = getMirrorPollRepoNames(mirrorPollConfig).filter(
    (repoName) => !input.RepoFilter || input.RepoFilter === repoName
  );
  const destinationNeedsBootstrap = repoNeedsBootstrap(digestMap, destinationRepo, currentDigest);
  const anyMirrorNeedsBootstrap = mirrorReposInScope.some((repoName) =>
    repoNeedsBootstrap(digestMap, repoName, currentDigest)
  );

  const allReposPinned = !destinationNeedsBootstrap && !anyMirrorNeedsBootstrap;

  if (allReposPinned) {
    logger.write('config digest pinned for all repos; nothing to do');
  } else {
    if (destinationNeedsBootstrap) {
      const destinationPath = initializeDestinationRepository({
        RepoRoot: repoRoot,
        WorkDirectory: work,
        Owner: owner,
        DestinationRepo: destinationRepo,
        DefaultBranch: defaultBranch,
        SkipFetch: Boolean(input.SkipFetch),
        Logger: logger
      });
      if (input.Push) {
        pushDestinationRepo({
          RepoPath: destinationPath,
          Owner: owner,
          DestinationRepo: destinationRepo,
          DefaultBranch: defaultBranch,
          Logger: logger
        });
        pinRepoDigest(digestMap, destinationRepo, currentDigest);
        digestMapDirty = true;
      }
      const mergeTip = runGitText(destinationPath, ['rev-parse', MIRROR_MERGE_BRANCH]).trim();
      logger.write(
        `${owner}/${destinationRepo}: ${destinationPath} (${MIRROR_MERGE_BRANCH}=${mergeTip.slice(0, 8)})`
      );
    } else {
      logger.write(`${destinationRepo}: config digest pinned; skipping init`);
    }

    for (const repoName of mirrorReposInScope) {
      const contentBranch = getMirrorContentBranch(repoRoot, repoName);
      const mirrorNeedsBootstrap = repoNeedsBootstrap(digestMap, repoName, currentDigest);
      if (!mirrorNeedsBootstrap) {
        logger.write(`${repoName}: config digest pinned; skipping init`);
        continue;
      }
      const mirrorPath = initializeNamedMirrorRepository({
        WorkDirectory: work,
        RepoName: repoName,
        ContentBranch: contentBranch,
        Owner: owner,
        SkipFetch: Boolean(input.SkipFetch),
        Logger: logger
      });
      if (input.Push) {
        pushMirrorRepo({
          RepoRoot: repoRoot,
          RepoName: repoName,
          MirrorPath: mirrorPath,
          ContentBranch: contentBranch,
          Owner: owner,
          Logger: logger
        });
        pinRepoDigest(digestMap, repoName, currentDigest);
        digestMapDirty = true;
      }
      const syncTip = runGitText(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim();
      const tip = runGitText(mirrorPath, ['rev-parse', contentBranch]).trim();
      logger.write(
        `${repoName}: ${mirrorPath} (msys2-apiss-mirror-sync=${syncTip.slice(0, 8)}, ${contentBranch}=${tip.slice(0, 8)})`
      );
    }
  }

  if (input.Push && digestMapDirty) {
    saveDigestMap(repoRoot, digestMap);
    logger.write('updated config/digest.json');
  }
  if (!input.NoPoll) {
    ghDispatchMirrorBlock(
      MIRROR_POLL_BLOCK,
      owner,
      TOOLING_REPO,
      TOOLING_DEFAULT_BRANCH,
      logger
    );
  } else {
    logger.write('--no-poll: mirror-poll.yml dispatch skipped');
  }
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
      NoPoll: readFlag(args, '--no-poll'),
      RepoFilter: readStringOption(args, '--repo')
    });
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}
