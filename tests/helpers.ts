// Shared test fixtures: temp directories and a small fake git repo built with real git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginTaskSnapshot } from "learnharness-plugin-api";

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `rederive-${prefix}-`));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}

function git(cwd: string, args: string[], env: Record<string, string> = {}): void {
  execFileSync("git", ["-c", "core.autocrlf=false", ...args], {
    cwd,
    stdio: "pipe",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", ...env },
  });
}

export interface FakeCommit {
  files: Record<string, string>;
  message: string;
  authorEmail?: string;
}

/** Create a git repo with local user config `me@example.com` and the given commits. */
export function makeGitRepo(dir: string, commits: FakeCommit[]): string {
  mkdirSync(dir, { recursive: true });
  git(dir, ["init", "--quiet", "--initial-branch=main"]);
  git(dir, ["config", "user.email", "me@example.com"]);
  git(dir, ["config", "user.name", "Me"]);
  for (const commit of commits) {
    for (const [path, contents] of Object.entries(commit.files)) {
      const full = join(dir, path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, contents);
    }
    git(dir, ["add", "-A"]);
    const email = commit.authorEmail ?? "me@example.com";
    git(dir, ["commit", "--quiet", "-m", commit.message], {
      GIT_AUTHOR_EMAIL: email,
      GIT_AUTHOR_NAME: email.split("@")[0]!,
      GIT_COMMITTER_EMAIL: email,
      GIT_COMMITTER_NAME: email.split("@")[0]!,
    });
  }
  return dir;
}

export const SAMPLE_README = [
  "# Tiny Search",
  "",
  "[![build](https://img.shields.io/badge/build-passing-green.svg)](https://ci.example.com)",
  "",
  "A tiny search engine in C that crawls pages, builds an inverted index, and answers queries.",
  "",
  "```sh",
  "make && ./crawler",
  "```",
  "",
  "## Usage",
  "Run the querier after indexing.",
].join("\n");

/** A valid worker result with `count` decisions (D1..Dn), for map/tool tests. */
export function sampleMapResult(count = 5) {
  return {
    rootProblem: "Finding pages about a word on a small website takes too long by hand.",
    decisions: Array.from({ length: count }, (_, i) => ({
      id: `D${i + 1}`,
      title: `Problem ${i + 1}`,
      problem: `Something has to work (${i + 1}).`,
      given: "Earlier parts.",
      constraints: [{ text: `Constraint ${i + 1}`, breaks: "the naive design" }],
      decision: { technique: `technique ${i + 1}`, definition: "A definition.", inThisCode: "index.c does it." },
      options: [
        { approach: "real approach", tradeoff: "good" },
        { approach: "other approach", tradeoff: "worse" },
      ],
      files: ["index.c"],
      needs: i === 0 ? [] : [`D${i}`],
      evidence: "code only",
    })),
  };
}

/** A build-map task snapshot, as `ctx.workers.list()` would return it. */
export function succeededTask(id: string, repoId: string, completedAt: string, result: unknown = sampleMapResult()): PluginTaskSnapshot {
  return {
    version: 1, id, definitionId: "build-map", status: "succeeded", requestId: id,
    input: { repoId, repoName: "tiny-search", repoPath: "unused", builtFrom: "abc1234" },
    prompt: "", model: { provider: "p", id: "m" }, purpose: "background", maxTurns: 30,
    createdAt: completedAt, updatedAt: completedAt, completedAt, messages: [], turns: 1, result,
  } as unknown as PluginTaskSnapshot;
}
