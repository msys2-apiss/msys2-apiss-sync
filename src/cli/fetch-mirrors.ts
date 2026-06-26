import {
  getMirrorCloneUrlByRepoName,
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  loadSyncConfig
} from '../lib/config.ts';
import { getMirrorTipSha } from '../lib/history.ts';
import { ensureGhMirrorRepo } from '../lib/gh-cli.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import {
  getMirrorContentBranch,
  loadMirrorSyncConfigFile,
  startMirrorSyncAfterPush
} from '../lib/mirror-poll.ts';
import {
  initializeNamedMirrorRepository,
  mirrorOriginHasContent,
  pushMirrorContentBranch,
  pushMirrorSyncBranch
} from '../lib/repos.ts';
import { readFlag, readStringOption } from './args.ts';

async function pushSyncMirror(input: {
  MirrorPath: string;
  RepoName: string;
  ContentBranch: string;
  Config: ReturnType<typeof loadSyncConfig>;
  Logger: ReturnType<typeof createSyncLogger>;
}): Promise<void> {
  const originUrl = getMirrorCloneUrlByRepoName(input.Config, input.RepoName);
  const isNewMirror = !mirrorOriginHasContent(originUrl, input.ContentBranch);
  if (isNewMirror) {
    input.Logger.write(
      `${input.RepoName}: new mirror init (push content root + sync, then trigger mirror-sync)`
    );
    const mirrorConfig = loadMirrorSyncConfigFile(getSyncRepoRoot(), input.RepoName);
    ensureGhMirrorRepo({
      Owner: input.Config.Owner,
      RepoName: input.RepoName,
      Description: mirrorConfig?.Description,
      Url: mirrorConfig?.Url,
      Logger: input.Logger
    });
  }
  pushMirrorContentBranch(input.MirrorPath, input.ContentBranch, input.RepoName, input.Logger);
  pushMirrorSyncBranch(input.MirrorPath, input.RepoName, input.Logger);
  await startMirrorSyncAfterPush({
    Owner: input.Config.Owner,
    RepoName: input.RepoName,
    ContentBranch: input.ContentBranch,
    Logger: input.Logger
  });
}

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  try {
    const work = getWorkDirectory(repoRoot);
    const skipFetch = readFlag(args, '--skip-fetch');
    const pushSync = readFlag(args, '--push-sync');
    const repoFilter = readStringOption(args, '--repo');
    logger.write('Fetching mirrors');

    if (repoFilter && !getMirrorPollRepoNames(config).includes(repoFilter)) {
      throw new Error(`Unknown mirror repo: ${repoFilter}`);
    }

    for (const repoName of getMirrorPollRepoNames(config)) {
      if (repoFilter && repoFilter !== repoName) {
        continue;
      }
      const branch = getMirrorContentBranch(repoRoot, repoName);
      const mirrorPath = initializeNamedMirrorRepository({
        WorkDirectory: work,
        RepoName: repoName,
        ContentBranch: branch,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      });
      if (pushSync) {
        await pushSyncMirror({
          MirrorPath: mirrorPath,
          RepoName: repoName,
          ContentBranch: branch,
          Config: config,
          Logger: logger
        });
      }
      const syncTip = getMirrorTipSha(mirrorPath, 'sync');
      const tip = getMirrorTipSha(mirrorPath, branch);
      logger.write(
        `${repoName} mirror: ${mirrorPath} (sync = ${syncTip.slice(0, 8)}, ${branch} = ${tip.slice(0, 8)})`
      );
    }

    logger.write('Done.');
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
