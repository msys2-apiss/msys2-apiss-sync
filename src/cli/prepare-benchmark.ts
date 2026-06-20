import { join } from 'node:path';

import { performance } from 'node:perf_hooks';

import { getSyncRepoRoot, loadSyncConfig } from '../lib/config.ts';
import { getMirrorTipSha, getSourceReplayHistory } from '../lib/history.ts';
import { getWorkDirectory, setSyncUtf8Environment, type SyncLogger } from '../lib/log.ts';
import {
  buildMirrorCommitParentMap,
  filterReplayQueueByAge,
  mergeReplayCommitQueues,
  precomputeSourceCursorBranchSafeFlags
} from '../lib/queue.ts';
import {
  getMirrorParentGraphCachePath,
  loadOrBuildMirrorCommitParentMap
} from '../lib/replay-graph.ts';
import {
  ensureDestinationBaseCommit,
  getDestinationBranchSha,
  initializeDestinationAlternates,
  initializeDestinationRepository,
  initializeMirrorRepository,
  resolveSyncRetrieveCursorsFromBranches,
  testAllSyncBranchesExist
} from '../lib/repos.ts';
import { readFlag, readStringOption } from './args.ts';

const silentLogger: SyncLogger = {
  write() {},
  close() {}
};

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function logTiming(label: string, ms: number, detail?: string): void {
  const suffix = detail ? ` (${detail})` : '';
  console.log(`[prepare] ${label}: ${ms}ms${suffix}`);
}

