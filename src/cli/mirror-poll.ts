import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { createMirrorPollGitHub, runMirrorPoll } from '../lib/mirror-poll.ts';
import { createSyncLogger, setSyncUtf8Environment } from '../lib/log.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  const token = process.env.MSYS2_APISS_SYNC_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('MSYS2_APISS_SYNC_TOKEN or GITHUB_TOKEN is required');
  }

  const mirrorOwner = process.env.MIRROR_OWNER ?? config.Mirrors.Owner;

  try {
    logger.write('Mirror poll start');
    const github = createMirrorPollGitHub(token, mirrorOwner, logger);
    await runMirrorPoll({
      RepoRoot: repoRoot,
      Config: config,
      MirrorOwner: mirrorOwner,
      GitHub: github,
      Logger: logger
    });
    logger.write('Done.');
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
