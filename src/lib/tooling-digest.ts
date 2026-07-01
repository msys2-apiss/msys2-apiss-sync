import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Logger } from '../git/log.ts';
import {
  MIRROR_MERGE_CONFIG_PATH,
  MIRROR_SYNC_CONFIG_DIR,
  MIRROR_TEMPLATE_DIR,
  MIRROR_TOOLINGS_TEMPLATE_DIR,
  TOOLING_DIGEST_PATH
} from '../types/constants.ts';

export type RepoToolingKind = 'destination' | 'mirror';

const MIRROR_SYNC_WORKFLOW = `${MIRROR_TEMPLATE_DIR}/mirror-sync.yml`;
const MIRROR_MERGE_WORKFLOW = `${MIRROR_TEMPLATE_DIR}/mirror-merge.yml`;

function listFilesUnderDir(absDir: string, relPrefix: string): string[] {
  if (!existsSync(absDir)) {
    return [];
  }
  const files: string[] = [];

  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push(`${relPrefix}/${rel}`.replace(/\\/g, '/'));
      }
    }
  }

  walk(absDir, '');
  return files;
}

function hashFilePaths(repoRoot: string, paths: string[]): string {
  const sorted = [...paths].sort();
  const hash = createHash('sha256');
  for (const rel of sorted) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) {
      throw new Error(`Missing digest input file: ${rel}`);
    }
    hash.update(rel);
    hash.update('\0');
    hash.update(readFileSync(abs));
  }
  return hash.digest('hex');
}

export function computeRepoToolingDigest(
  repoRoot: string,
  repo: string,
  kind: RepoToolingKind
): string {
  const paths: string[] = listFilesUnderDir(
    join(repoRoot, MIRROR_TOOLINGS_TEMPLATE_DIR),
    MIRROR_TOOLINGS_TEMPLATE_DIR
  );

  if (kind === 'destination') {
    paths.push(MIRROR_MERGE_WORKFLOW, MIRROR_MERGE_CONFIG_PATH);
  } else {
    paths.push(MIRROR_SYNC_WORKFLOW, `${MIRROR_SYNC_CONFIG_DIR}/${repo}.json`);
  }

  return hashFilePaths(repoRoot, paths);
}

export function loadDigestMap(repoRoot: string, logger?: Logger): Record<string, string> {
  const path = join(repoRoot, TOOLING_DIGEST_PATH);
  if (!existsSync(path)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('digest.json must be a JSON object');
    }
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') {
        map[key] = value;
      }
    }
    return map;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const warn = (text: string) => {
      if (logger) {
        logger.write(text, 'Warn');
      } else {
        console.warn(text);
      }
    };
    warn(`${TOOLING_DIGEST_PATH}: invalid or unreadable (${message}); treating as empty map`);
    return {};
  }
}

export function saveDigestMap(repoRoot: string, map: Record<string, string>): void {
  const path = join(repoRoot, TOOLING_DIGEST_PATH);
  const sorted: Record<string, string> = {};
  for (const key of Object.keys(map).sort()) {
    sorted[key] = map[key]!;
  }
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

export function repoNeedsBootstrap(
  map: Record<string, string>,
  repo: string,
  digest: string
): boolean {
  return map[repo] === undefined || map[repo] !== digest;
}

export function pinRepoDigest(map: Record<string, string>, repo: string, digest: string): void {
  map[repo] = digest;
}
