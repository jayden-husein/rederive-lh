// Read-only git wrapper. Runs git directly (no shell), with flags that keep a learner's
// repo from running its own code through git (fsmonitor, signature checks, lazy fetch; diff/show
// callers must also pass --no-ext-diff --no-textconv) and never touching global git config.
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

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
  /** Extra environment variables for this call only. */
  env?: Record<string, string>;
}

/** For git calls in a clone we made ourselves: it may fetch the file contents it left out. */
export const LAZY_FETCH = { GIT_NO_LAZY_FETCH: "0" };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** Per-invocation config. `safe.directory=*` lets git read repos owned by another user
 * (WSL UNC paths look foreign to Windows); the rest disables repo-configured programs. */
const BASE_ARGS = [
  "-c", "safe.directory=*",
  "-c", "core.fsmonitor=false",
  "-c", "core.pager=cat",
  "-c", "credential.interactive=never",
  // With it on, log and show run the repo's gpg.program on signed commits.
  "-c", "log.showSignature=false",
];

/**
 * A folder's .git/config can claim to be a partial clone; git then fetches any missing
 * object, and that fetch runs a command the same config names. Only our own clones (made
 * with --filter=blob:none) pass GIT_NO_LAZY_FETCH "0". Needs Git 2.45 or a patched older one.
 */
const ENV_DEFAULTS: Record<string, string> = { GIT_NO_LAZY_FETCH: "1" };

const ENV_OVERRIDES: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
};

export function runGit(args: readonly string[], options: GitOptions): Promise<string> {
  if (options.signal?.aborted) return Promise.reject(new GitError("aborted", "Git command cancelled."));
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // The subcommand, for messages: callers may put "-c name=value" pairs first.
  const command = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "-c") ?? "";
  return new Promise((resolve, reject) => {
    // The timeout and the cancel are ours, not execFile's, so that stopping can take
    // git's helper processes along (see killTree).
    let stopped: "aborted" | "timeout" | null = null;
    const stop = (why: "aborted" | "timeout") => {
      if (stopped) return;
      stopped = why;
      killTree(child);
    };
    const onAbort = () => stop("aborted");
    const child = execFile(
      "git",
      [...BASE_ARGS, ...args],
      {
        cwd: options.cwd,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        windowsHide: true,
        encoding: "utf8",
        env: { ...process.env, ...ENV_DEFAULTS, ...options.env, ...ENV_OVERRIDES },
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (!error) return resolve(stdout);
        const err = error as NodeJS.ErrnoException;
        if (err.code === "ENOENT" && !stopped) {
          // ENOENT comes from either a missing git binary or a missing cwd.
          if (!existsSync(options.cwd)) return reject(new GitError("failed", `Folder not found: ${options.cwd}`));
          return reject(new GitError("missing", "Git was not found on PATH. Install Git and restart LearnHarness."));
        }
        if (stopped === "aborted") return reject(new GitError("aborted", "Git command cancelled."));
        if (stopped === "timeout") {
          return reject(new GitError("timeout", `git ${command} timed out after ${Math.round(timeout / 1000)}s.`));
        }
        const detail = String(stderr || err.message).trim().split(/\r?\n/).slice(-3).join(" ");
        reject(new GitError("failed", `git ${command} failed: ${detail}`));
      },
    );
    const timer = setTimeout(() => stop("timeout"), timeout);
    options.signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Stop git and the helpers it started. Windows ends only the process it is told to, so a
 * killed `git clone` would leave git-remote-https and index-pack running: they keep
 * downloading and hold the clone's files, so the folder can't be removed. Elsewhere git
 * gets SIGTERM and stops its own helpers.
 */
function killTree(child: ChildProcess): void {
  if (process.platform !== "win32" || child.pid === undefined) return void child.kill();
  // If taskkill can't run, fall back to ending git alone.
  execFile("taskkill", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true }, (error) => {
    if (error) child.kill();
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
