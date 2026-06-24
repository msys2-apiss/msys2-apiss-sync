import { getMirrorOnlyEntryForRepo, getSourceConfigEntry, getSyncRepoRoot, getMirrorPollRepoNames, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { initializeMirrorRepository, initializeNamedMirrorRepository, pushMirrorSyncBranch } from '../lib/repos.ts';
import { readFlag } from './args.ts';

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
    logger.write('Fetching mirrors');

    for (const sourceKey of ['Ports', 'PortsMingw'] as const) {
      const mirrorPath = initializeMirrorRepository({
        WorkDirectory: work,
        SourceKey: sourceKey,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      });
      const branch = config.Sources[sourceKey].Branch;
      const repoName = getSourceConfigEntry(config, sourceKey).Repo;
      if (pushSync) {
        pushMirrorSyncBranch(mirrorPath, repoName, logger);
      }
      const tip = getMirrorTipSha(mirrorPath, branch);
      const syncTip = getMirrorTipSha(mirrorPath, 'sync');
      logger.write(
        `${sourceKey} mirror: ${mirrorPath} (sync = ${syncTip.slice(0, 8)}, ${branch} = ${tip.slice(0, 8)})`
      );
    }

    const replayRepoNames = new Set([config.Mirrors.Ports, config.Mirrors.PortsMingw]);
    for (const repoName of getMirrorPollRepoNames(config)) {
      if (replayRepoNames.has(repoName)) {
        continue;
      }
      const entry = getMirrorOnlyEntryForRepo(config, repoName);
      const branch = entry?.Branch ?? 'master';
      const mirrorPath = initializeNamedMirrorRepository({
        WorkDirectory: work,
        RepoName: repoName,
        ContentBranch: branch,
        Config: config,
        SkipFetch: skipFetch,
        Logger: logger
      });
      if (pushSync) {
        pushMirrorSyncBranch(mirrorPath, repoName, logger);
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
