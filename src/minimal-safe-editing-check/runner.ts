import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { CheckerArgs, Diagnostic, ProcessResult } from "./constants.js";
import { TEXT_EXTENSIONS } from "./constants.js";
import { toPosix } from "./args.js";
import { getEditorConfigForPath, loadEditorConfigSections } from "./editorconfig.js";
import { detectEncodingMetadata, outputLineEndingSep } from "./detect.js";
import { decodeFile } from "./decode.js";
import {
  applyOutputEol,
  collectUnsupportedPunctuation,
  firstDiffLine,
  normalizeText,
  toUtf8Bytes,
} from "./normalize.js";

function listTrackedTextFiles(repoRoot: string): string[] {
  const raw = execFileSync("git", ["-C", repoRoot, "ls-files"], {
    encoding: "utf8",
  });
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s)
    .filter((s) => TEXT_EXTENSIONS.has(path.extname(s).toLowerCase()))
    .sort((a, b) => a.localeCompare(b));
}

export function processFile(
  repoRoot: string,
  relPath: string,
  args: CheckerArgs,
  editorSections: ReturnType<typeof loadEditorConfigSections>,
): ProcessResult {
  const absPath = path.join(repoRoot, relPath);
  const raw = fs.readFileSync(absPath);
  const editorProps = getEditorConfigForPath(editorSections, relPath);
  const meta = detectEncodingMetadata(raw, relPath, repoRoot, editorProps);
  const diagnostics: Diagnostic[] = [];

  let decoded;
  try {
    decoded = decodeFile(raw, relPath, repoRoot, editorProps, args);
  } catch (err) {
    diagnostics.push({
      path: relPath,
      line: 1,
      reason: String((err as Error).message ?? err),
    });
    return { diagnostics, changed: false };
  }

  const normalizedLf = normalizeText(decoded.text, decoded.hadLeadingBom);
  const eolSep = outputLineEndingSep(meta.outputLineEnding);
  const normalized = applyOutputEol(normalizedLf, eolSep);
  const body = normalizedLf.startsWith("\uFEFF") ? normalizedLf.slice(1) : normalizedLf;
  const unsupported = collectUnsupportedPunctuation(body);
  for (const issue of unsupported) {
    diagnostics.push({
      path: relPath,
      line: issue.line,
      reason: issue.reason,
    });
  }

  const outBytes = toUtf8Bytes(normalized);
  const wouldChange = !Buffer.from(outBytes).equals(raw);
  if (wouldChange) {
    if (args.write) {
      fs.writeFileSync(absPath, Buffer.from(outBytes));
    } else {
      diagnostics.push({
        path: relPath,
        line: firstDiffLine(decoded.text, normalizedLf),
        reason: "would-normalize",
      });
    }
    return { diagnostics, changed: true };
  }
  return { diagnostics, changed: false };
}

export function runChecker(args: CheckerArgs, repoRoot: string = process.cwd()) {
  const editorSections = loadEditorConfigSections(repoRoot);
  const relPaths =
    args.paths.length > 0
      ? args.paths.map((p) => toPosix(path.relative(repoRoot, path.resolve(repoRoot, p))))
      : listTrackedTextFiles(repoRoot);

  const allowlistSet = new Set(args.allowlist.map((p) => toPosix(p)));
  const diagnostics: Diagnostic[] = [];
  let changed = 0;

  for (const relPath of relPaths.sort((a, b) => a.localeCompare(b))) {
    const absPath = path.join(repoRoot, relPath);
    if (!fs.existsSync(absPath)) {
      continue;
    }
    if (allowlistSet.has(relPath)) {
      continue;
    }
    const result = processFile(repoRoot, relPath, args, editorSections);
    diagnostics.push(...result.diagnostics);
    if (result.changed) {
      changed++;
    }
  }

  diagnostics.sort((a, b) => {
    if (a.path !== b.path) {
      return a.path.localeCompare(b.path);
    }
    return a.line - b.line;
  });

  return { diagnostics, changed, write: args.write };
}

export function printResults(result: ReturnType<typeof runChecker>): number {
  for (const d of result.diagnostics) {
    console.error(`${d.path}:${d.line}:${d.reason}`);
  }
  if (result.diagnostics.length > 0) {
    return 1;
  }
  if (result.write) {
    console.log(`normalized ${result.changed} file(s)`);
  } else {
    console.log("text normalization check passed");
  }
  return 0;
}
