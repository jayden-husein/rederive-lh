// Shared test fixtures: temp directories and a small fake git repo built with real git.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
