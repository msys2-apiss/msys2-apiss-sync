import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorOnlyEntryForRepo,
  getMirrorPollRepoNames,
  getSourceConfigEntry,
  getSyncRepoRoot,
  loadSyncConfig
} from '../lib/config.ts';
import { getMirrorTipSha } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { runGitText } from '../lib/git.ts';
import {
  initializeMirrorRepository,
  initializeNamedMirrorRepository,
  MIRROR_SYNC_BRANCH,
  pushMirrorSyncBranch,
  repairSyncBranchLayout
} from '../lib/repos.ts';
import { readFlag, readStringOption } from './args.ts';

function contentBranchForRepo(
  config: ReturnType<typeof loadSyncConfig>,
  repoName: string
): string {
  if (repoName === config.Mirrors.Ports) {
    return getSourceConfigEntry(config, 'Ports').Branch;
  }
  if (repoName === config.Mirrors.PortsMingw) {
    return getSourceConfigEntry(config, 'PortsMingw').Branch;
  }
  const entry = getMirrorOnlyEntryForRepo(config, repoName);
  return entry?.Branch ?? 'master';
}

function ensureMirrorPath(
  work: string,
  config: ReturnType<typeof loadSyncConfig>,
  repoName: string,
  skipFetch: boolean,
  logger: ReturnType<typeof createSyncLogger>
): string {
  if (repoName === config.Mirrors.Ports) {
    return initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'Ports',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
  }
  if (repoName === config.Mirrors.PortsMingw) {
    return initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'PortsMingw',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
  }
  return initializeNamedMirrorRepository({
    WorkDirectory: work,
    RepoName: repoName,
    ContentBranch: contentBranchForRepo(config, repoName),
    Config: config,
    SkipFetch: skipFetch,
    Logger: logger
  });
}

function logMirrorTips(
  logger: ReturnType<typeof createSyncLogger>,
  repoName: string,
  mirrorPath: string,
  contentBranch: string,
  localSync = false
): void {
  const syncTip = localSync
    ? runGitText(mirrorPath, ['rev-parse', MIRROR_SYNC_BRANCH]).trim()
    : getMirrorTipSha(mirrorPath, MIRROR_SYNC_BRANCH);
  const tip = getMirrorTipSha(mirrorPath, contentBranch);
  logger.write(
    `${repoName}: ${mirrorPath} (sync = ${syncTip.slice(0, 8)}, ${contentBranch} = ${tip.slice(0, 8)})`
  );
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
    const push = readFlag(args, '--push');
    const repoFilter = readStringOption(args, '--repo');
    const message = readStringOption(args, '--message');

    let repoNames = getMirrorPollRepoNames(config);
    if (repoFilter) {
      if (!repoNames.includes(repoFilter)) {
        throw new Error(`Unknown mirror repo: ${repoFilter}`);
      }
      repoNames = [repoFilter];
    }

    logger.write('Repairing mirror sync branch layout');

    for (const repoName of repoNames) {
      const contentBranch = contentBranchForRepo(config, repoName);
      const mirrorPath = join(work, 'mirrors', repoName);
      const needsClone = !existsSync(mirrorPath);

      if (needsClone || !skipFetch) {
        ensureMirrorPath(work, config, repoName, false, logger);
        logMirrorTips(logger, repoName, mirrorPath, contentBranch);
        continue;
      }

      ensureMirrorPath(work, config, repoName, true, logger);
      const repaired = repairSyncBranchLayout(mirrorPath, contentBranch, logger, {
        CommitMessage: message
      });
      if (!repaired) {
        logger.write(`${repoName}: ${MIRROR_SYNC_BRANCH} layout already valid`);
      }
      if (push && repaired) {
        pushMirrorSyncBranch(mirrorPath, repoName, logger);
      }
      logMirrorTips(logger, repoName, mirrorPath, contentBranch, true);
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
