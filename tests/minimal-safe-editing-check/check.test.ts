import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/minimal-safe-editing-check/args.js";
import { printResults, runChecker } from "../../src/minimal-safe-editing-check/runner.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const tmpDirs: string[] = [];
const gitTracked: string[] = [];

afterEach(() => {
  for (const rel of gitTracked) {
    try {
      execFileSync("git", ["-C", repoRoot, "reset", "-q", "--", rel], { stdio: "ignore" });
    } catch {
      // ignore
    }
  }
  gitTracked.length = 0;
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(repoRoot, ".work", "tmp", "msec-"));
  tmpDirs.push(dir);
  return dir;
}

function runCheck(filePath: string, extra: string[] = []) {
  const args = parseArgs(["--check", "--path", filePath, ...extra]);
  return runChecker(args, repoRoot);
}

function runWrite(filePath: string, extra: string[] = []) {
  const args = parseArgs(["--write", "--path", filePath, ...extra]);
  return runChecker(args, repoRoot);
}

describe("minimal-safe-editing-check", () => {
  it("utf8-known-dash: check fails on em dash, write normalizes", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "utf8.md");
    fs.writeFileSync(file, "A\u2014B\n", "utf8");
    expect(printResults(runCheck(file))).toBe(1);
    expect(printResults(runWrite(file))).toBe(0);
    expect(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe("A-B\n");
  });

  it("gbk-known-dash: guess maps em dash bytes to ascii", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "gbk.md");
    fs.writeFileSync(file, Buffer.from([0x41, 0xa1, 0xaa, 0x42, 0x0a]));
    expect(printResults(runWrite(file))).toBe(0);
    expect(fs.readFileSync(file, "utf8")).toBe("A-B\n");
  });

  it("cp1252-known-dash: guess maps en dash byte to ascii", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "cp.md");
    fs.writeFileSync(file, Buffer.from([0x41, 0x96, 0x42, 0x0a]));
    expect(printResults(runWrite(file))).toBe(0);
    expect(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).toBe("A-B\n");
  });

  it("bom-leading-keep: leading bom kept, mid bom removed", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "bom.md");
    fs.writeFileSync(file, Buffer.from([0xef, 0xbb, 0xbf, 0x41, 0xef, 0xbb, 0xbf, 0x42, 0x0a]));
    expect(printResults(runWrite(file))).toBe(0);
    const bytes = fs.readFileSync(file);
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(bytes.includes(0xef) && bytes.indexOf(0xef) === 0).toBe(true);
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    expect(hex.match(/ef bb bf/g)?.length).toBe(1);
  });

  it("pstar-unmapped-check: unmapped punctuation fails check", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "unsupported.md");
    fs.writeFileSync(file, "A\u3002B\n", "utf8");
    expect(printResults(runCheck(file))).toBe(1);
  });

  it("pstar-unmapped-write: unmapped punctuation unchanged in write mode", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "unsupported.md");
    const before = Buffer.from("A\u3002B\n", "utf8");
    fs.writeFileSync(file, before);
    expect(printResults(runWrite(file))).toBe(1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });

  it("allowlist-unmapped: allowlist skips unmapped punctuation failure", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "unsupported.md");
    fs.writeFileSync(file, "A\u3002B\n", "utf8");
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    expect(printResults(runCheck(file, ["--allowlist", rel]))).toBe(0);
  });

  it("write-idempotent: second write reports no changes", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "idempotent.md");
    fs.writeFileSync(file, "A\u2014B\n", "utf8");
    expect(printResults(runWrite(file))).toBe(0);
    const second = runWrite(file);
    expect(printResults(second)).toBe(0);
    expect(second.changed).toBe(0);
  });

  it("eol-new-editorconfig: untracked file uses editorconfig lf", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "eol-new.md");
    fs.writeFileSync(file, Buffer.from([0x41, 0xe2, 0x80, 0x94, 0x42, 0x0d, 0x0a]));
    expect(printResults(runWrite(file))).toBe(0);
    const bytes = fs.readFileSync(file);
    expect([...bytes]).toEqual([0x41, 0x2d, 0x42, 0x0a]);
  });

  it("eol-existing-keep: tracked file keeps crlf", () => {
    const file = path.join(
      repoRoot,
      "tests",
      `.eol-tracked-${Date.now()}-${Math.random().toString(16).slice(2)}.md`,
    );
    fs.writeFileSync(file, Buffer.from([0x41, 0xe2, 0x80, 0x94, 0x42, 0x0d, 0x0a]));
    const rel = path.relative(repoRoot, file).replace(/\\/g, "/");
    execFileSync("git", ["-C", repoRoot, "add", "-N", "--", rel]);
    gitTracked.push(rel);
    try {
      expect(printResults(runWrite(file))).toBe(0);
      const bytes = fs.readFileSync(file);
      expect([...bytes]).toEqual([0x41, 0x2d, 0x42, 0x0d, 0x0a]);
    } finally {
      fs.unlinkSync(file);
    }
  });

  it("check-no-write: check mode does not write", () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "check.md");
    const before = Buffer.from("A\u2014B\n", "utf8");
    fs.writeFileSync(file, before);
    expect(printResults(runCheck(file))).toBe(1);
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});
