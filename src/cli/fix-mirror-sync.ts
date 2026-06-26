import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  getMirrorPollRepoNames,
  getSyncRepoRoot,
  loadSyncConfig
} from '../lib/config.ts';
import { getMirrorTipSha } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { runGitText } from '../lib/git.ts';
import { getMirrorContentBranch, startMirrorSyncAfterPush } from '../lib/mirror-poll.ts';
import {
  initializeNamedMirrorRepository,
  MIRROR_SYNC_BRANCH,
  pushMirrorContentBranch,
  pushMirrorSyncBranch,
  repairSyncBranchLayout
} from '../lib/repos.ts';
import { readFlag, readStringOption } from './args.ts';

function ensureMirrorPath(
  work: string,
  config: ReturnType<typeof loadSyncConfig>,
  repoRoot: string,
  repoName: string,
  skipFetch: boolean,
  logger: ReturnType<typeof createSyncLogger>
): string {
  return initializeNamedMirrorRepository({
    WorkDirectory: work,
    RepoName: repoName,
    ContentBranch: getMirrorContentBranch(repoRoot, repoName),
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
    `${repoName}: ${mirrorPath} (${MIRROR_SYNC_BRANCH} = ${syncTip.slice(0, 8)}, ${contentBranch} = ${tip.slice(0, 8)})`
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
    const force = readFlag(args, '--force');
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
      const contentBranch = getMirrorContentBranch(repoRoot, repoName);
      const mirrorPath = join(work, 'mirrors', repoName);
      const needsClone = !existsSync(mirrorPath);

      if (needsClone || !skipFetch) {
        ensureMirrorPath(work, config, repoRoot, repoName, false, logger);
        logMirrorTips(logger, repoName, mirrorPath, contentBranch);
        continue;
      }

      ensureMirrorPath(work, config, repoRoot, repoName, true, logger);
      const repaired = repairSyncBranchLayout(mirrorPath, contentBranch, logger, {
        CommitMessage: message,
        Force: force
      });
      if (!repaired) {
        logger.write(`${repoName}: ${MIRROR_SYNC_BRANCH} layout already valid`);
      }
      if (push) {
        if (repaired) {
          pushMirrorContentBranch(mirrorPath, contentBranch, repoName, logger);
          pushMirrorSyncBranch(mirrorPath, repoName, logger);
        }
        await startMirrorSyncAfterPush({
          Owner: config.Owner,
          RepoName: repoName,
          ContentBranch: contentBranch,
          Logger: logger
        });
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
