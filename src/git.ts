// Read-only git wrapper. Runs Git for Windows directly (no shell), with flags that keep
// a learner's repo from running its own code through git (fsmonitor; diff/show callers
// must also pass --no-ext-diff --no-textconv) and never touching global git config.
import { execFile } from "node:child_process";

export class GitError extends Error {
  readonly code: "missing" | "timeout" | "aborted" | "failed";
  constructor(code: GitError["code"], message: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
  }
}

export interface GitOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Output cap in bytes; longer output fails rather than exhausting memory. */
  maxBuffer?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** Per-invocation config. `safe.directory=*` lets git read repos owned by another user
 * (WSL UNC paths look foreign to Windows); the rest disables repo-configured programs. */
const BASE_ARGS = [
  "-c", "safe.directory=*",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "credential.interactive=never",
];

const ENV_OVERRIDES: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
};

export function runGit(args: readonly string[], options: GitOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new GitError("aborted", "Git command cancelled."));
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...BASE_ARGS, ...args],
      {
        cwd: options.cwd,
        timeout,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        signal: options.signal,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, ...ENV_OVERRIDES },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        const err = error as NodeJS.ErrnoException & { killed?: boolean };
        if (err.code === "ENOENT" && !err.killed) {
          // ENOENT comes from either a missing git binary or a missing cwd.
          return reject(new GitError("missing", "Git was not found on PATH. Install Git for Windows and restart LearnHarness."));
        }
        if (err.name === "AbortError" || options.signal?.aborted) {
          return reject(new GitError("aborted", "Git command cancelled."));
        }
        if (err.killed) {
          return reject(new GitError("timeout", `git ${args[0] ?? ""} timed out after ${Math.round(timeout / 1000)}s.`));
        }
        const detail = String(stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
        reject(new GitError("failed", `git ${args[0] ?? ""} failed: ${detail}`));
      },
    );
  });
}

/** True when `dir` is inside a git work tree. Missing git propagates as an error. */
export async function isGitWorkTree(dir: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const out = await runGit(["rev-parse", "--is-inside-work-tree"], { cwd: dir, signal, timeoutMs: 10_000 });
    return out.trim() === "true";
  } catch (error) {
    if (error instanceof GitError && error.code === "failed") return false;
    throw error;
  }
}
