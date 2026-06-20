import { join } from 'node:path';

import { performance } from 'node:perf_hooks';

import { runGitText, runGit } from '../lib/git.ts';
import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha, getSourceReplayHistory } from '../lib/history.ts';
import { createSyncLogger, getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import {
  buildMirrorCommitParentMap,
  filterReplayQueueByAge,
  getFirstParentFromMap,
  mergeReplayCommitQueues,
  precomputeReplayCursorBranchSafeFlags
} from '../lib/queue.ts';
import {
  advanceSyncCursorDestShasIfSafe,
  clearDestinationSyncBranches,
  ensureDestinationBaseCommit,
  getDestinationBranchSha,
  initializeDestinationAlternates,
  initializeDestinationRepository,
  initializeMirrorRepository,
  pushDestinationBranches,
  resolveSyncRetrieveCursorsFromBranches,
  setDestinationReplayCheckout,
  testAllSyncBranchesExist,
  updateDestinationCursorBranchRefs,
  updateDestinationSyncBranchRefs
} from '../lib/repos.ts';
import {
  getMirrorParentGraphCachePath,
  loadOrBuildMirrorCommitParentMap
} from '../lib/replay-graph.ts';
import {
  applyUpstreamCommitToIndex,
  formatReplayCommitMessage,
  newReplayCommit,
  testUpstreamCommitHasMappedChanges
} from '../lib/replay.ts';
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
    const work = getWorkDirectory(repoRoot);
    const clean = readFlag(args, '--clean');
    const dryRun = readFlag(args, '--dry-run');
    const skipFetch = readFlag(args, '--skip-fetch');
    const maxCommits = readIntOption(args, '--max-commits', 0);
    const destinationPathArg = readStringOption(args, '--destination-path');
    const replayBranch = config.Destination.Branches.Replay;
    const cursorPortsBranch = config.Destination.Branches.CursorPorts;
    const cursorMingwBranch = config.Destination.Branches.CursorPortsMingw;

    logger.write(`Sync-Upstream start (clean=${clean} dryRun=${dryRun} skipFetch=${skipFetch})`);

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
    const destPath = initializeDestinationRepository({
      WorkDirectory: work,
      Config: config,
      DestinationPath: destinationPathArg,
      SkipFetch: skipFetch,
      Logger: logger
    });

    initializeDestinationAlternates(destPath, [mirrorPorts, mirrorMingw]);
    ensureDestinationBaseCommit(destPath, config, logger);

    if (clean) {
      logger.write('Clean: resetting sync branches');
      clearDestinationSyncBranches(destPath, config, logger);
    }

    const portsDestSha = getDestinationBranchSha(destPath, cursorPortsBranch);
    const mingwDestSha = getDestinationBranchSha(destPath, cursorMingwBranch);
    const retrieveCursors = resolveSyncRetrieveCursorsFromBranches(destPath, config);
    const cursorPorts = retrieveCursors.PortsUpstreamSha;
    const cursorMingw = retrieveCursors.PortsMingwUpstreamSha;
    let lastPortsDestSha = portsDestSha;
    let lastMingwDestSha = mingwDestSha;
    let isFullReplay = !testAllSyncBranchesExist(destPath, config);

    if (isFullReplay) {
      logger.write('Bootstrap: full replay (no age gate)');
    } else if (cursorPorts && cursorMingw) {
      logger.write(`Incremental: cursors ports=${cursorPorts.slice(0, 8)} mingw=${cursorMingw.slice(0, 8)}`);
    }

    if (!dryRun) {
      const replayTipSha = getDestinationBranchSha(destPath, replayBranch);
      if (replayTipSha) {
        runGit(destPath, ['checkout', '-B', replayBranch, replayTipSha]);
        runGit(destPath, ['reset', '--hard', 'HEAD']);
        isFullReplay = false;
      } else {
        setDestinationReplayCheckout(destPath, config, isFullReplay);
      }
    } else {
      setDestinationReplayCheckout(destPath, config, isFullReplay);
    }

    const tipPorts = getMirrorTipSha(mirrorPorts, config.Sources.Ports.Branch);
    const tipMingw = getMirrorTipSha(mirrorMingw, config.Sources.PortsMingw.Branch);
    const [portsList, mingwList] = await Promise.all([
      getSourceReplayHistory('Ports', config, mirrorPorts, cursorPorts, tipPorts),
      getSourceReplayHistory('PortsMingw', config, mirrorMingw, cursorMingw, tipMingw)
    ]);
    let queue = mergeReplayCommitQueues(portsList, mingwList);

    logger.write(`Retrieved ports=${portsList.length} mingw=${mingwList.length} merged=${queue.length}`);

    if (!isFullReplay) {
      queue = filterReplayQueueByAge(queue, config, (message) => logger.write(message));
      logger.write(`After age gate: ${queue.length} commit(s)`);
    }

    if (queue.length === 0) {
      logger.write('No commits to replay.');
      process.exitCode = 0;
      return;
    }

    if (maxCommits > 0 && queue.length > maxCommits) {
      queue = queue.slice(0, maxCommits);
      logger.write(`Throttled to MaxCommits=${maxCommits}`);
    }

    const graphCacheDir = join(work, 'cache', 'replay-graph');
    const [parentMapPorts, parentMapMingw] = await Promise.all([
      loadOrBuildMirrorCommitParentMap({
        CachePath: getMirrorParentGraphCachePath(graphCacheDir, 'Ports', config.Sources.Ports.Branch, tipPorts),
        Branch: config.Sources.Ports.Branch,
        TipSha: tipPorts,
        Build: () => buildMirrorCommitParentMap(mirrorPorts, config.Sources.Ports.Branch)
      }),
      loadOrBuildMirrorCommitParentMap({
        CachePath: getMirrorParentGraphCachePath(
          graphCacheDir,
          'PortsMingw',
          config.Sources.PortsMingw.Branch,
          tipMingw
        ),
        Branch: config.Sources.PortsMingw.Branch,
        TipSha: tipMingw,
        Build: () => buildMirrorCommitParentMap(mirrorMingw, config.Sources.PortsMingw.Branch)
      })
    ]);
    const precomputeStart = performance.now();
    let lastPrecomputeReport = -1;
    const cursorBranchSafeFlags = precomputeReplayCursorBranchSafeFlags({
      Queue: queue,
      ParentMapPorts: parentMapPorts,
      ParentMapMingw: parentMapMingw,
      PortsEntries: portsList,
      PortsMingwEntries: mingwList,
      OnSourceProgress: (sourceId, processed, total) => {
        if (processed === 0) {
          logger.write(`Precompute fork-safe flags ${sourceId}: start (${total} entries)`);
          return;
        }
        const pct = Math.round((processed / total) * 100);
        if (processed === total || processed - lastPrecomputeReport >= 5000) {
          logger.write(
            `Precompute fork-safe flags ${sourceId}: ${processed}/${total} (${pct}%) +${Math.round(performance.now() - precomputeStart)}ms`
          );
          lastPrecomputeReport = processed;
        }
      },
      ProgressInterval: 5000
    });
    logger.write('Precomputed fork-safe cursor branch flags');

    let replayed = 0;
    let lastPortsSha = cursorPorts;
    let lastMingwSha = cursorMingw;
    const skipEmpty = Boolean(config.Replay.SkipEmptyTreeDiff);

    for (let index = 0; index < queue.length; index++) {
      const entry = queue[index]!;
      const mirrorPath = entry.SourceId === 'ports' ? mirrorPorts : entry.SourceId === 'ports-mingw' ? mirrorMingw : null;
      const parentMap = entry.SourceId === 'ports' ? parentMapPorts : entry.SourceId === 'ports-mingw' ? parentMapMingw : null;
      if (!mirrorPath || !parentMap) {
        throw new Error(`Unknown SourceId on queue entry: ${entry.SourceId}`);
      }

      const parent = getFirstParentFromMap(parentMap, entry.Sha);
      const message = formatReplayCommitMessage({
        SortKey: entry.SortKey,
        Metadata: entry,
        UpstreamRepo: entry.UpstreamRepo,
        UpstreamSha: entry.Sha
      });

      let entryReplayed = false;
      if (dryRun) {
        const hasChanges = testUpstreamCommitHasMappedChanges(mirrorPath, entry.Sha, parent);
        if (!hasChanges && skipEmpty) {
          logger.write(`[${entry.SourceId}] skip empty diff ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
        } else {
          logger.write(`[${entry.SourceId}] dry-run would replay ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
        }
      } else {
        const hasChanges = applyUpstreamCommitToIndex({
          MirrorPath: mirrorPath,
          Commit: entry.Sha,
          Parent: parent,
          DestSubdir: entry.DestSubdir,
          DestinationPath: destPath
        });
        if (!hasChanges && skipEmpty) {
          logger.write(`[${entry.SourceId}] skip empty diff ${entry.Sha.slice(0, 8)} ${entry.Subject}`);
        } else {
          newReplayCommit(destPath, entry, message);
          runGit(destPath, ['reset', '--hard', 'HEAD']);
          replayed++;
          entryReplayed = true;
        }
      }

      if (entry.SourceId === 'ports') {
        lastPortsSha = entry.Sha;
      } else {
        lastMingwSha = entry.Sha;
      }

      if (!dryRun && entryReplayed) {
        const cursorBranchSafe = cursorBranchSafeFlags[index] ?? false;
        if (cursorBranchSafe) {
          const replayTipSha = runGitText(destPath, ['rev-parse', 'HEAD']).trim();
          const nextCursorDestShas = advanceSyncCursorDestShasIfSafe({
            SourceId: entry.SourceId,
            ReplayTipSha: replayTipSha,
            CursorBranchSafe: cursorBranchSafe,
            LastPortsDestSha: lastPortsDestSha,
            LastMingwDestSha: lastMingwDestSha
          });
          const portsDestChanged = nextCursorDestShas.PortsDestSha !== lastPortsDestSha;
          const mingwDestChanged = nextCursorDestShas.PortsMingwDestSha !== lastMingwDestSha;
          lastPortsDestSha = nextCursorDestShas.PortsDestSha;
          lastMingwDestSha = nextCursorDestShas.PortsMingwDestSha;
          if (portsDestChanged || mingwDestChanged) {
            updateDestinationCursorBranchRefs(destPath, config, {
              PortsDestSha: portsDestChanged ? lastPortsDestSha : null,
              PortsMingwDestSha: mingwDestChanged ? lastMingwDestSha : null
            });
          }
        }
      }

      if ((index + 1) % 100 === 0) {
        logger.write(`Progress: ${index + 1} (${replayed} replayed)`);
      }
    }

    if (dryRun) {
      logger.write(`Dry run complete; processed ${queue.length} queue entry(ies).`);
      process.exitCode = 0;
      return;
    }

    if (replayed > 0) {
      runGit(destPath, ['reset', '--hard', 'HEAD']);
    }

    const replayTip = runGitText(destPath, ['rev-parse', 'HEAD']).trim();
    updateDestinationSyncBranchRefs(destPath, config, {
      ReplayTipSha: replayTip,
      PortsDestSha: lastPortsDestSha,
      PortsMingwDestSha: lastMingwDestSha
    });

    logger.write(`Replayed ${replayed} commit(s); tip=${replayTip.slice(0, 8)}`);
    logger.write('Pushing destination branches');
    pushDestinationBranches(destPath, config, clean || isFullReplay);
    logger.write('Sync-Upstream done.');
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
