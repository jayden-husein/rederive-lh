// Opening a repo the learner wants to study: a local folder (including WSL UNC paths)
// or a git URL that we clone into the plugin's data directory. Never writes to, or runs
// code from, the learner's repo.
import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { GitError, isGitWorkTree, runGit } from "./git.ts";

export type RepoSource =
  | { kind: "local"; path: string }
  | { kind: "url"; url: string };

/** Only network transports; `file://`, `ext::` and friends are refused. */
const NETWORK_TRANSPORTS = [
  "-c", "protocol.allow=never",
  "-c", "protocol.https.allow=always",
  "-c", "protocol.ssh.allow=always",
];

const HTTPS_URL = /^https:\/\/[^\s/@]+(?:@[^\s/]+)?\/\S+$/i;
const SSH_URL = /^ssh:\/\/[^\s/]+\/\S+$/i;
const SCP_URL = /^[\w.-]+@[\w.-]+:(?!\/\/)[\w./~-]+$/;

export function parseSource(raw: string): RepoSource {
  const source = raw.trim().replace(/^["']|["']$/g, "");
  if (source === "") throw new Error("Give a local folder path or a git URL.");
  if (HTTPS_URL.test(source) || SSH_URL.test(source) || SCP_URL.test(source)) {
    return { kind: "url", url: source };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(source)) {
    throw new Error(`Unsupported URL: ${source}. Use an https:// or ssh:// git URL.`);
  }
  if (source.startsWith("/") && !source.startsWith("//") && process.platform === "win32") {
    throw new Error(
      `"${source}" looks like a WSL/Linux path, which Windows can't open directly. ` +
        "Use the UNC form instead, e.g. \\\\wsl.localhost\\<distro>" + source.replace(/\//g, "\\") + ".",
    );
  }
  // "~/code/x" (as typed in macOS and Linux shells) means the home folder.
  const path = /^~(?=$|[\\/])/.test(source) ? join(homedir(), source.slice(1)) : source;
  // node:path is platform-specific: drive and UNC paths on Windows, "/" paths elsewhere.
  if (!isAbsolute(path)) {
    throw new Error(`"${source}" is a relative path. Give the full path to the repo folder.`);
  }
  return { kind: "local", path: resolve(path) };
}

function normalizeUrl(url: string): string {
  let out = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  out = out.replace(/^(https:\/\/|ssh:\/\/)([^/]+)/i, (_m, scheme: string, host: string) => scheme.toLowerCase() + host.toLowerCase());
  out = out.replace(/^([\w.-]+@)([\w.-]+):/, (_m, user: string, host: string) => user + host.toLowerCase() + ":");
  return out;
}

function normalizeLocal(path: string): string {
  const resolved = resolve(path).replace(/[\\/]+$/, "");
  // Windows drive paths are case-insensitive; WSL (UNC) paths are not.
  return process.platform === "win32" && !resolved.startsWith("\\\\") ? resolved.toLowerCase() : resolved;
}

function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (s || "repo").slice(0, 40);
}

export function displayName(source: RepoSource): string {
  const raw = source.kind === "local" ? source.path.replace(/[\\/]+$/, "") : normalizeUrl(source.url);
  return raw.split(/[\\/:]/).pop() || "repo";
}

/** Stable folder-safe key: readable name plus a hash of the normalized location. */
export function repoId(source: RepoSource): string {
  const key = source.kind === "local" ? `local:${normalizeLocal(source.path)}` : `url:${normalizeUrl(source.url)}`;
  const hash = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return `${slug(displayName(source))}-${hash}`;
}

export async function assertDirectory(path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`Folder not found: ${path}`);
    if (code === "EACCES" || code === "EPERM") throw new Error(`No permission to read: ${path}`);
    throw new Error(`Can't open ${path}: ${(error as Error).message}`);
  }
  if (!info.isDirectory()) throw new Error(`Not a folder: ${path}`);
}

export interface CloneResult {
  path: string;
  action: "cloned" | "pulled" | "pull-failed";
  warning?: string;
}

