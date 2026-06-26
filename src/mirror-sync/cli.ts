import { resolve } from 'node:path';

import { readStringOption } from './args.ts';
import {
  loadMirrorSyncConfig,
  runMirrorSync,
  writeGitHubOutput
} from './index.ts';
import { createMirrorSyncLogger, setMirrorSyncUtf8Environment } from './log.ts';

async function main(): Promise<void> {
  setMirrorSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoPath = resolve(readStringOption(args, '--repo-path') ?? process.cwd());
  const configPath = resolve(readStringOption(args, '--config') ?? `${repoPath}/.github/mirror-sync.json`);
  const logger = createMirrorSyncLogger();

  try {
    const result = runMirrorSync({
      RepoPath: repoPath,
      Config: loadMirrorSyncConfig(configPath),
      Logger: logger
    });
    if (process.env.GITHUB_OUTPUT) {
      writeGitHubOutput(process.env.GITHUB_OUTPUT, result);
    }
    logger.write(`done. advanced=${result.Advanced} dispatch_mirror_merge=${result.DispatchMirrorMerge}`);
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
