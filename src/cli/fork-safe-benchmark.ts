import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { getSyncRepoRoot } from '../lib/config.ts';
import { precomputeForkSafeFlagsFromCachePath } from '../lib/fork-safe.ts';
import { getWorkDirectory, setSyncUtf8Environment } from '../lib/log.ts';
import { readStringOption } from './args.ts';

function elapsedMs(start: number): number {
  return Math.round(performance.now() - start);
}

function logTiming(label: string, ms: number, detail?: string): void {
  const suffix = detail ? ` (${detail})` : '';
  console.log(`[fork-safe] ${label}: ${ms}ms${suffix}`);
}

function resolveCachePath(cacheDir: string, sourceKey: string, explicitPath: string | null): string {
  if (explicitPath) {
    return explicitPath;
  }

  const prefix = `parent-map-${sourceKey}-`;
  const matches = readdirSync(cacheDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
    .sort();
  if (matches.length === 0) {
    throw new Error(`No cache file matching ${prefix}*.json in ${cacheDir}`);
  }
  return join(cacheDir, matches[matches.length - 1]!);
}

async function main(): Promise<void> {
  setSyncUtf8Environment();
  const args = process.argv.slice(2);
  const repoRoot = getSyncRepoRoot();
  const work = getWorkDirectory(repoRoot);
  const cacheDir = readStringOption(args, '--cache-dir') ?? join(work, 'cache', 'replay-graph');
  const portsCachePath = readStringOption(args, '--ports-cache');
  const mingwCachePath = readStringOption(args, '--mingw-cache');

  if (!existsSync(cacheDir)) {
    throw new Error(`Cache directory not found: ${cacheDir}`);
  }

  const totalStart = performance.now();
  const portsPath = resolveCachePath(cacheDir, 'Ports', portsCachePath ?? null);
  const mingwPath = resolveCachePath(cacheDir, 'PortsMingw', mingwCachePath ?? null);

  for (const [label, cachePath] of [['ports', portsPath], ['mingw', mingwPath]] as const) {
    let lastReport = -1;
    const loadStart = performance.now();
    const stepStart = performance.now();
    const result = precomputeForkSafeFlagsFromCachePath(cachePath, {
      ProgressInterval: 5000,
      OnProgress: (processed, total) => {
        if (processed === 0) {
          console.log(`[fork-safe] ${label} precompute: start (${total} entries)`);
          return;
        }
        if (processed === total || processed - lastReport >= 5000) {
          const pct = Math.round((processed / total) * 100);
          logTiming(
            `${label} precompute`,
            elapsedMs(stepStart),
            `${processed}/${total} (${pct}%)`
          );
          lastReport = processed;
        }
      }
    });
    if (!result) {
      throw new Error(`Cache file not found: ${cachePath}`);
    }

    const safeCount = result.Flags.filter(Boolean).length;
    logTiming(`${label} load + precompute`, elapsedMs(loadStart), `commits=${result.Shas.length} safe=${safeCount} tip=${result.TipSha.slice(0, 8)}`);
    console.log(`[fork-safe] ${label} cache -> ${cachePath}`);
  }

  logTiming('total', elapsedMs(totalStart));
  console.log('[fork-safe] done.');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
