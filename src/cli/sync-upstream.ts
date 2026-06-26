import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { runMirrorMerge } from '../mirror-merge/index.ts';
import { readFlag, readIntOption, readStringOption } from './args.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot, {
    logFile: readStringOption(args, '--log-file'),
    append: readFlag(args, '--log-append'),
    logToConsole: readFlag(args, '--log-to-console')
  });

  try {
    await runMirrorMerge({
      RepoRoot: repoRoot,
      WorkDirectory: getWorkDirectory(repoRoot),
      Config: config,
      Logger: logger,
      Clean: readFlag(args, '--clean'),
      DryRun: readFlag(args, '--dry-run'),
      SkipFetch: readFlag(args, '--skip-fetch'),
      MaxCommits: readIntOption(args, '--max-commits', 0),
      DestinationPath: readStringOption(args, '--destination-path')
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.write(message, 'Error');
    logger.write('Re-run without --clean to continue from branch cursors.', 'Warn');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
