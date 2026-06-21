import { writeFileSync } from 'node:fs';

import { readFlag, readStringOption } from './args.ts';
import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import {
  convertFromUpstreamCommitLogMetadataText,
  getUpstreamCommitLogMetadataFormat,
  newReplayCommitEntry
} from '../lib/history.ts';
import {
  formatMappedUnifiedDiff,
  listMappedPatchPaths,
  listMirrorCommitShas,
  resolveMirrorCommitParent,
  resolveMirrorSourceFromCli
} from '../lib/mapped-patch.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { runGit, runGitText } from '../lib/git.ts';
import {
  applyUpstreamCommitToIndex,
  formatReplayCommitMessage,
  newReplayCommit
} from '../lib/replay.ts';
import { initializeDestinationAlternates, initializeMirrorRepository } from '../lib/repos.ts';

function readRepeatedOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== name) {
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${name}`);
    }
    values.push(value);
    index++;
  }
  return values;
}

function resolveCommitList(args: string[]): { Commits: string[]; Range: string | null } {
  const range = readStringOption(args, '--range');
  const commits = readRepeatedOption(args, '--commit');
  if (range && commits.length > 0) {
    throw new Error('Use either --range or --commit, not both');
  }
  if (!range && commits.length === 0) {
    throw new Error('Missing --commit SHA or --range A..B');
  }
  return {
    Commits: commits,
    Range: range ?? null
  };
}

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const logger = createSyncLogger(repoRoot);

  try {
    const sourceArg = readStringOption(args, '--source');
    const destinationPath = readStringOption(args, '--destination-path');
    if (!sourceArg) {
      throw new Error('Missing --source (ports or ports-mingw)');
    }
    if (!destinationPath) {
      throw new Error('Missing --destination-path');
    }

    const source = resolveMirrorSourceFromCli(sourceArg, config);
    const { Commits, Range } = resolveCommitList(args);
    const skipFetch = readFlag(args, '--skip-fetch');
    const printPatch = readFlag(args, '--print-patch');
    const listFiles = readFlag(args, '--list-files');
    const createCommit = readFlag(args, '--create-commit');
    const outputPath = readStringOption(args, '--output');
    const parentOverride = readStringOption(args, '--parent');

    if (printPatch && listFiles) {
      throw new Error('Use either --print-patch or --list-files, not both');
    }
    if (outputPath && !printPatch) {
      throw new Error('--output requires --print-patch');
    }
    if (createCommit && (printPatch || listFiles)) {
      throw new Error('--create-commit cannot be used with --print-patch or --list-files');
    }

    const work = getWorkDirectory(repoRoot);
    const mirrorPorts = initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'Ports',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
    const mirrorMingw = initializeMirrorRepository({
      WorkDirectory: work,
      SourceKey: 'PortsMingw',
      Config: config,
      SkipFetch: skipFetch,
      Logger: logger
    });
    const mirrorPath = source.SourceKey === 'Ports' ? mirrorPorts : mirrorMingw;
    initializeDestinationAlternates(destinationPath, [mirrorPorts, mirrorMingw]);

    const commitShas = Range ? listMirrorCommitShas(mirrorPath, Range) : Commits;
    if (commitShas.length === 0) {
      logger.write('No commits matched the requested range.');
      return;
    }

    logger.write(
      `Applying ${commitShas.length} mapped patch(es) from ${source.SortKey} (${source.DestSubdir}/) to ${destinationPath}`
    );

    let applied = 0;
    let skipped = 0;

    for (const commit of commitShas) {
      const parent = resolveMirrorCommitParent(mirrorPath, commit, parentOverride);
      const subject = runGitText(mirrorPath, ['log', '-1', '--format=%s', commit]).trim();

      if (printPatch) {
        const patch = formatMappedUnifiedDiff(mirrorPath, parent, commit, source.DestSubdir);
        if (outputPath) {
          writeFileSync(outputPath, patch, 'utf8');
          logger.write(`Wrote mapped patch for ${commit.slice(0, 8)} to ${outputPath}`);
        } else {
          process.stdout.write(patch);
          if (!patch.endsWith('\n')) {
            process.stdout.write('\n');
          }
        }
        continue;
      }

      if (listFiles) {
        const paths = listMappedPatchPaths(mirrorPath, parent, commit, source.DestSubdir);
        logger.write(`${commit.slice(0, 8)} ${subject} (${paths.length} path(s))`);
        for (const path of paths) {
          logger.write(`  ${path}`);
        }
        continue;
      }

      const hasChanges = applyUpstreamCommitToIndex({
        MirrorPath: mirrorPath,
        Commit: commit,
        Parent: parent,
        DestSubdir: source.DestSubdir,
        DestinationPath: destinationPath
      });

      if (!hasChanges) {
        skipped++;
        logger.write(`skip empty diff ${commit.slice(0, 8)} ${subject}`);
        continue;
      }

      if (createCommit) {
        const text = runGitText(mirrorPath, [
          'log',
          '-1',
          `--format=${getUpstreamCommitLogMetadataFormat()}`,
          commit
        ]);
        const logEntries = convertFromUpstreamCommitLogMetadataText(text);
        const logEntry = logEntries[0];
        if (!logEntry) {
          throw new Error(`Could not read metadata for commit ${commit}`);
        }
        const replayEntry = newReplayCommitEntry(source.SourceKey, logEntry, config);
        const message = formatReplayCommitMessage({
          SortKey: source.SortKey,
          Metadata: replayEntry,
          UpstreamRepo: replayEntry.UpstreamRepo,
          UpstreamSha: commit
        });
        newReplayCommit(destinationPath, replayEntry, message);
        runGit(destinationPath, ['reset', '--hard', 'HEAD']);
      }

      applied++;
      logger.write(`applied ${commit.slice(0, 8)} ${subject}`);
    }

    if (!printPatch && !listFiles) {
      logger.write(`Done. applied=${applied} skipped=${skipped}`);
      if (applied > 0 && !createCommit) {
        logger.write('Changes are staged in the destination index (git diff --cached).');
      }
    } else {
      logger.write('Done.');
    }
  } catch (error) {
    logger.write(error instanceof Error ? error.message : String(error), 'Error');
    process.exitCode = 1;
  } finally {
    logger.close();
  }
}

void main();
