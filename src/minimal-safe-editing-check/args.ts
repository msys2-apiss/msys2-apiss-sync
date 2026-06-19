import type { CheckerArgs } from "./constants.js";

export function parseArgs(argv: string[]): CheckerArgs {
  const args: CheckerArgs = {
    check: true,
    write: false,
    paths: [],
    allowlist: [],
    fallbackScope: [],
    fallbackEncodings: ["gbk", "cp1252"],
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--check") {
      args.check = true;
      args.write = false;
    } else if (arg === "--write") {
      args.write = true;
      args.check = false;
    } else if (arg === "--path") {
      args.paths.push(argv[++i]);
    } else if (arg === "--allowlist") {
      args.allowlist.push(argv[++i]);
    } else if (arg === "--fallback-scope") {
      args.fallbackScope.push(argv[++i]);
    } else if (arg === "--fallback-encoding") {
      const enc = argv[++i];
      args.fallbackEncodings.push(enc === "windows-1252" ? "cp1252" : enc);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function toPosix(relPath: string): string {
  return relPath.replace(/\\/g, "/");
}

export function globToRegex(globPattern: string): RegExp {
  const escaped = globPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "__DOUBLE_STAR__")
    .replace(/\*/g, "[^/]*")
    .replace(/__DOUBLE_STAR__/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchesAnyGlob(relPath: string, patterns: string[]): boolean {
  if (patterns.length === 0) {
    return false;
  }
  return patterns.some((p) => globToRegex(p).test(relPath));
}
