import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { requireGhCommand } from '../lib/gh-cli.ts';
import { createMirrorPollGitHub, runMirrorPoll } from '../lib/mirror-poll.ts';
import { createSyncLogger, setSyncUtf8Environment } from '../lib/log.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  try {
    requireGhCommand();
    logger.write('Mirror poll start');
    const github = createMirrorPollGitHub(config.Owner, logger);
    await runMirrorPoll({
      RepoRoot: repoRoot,
      Config: config,
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
