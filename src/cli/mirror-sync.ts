import { resolve } from 'node:path';

import { createSyncLogger, setSyncUtf8Environment } from '../lib/log.ts';
import {
  loadMirrorSyncConfig,
  runMirrorSync,
  writeGitHubOutput
} from '../mirror-sync/index.ts';
import { readStringOption } from './args.ts';

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoPath = resolve(readStringOption(args, '--repo-path') ?? process.cwd());
  const configPath = resolve(readStringOption(args, '--config') ?? `${repoPath}/.github/mirror-sync.json`);
  const logger = createSyncLogger(repoPath);

  try {
    const result = runMirrorSync({
      RepoPath: repoPath,
      Config: loadMirrorSyncConfig(configPath),
      Logger: logger
    });
    if (process.env.GITHUB_OUTPUT) {
      writeGitHubOutput(process.env.GITHUB_OUTPUT, result);
    }
    logger.write(`Mirror-Sync done. advanced=${result.Advanced}`);
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
