import type { SourceKey } from '../types/replay-entry.ts';
import { getSourceConfigEntry, type SyncConfig } from './config.ts';
import { runGitText } from './git.ts';
import { convertToUnixLineEndings } from './log.ts';
import { getDiffTreeEntries, getFirstParent } from './replay.ts';

export interface ResolvedMirrorSource {
  SourceKey: SourceKey;
  DestSubdir: string;
  SortKey: string;
}

export function resolveMirrorSourceFromCli(input: string, config: SyncConfig): ResolvedMirrorSource {
  const normalized = input.trim();
  for (const sourceKey of ['Ports', 'PortsMingw'] as const) {
    const entry = getSourceConfigEntry(config, sourceKey);
    const aliases = [
      sourceKey,
      entry.SortKey,
      entry.Repo,
      entry.Repo.toLowerCase(),
      `${entry.Owner}/${entry.Repo}`
    ];
    if (aliases.includes(normalized)) {
      return {
        SourceKey: sourceKey,
        DestSubdir: entry.DestSubdir,
        SortKey: entry.SortKey
      };
    }
  }
  throw new Error(`Unknown --source ${input}; use ports or ports-mingw`);
}

function mapDiffGitPath(path: string, destSubdir: string): string {
  if (path === '/dev/null') {
    return path;
  }
  if (path.startsWith('a/') || path.startsWith('b/')) {
    return `${path.slice(0, 2)}${destSubdir}/${path.slice(2)}`;
  }
  return `${destSubdir}/${path}`;
}

export function rewriteUnifiedDiffPaths(diffText: string, destSubdir: string): string {
  const lines = convertToUnixLineEndings(diffText).split('\n');
  const rewritten: string[] = [];

  for (const line of lines) {
    const diffGit = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (diffGit) {
      rewritten.push(`diff --git ${mapDiffGitPath(`a/${diffGit[1]!}`, destSubdir)} ${mapDiffGitPath(`b/${diffGit[2]!}`, destSubdir)}`);
      continue;
    }

    const oldPath = /^--- (a\/.*)$/.exec(line);
    if (oldPath) {
      rewritten.push(`--- ${mapDiffGitPath(oldPath[1]!, destSubdir)}`);
      continue;
    }

    const newPath = /^\+\+\+ (b\/.*)$/.exec(line);
    if (newPath) {
      rewritten.push(`+++ ${mapDiffGitPath(newPath[1]!, destSubdir)}`);
      continue;
    }

    const renameFrom = /^rename from (.+)$/.exec(line);
    if (renameFrom) {
      rewritten.push(`rename from ${destSubdir}/${renameFrom[1]!}`);
      continue;
    }

    const renameTo = /^rename to (.+)$/.exec(line);
    if (renameTo) {
      rewritten.push(`rename to ${destSubdir}/${renameTo[1]!}`);
      continue;
    }

    rewritten.push(line);
  }

  return rewritten.join('\n');
}

export function formatMappedUnifiedDiff(
  mirrorPath: string,
  parent: string,
  commit: string,
  destSubdir: string
): string {
  const raw = runGitText(mirrorPath, ['diff', '--patch', '--full-index', parent, commit]);
  return rewriteUnifiedDiffPaths(raw, destSubdir);
}

export function listMappedPatchPaths(
  mirrorPath: string,
  parent: string,
  commit: string,
  destSubdir: string
): string[] {
  const paths: string[] = [];
  for (const entry of getDiffTreeEntries(mirrorPath, parent, commit)) {
    if (entry.Kind === 'Delete') {
      paths.push(`${destSubdir}/${entry.Path}`);
    } else {
      paths.push(`${destSubdir}/${entry.Path}`);
    }
  }
  return paths;
}

export function listMirrorCommitShas(mirrorPath: string, range: string): string[] {
  const raw = runGitText(mirrorPath, ['rev-list', '--reverse', range]).trim();
  if (!raw) {
    return [];
  }
  return raw.split('\n').filter((line) => line.length > 0);
}

export function resolveMirrorCommitParent(mirrorPath: string, commit: string, parent?: string): string {
  return parent ?? getFirstParent(mirrorPath, commit);
}