/** Clone `url` into `<repoDir>/checkout`, or fast-forward an existing clone. */
export async function cloneOrPull(
  url: string,
  repoDir: string,
  signal?: AbortSignal,
  /** Tests only: allow file:// so clones can run against a local fixture. */
  testing?: { allowFileTransport: boolean },
): Promise<CloneResult> {
  const TRANSPORT_ARGS = testing?.allowFileTransport
    ? [...NETWORK_TRANSPORTS, "-c", "protocol.file.allow=always"]
    : NETWORK_TRANSPORTS;
  const checkout = join(repoDir, "checkout");
  const exists = await stat(checkout).then((s) => s.isDirectory(), () => false);
  if (exists && (await isGitWorkTree(checkout, signal))) {
    try {
      await runGit([...TRANSPORT_ARGS, "pull", "--ff-only", "--no-rebase", "--quiet"], { cwd: checkout, signal, timeoutMs: 120_000 });
      return { path: checkout, action: "pulled" };
    } catch (error) {
      if (error instanceof GitError && (error.code === "aborted" || error.code === "missing")) throw error;
      return { path: checkout, action: "pull-failed", warning: `Couldn't update the clone, using the existing copy. ${(error as Error).message}` };
    }
  }
  // Clone into a temp sibling and rename, so a failed clone never looks like a real one.
  await mkdir(repoDir, { recursive: true });
  if (exists) await rm(checkout, { recursive: true, force: true });
  const partial = join(repoDir, `checkout.partial-${randomBytes(4).toString("hex")}`);
  try {
    await runGit(
      [...TRANSPORT_ARGS, "clone", "--filter=blob:none", "--no-recurse-submodules", "--quiet", "--", url, partial],
      { cwd: repoDir, signal, timeoutMs: 300_000 },
    );
    await rename(partial, checkout);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  return { path: checkout, action: "cloned" };
}

const README = /^readme(?:\.(?:md|markdown|rst|txt))?$/i;
const README_READ_LIMIT = 64 * 1024;

/** A short plain-text summary from the README's opening prose, or null. */
export async function readmeSummary(root: string, maxChars = 600): Promise<string | null> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const file = entries.find((e) => e.isFile() && README.test(e.name));
  if (!file) return null;
  const handle = await open(join(root, file.name), "r");
  let text: string;
  try {
    const buffer = Buffer.alloc(README_READ_LIMIT);
    const { bytesRead } = await handle.read(buffer, 0, README_READ_LIMIT, 0);
    text = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
  return summarizeReadme(text, maxChars);
}

export function summarizeReadme(text: string, maxChars = 600): string | null {
  const withoutCode = text.replace(/\r\n/g, "\n").replace(/```[\s\S]*?(```|$)/g, "").replace(/<!--[\s\S]*?-->/g, "");
  let title: string | null = null;
  const paragraphs: string[] = [];
  for (const block of withoutCode.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(lines[0]!);
    if (heading && title === null && paragraphs.length === 0) title = clean(heading[1]!);
    const prose = lines.filter((l) => !/^#{1,6}\s/.test(l) && !/^[=\-]{3,}$/.test(l) && !/^[|>]/.test(l));
    const joined = clean(prose.join(" "));
    // Skip badge rows and other blocks that are only links/images.
    if (joined.length < 20 || !/[a-z]{3,}\s+[a-z]{2,}/i.test(joined)) continue;
    paragraphs.push(joined);
    if (paragraphs.join(" ").length >= maxChars || paragraphs.length >= 2) break;
  }
  const body = paragraphs.join(" ");
  const summary = [title, body].filter(Boolean).join(": ");
  if (!summary) return null;
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1).trimEnd()}…` : summary;
}

function clean(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface Ownership {
  guess: "own" | "other" | "unknown";
  /** Fraction of recent commits authored by the local git user, when known. */
  share: number | null;
}

/** Guess whether the learner wrote this repo: do most recent commits use their git email? */
export async function guessOwnership(root: string, signal?: AbortSignal): Promise<Ownership> {
  if (!(await isGitWorkTree(root, signal))) return { guess: "unknown", share: null };
  let email: string;
  try {
    email = (await runGit(["config", "--get", "user.email"], { cwd: root, signal, timeoutMs: 10_000 })).trim().toLowerCase();
  } catch (error) {
    if (error instanceof GitError && error.code === "failed") return { guess: "unknown", share: null };
    throw error;
  }
  if (!email) return { guess: "unknown", share: null };
  let authors: string[];
  try {
    const out = await runGit(["log", "-n", "500", "--format=%ae"], { cwd: root, signal, timeoutMs: 30_000 });
    authors = out.split(/\r?\n/).map((a) => a.trim().toLowerCase()).filter(Boolean);
  } catch (error) {
    if (error instanceof GitError && error.code === "failed") return { guess: "unknown", share: null };
    throw error;
  }
  if (authors.length === 0) return { guess: "unknown", share: null };
  const share = authors.filter((a) => a === email).length / authors.length;
  return { guess: share >= 0.5 ? "own" : "other", share: Math.round(share * 100) / 100 };
}

const SKIPPED_FOLDERS = new Set(["node_modules", "vendor", "dist", "build", "target", "out", "__pycache__"]);
const MAX_FOLDERS = 15;

/**
 * The repo's top-level folders ("crawler/", ...), for the "which parts did you write?"
 * card. Hidden, dependency and build-output folders are left out.
 */
export async function topLevelFolders(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIPPED_FOLDERS.has(e.name.toLowerCase()))
    .map((e) => `${e.name}/`)
    .sort()
    .slice(0, MAX_FOLDERS);
}