function makePrecomputeProgress(label: string, stepStart: number, interval = 2000) {
  let lastReport = -1;
  return (processed: number, total: number) => {
    if (processed === 0) {
      console.log(`[prepare] ${label}: start (${total} entries)`);
      return;
    }
    const pct = Math.round((processed / total) * 100);
    if (processed === total || processed - lastReport >= interval) {
      console.log(`[prepare] ${label}: ${processed}/${total} (${pct}%) +${elapsedMs(stepStart)}ms`);
      lastReport = processed;
    }
  };
}

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const config = loadSyncConfig(repoRoot);
  const work = getWorkDirectory(repoRoot);
  const skipFetch = readFlag(args, '--skip-fetch');
  const graphOnly = readFlag(args, '--graph-only');
  const destinationPathArg = readStringOption(args, '--destination-path');

  const totalStart = performance.now();
  console.log(`[prepare] Prepare benchmark start (graphOnly=${graphOnly})`);

  let stepStart = performance.now();
  const mirrorPorts = initializeMirrorRepository({
    WorkDirectory: work,
    SourceKey: 'Ports',
    Config: config,
    SkipFetch: skipFetch,
    Logger: silentLogger
  });
  const mirrorMingw = initializeMirrorRepository({
    WorkDirectory: work,
    SourceKey: 'PortsMingw',
    Config: config,
    SkipFetch: skipFetch,
    Logger: silentLogger
  });
  logTiming('init mirrors', elapsedMs(stepStart));

  const tipPorts = getMirrorTipSha(mirrorPorts, config.Sources.Ports.Branch);
  const tipMingw = getMirrorTipSha(mirrorMingw, config.Sources.PortsMingw.Branch);
  console.log(`[prepare] tips ports=${tipPorts.slice(0, 8)} mingw=${tipMingw.slice(0, 8)}`);

  const graphCacheDir = join(work, 'cache', 'replay-graph');
  const portsCachePath = getMirrorParentGraphCachePath(
    graphCacheDir,
    'Ports',
    config.Sources.Ports.Branch,
    tipPorts
  );
  const mingwCachePath = getMirrorParentGraphCachePath(
    graphCacheDir,
    'PortsMingw',
    config.Sources.PortsMingw.Branch,
    tipMingw
  );

  stepStart = performance.now();
  const portsParentStart = performance.now();
  const portsParentPromise = loadOrBuildMirrorCommitParentMap({
    CachePath: portsCachePath,
    Branch: config.Sources.Ports.Branch,
    TipSha: tipPorts,
    Build: () => buildMirrorCommitParentMap(mirrorPorts, config.Sources.Ports.Branch)
  }).then((map) => {
    logTiming('parent map ports', elapsedMs(portsParentStart), `commits=${map.size}`);
    return map;
  });
  const mingwParentStart = performance.now();
  const mingwParentPromise = loadOrBuildMirrorCommitParentMap({
    CachePath: mingwCachePath,
    Branch: config.Sources.PortsMingw.Branch,
    TipSha: tipMingw,
    Build: () => buildMirrorCommitParentMap(mirrorMingw, config.Sources.PortsMingw.Branch)
  }).then((map) => {
    logTiming('parent map mingw', elapsedMs(mingwParentStart), `commits=${map.size}`);
    return map;
  });
  await Promise.all([portsParentPromise, mingwParentPromise]);
  logTiming('parent maps (wall)', elapsedMs(stepStart));
  console.log(`[prepare] saved ports -> ${portsCachePath}`);
  console.log(`[prepare] saved mingw -> ${mingwCachePath}`);

  if (graphOnly) {
    logTiming('total', elapsedMs(totalStart));
    console.log('[prepare] Done.');
    return;
  }

  stepStart = performance.now();
  const destPath = initializeDestinationRepository({
    WorkDirectory: work,
    Config: config,
    DestinationPath: destinationPathArg,
    SkipFetch: skipFetch,
    Logger: silentLogger
  });
  initializeDestinationAlternates(destPath, [mirrorPorts, mirrorMingw]);
  ensureDestinationBaseCommit(destPath, config, silentLogger);
  logTiming('init destination', elapsedMs(stepStart));

  stepStart = performance.now();
  const retrieveCursors = resolveSyncRetrieveCursorsFromBranches(destPath, config);
  const cursorPorts = retrieveCursors.PortsUpstreamSha;
  const cursorMingw = retrieveCursors.PortsMingwUpstreamSha;
  const isFullReplay = !testAllSyncBranchesExist(destPath, config);
  const replayTipSha = getDestinationBranchSha(destPath, config.Destination.Branches.Replay);
  logTiming('read cursors', elapsedMs(stepStart), `fullReplay=${isFullReplay} replayTip=${replayTipSha ? replayTipSha.slice(0, 8) : 'none'}`);

  if (cursorPorts && cursorMingw) {
    console.log(`[prepare] cursors ports=${cursorPorts.slice(0, 8)} mingw=${cursorMingw.slice(0, 8)}`);
  }

  stepStart = performance.now();
  const portsHistoryStart = performance.now();
  const portsHistoryPromise = getSourceReplayHistory('Ports', config, mirrorPorts, cursorPorts, tipPorts).then(
    (entries) => {
      logTiming('retrieve history ports', elapsedMs(portsHistoryStart), `count=${entries.length}`);
      return entries;
    }
  );
  const mingwHistoryStart = performance.now();
  const mingwHistoryPromise = getSourceReplayHistory('PortsMingw', config, mirrorMingw, cursorMingw, tipMingw).then(
    (entries) => {
      logTiming('retrieve history mingw', elapsedMs(mingwHistoryStart), `count=${entries.length}`);
      return entries;
    }
  );
  const [portsList, mingwList] = await Promise.all([portsHistoryPromise, mingwHistoryPromise]);
  logTiming('retrieve history (wall)', elapsedMs(stepStart));

  stepStart = performance.now();
  let queue = mergeReplayCommitQueues(portsList, mingwList);
  logTiming('merge queue', elapsedMs(stepStart), `merged=${queue.length}`);

  if (!isFullReplay) {
    stepStart = performance.now();
    queue = filterReplayQueueByAge(queue, config, (message) => console.log(`[prepare] ${message}`));
    logTiming('age gate', elapsedMs(stepStart), `remaining=${queue.length}`);
  } else {
    console.log('[prepare] age gate: skipped (full replay)');
  }

  if (queue.length === 0) {
    logTiming('total', elapsedMs(totalStart));
    console.log('[prepare] No commits to replay.');
    return;
  }

  const prepareCoreStart = performance.now();
  const parentReloadStart = performance.now();
  const [parentMapPorts, parentMapMingw] = await Promise.all([
    loadOrBuildMirrorCommitParentMap({
      CachePath: portsCachePath,
      Branch: config.Sources.Ports.Branch,
      TipSha: tipPorts,
      Build: () => buildMirrorCommitParentMap(mirrorPorts, config.Sources.Ports.Branch)
    }),
    loadOrBuildMirrorCommitParentMap({
      CachePath: mingwCachePath,
      Branch: config.Sources.PortsMingw.Branch,
      TipSha: tipMingw,
      Build: () => buildMirrorCommitParentMap(mirrorMingw, config.Sources.PortsMingw.Branch)
    })
  ]);
  logTiming('parent maps reload (wall)', elapsedMs(parentReloadStart));
  console.log('[prepare] fork-safe precompute: start');

  stepStart = performance.now();
  const portsSafeStart = performance.now();
  const portsSafe = precomputeSourceCursorBranchSafeFlags(
    portsList,
    parentMapPorts,
    undefined,
    makePrecomputeProgress('fork-safe precompute ports', portsSafeStart),
    2000
  );
  logTiming('fork-safe precompute ports', elapsedMs(portsSafeStart), `entries=${portsList.length} safe=${portsSafe.filter(Boolean).length}`);

  const mingwSafeStart = performance.now();
  const mingwSafe = precomputeSourceCursorBranchSafeFlags(
    mingwList,
    parentMapMingw,
    undefined,
    makePrecomputeProgress('fork-safe precompute mingw', mingwSafeStart),
    2000
  );
  logTiming('fork-safe precompute mingw', elapsedMs(mingwSafeStart), `entries=${mingwList.length} safe=${mingwSafe.filter(Boolean).length}`);

  const mergeStart = performance.now();
  const cursorBranchSafeFlags = new Array<boolean>(queue.length);
  let portsIndex = 0;
  let mingwIndex = 0;
  let portsCursorSafe = true;
  let mingwCursorSafe = true;
  for (let index = 0; index < queue.length; index++) {
    const entry = queue[index]!;
    if (entry.SourceId === 'ports') {
      portsCursorSafe = portsSafe[portsIndex] ?? true;
      portsIndex++;
    } else {
      mingwCursorSafe = mingwSafe[mingwIndex] ?? true;
      mingwIndex++;
    }
    cursorBranchSafeFlags[index] = portsCursorSafe && mingwCursorSafe;
  }
  logTiming('fork-safe merge flags', elapsedMs(mergeStart), `queue=${queue.length} safe=${cursorBranchSafeFlags.filter(Boolean).length}`);
  logTiming('fork-safe precompute (total)', elapsedMs(stepStart));

  logTiming('prepare core (parent maps + precompute)', elapsedMs(prepareCoreStart));
  logTiming('total', elapsedMs(totalStart));
  console.log('[prepare] Done.');
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[prepare][error] ${message}`);
  process.exitCode = 1;
});
