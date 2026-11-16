// Port of rederive's scripts/history.sh: summarizes a repo's git history and layout so
// the map worker can find its key design decisions, then appends the code structure
// summary (structure.ts). Read-only git only; output is capped so it fits in context
// on repos with tens of thousands of commits.
import { realpath } from "node:fs/promises";
import { GitError, isGitWorkTree, runGit, type GitOptions } from "./git.ts";
import { detectVendored, findBinaryFiles, isBuildOutput, vendoredRoot } from "./filters.ts";
import { byCount, listRepoFiles, summarizeStructure, TEST } from "./structure.ts";

/** Lockfiles, build output and vendored code drown out the real changes. */
export const NOISE =
  /(^|\/)(node_modules|vendor|dist|build|\.next|target|third_party)\/|(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|\.min\.(js|css)|\.map|\.snap|\.svg|\.png|\.jpg|\.lock)$/;
/** Same pattern as history.sh, passed to `git log -i -E --grep`. */
export const DESIGN_GREP =
  "introduc|refactor|rewrit|replac|migrat|switch(ed)? (to|from)|redesign|architect|instead of|move (to|from)|extract|split|remove|drop|deprecat|perf|cache|async|concurren|schema|protocol|v[0-9]+\\.0";
const DESIGN_DOCS =
  /(^|\/)(architecture|design|adr|rfc|decisions?|internals|contributing|hacking)[^/]*(\.md|\.txt|\.rst|\/)|^readme/i;

/** Beyond this many commits, file-level stats use the newest ones only. */
const MAX_FILE_STAT_COMMITS = 20_000;
const DEFAULT_MAX_CHARS = 30_000;
const COMMIT_MARK = "\x01";

export interface SummaryOptions {
  signal?: AbortSignal;
  /** Total output cap in characters. */
  maxChars?: number;
}

/**
 * The full summary for `root`: history sections (when it is a git repo with commits)
 * followed by "# Code structure". Never throws for git problems inside a section;
 * that section reports itself unavailable instead. Cancellation still throws.
 */
export async function summarizeRepo(root: string, options: SummaryOptions = {}): Promise<string> {
  const { signal } = options;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const realRoot = await realpath(root);

  const hasHistory = (await isGitWorkTree(realRoot, signal).catch(rethrowAbort(false))) && (await hasCommits(realRoot, signal));
  if (!hasHistory) {
    const structure = await summarizeStructure(realRoot, { signal });
    return cap(`NOT_A_GIT_REPO: no history to read. Build the map from the code structure below.\n\n${structure}`, maxChars);
  }

  const files = await listRepoFiles(realRoot, signal);
  const history = await summarizeHistory(realRoot, files, signal);
  const structure = await summarizeStructure(realRoot, { signal, files, vendored: history.vendored });
  return cap(`${history.text}\n\n# Code structure\n${structure}`, maxChars);
}

function rethrowAbort<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if (error instanceof GitError && error.code === "aborted") throw error;
    if (error instanceof GitError) return fallback;
    throw error;
  };
}

async function hasCommits(root: string, signal?: AbortSignal): Promise<boolean> {
  return runGit(["rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root, signal, timeoutMs: 10_000 }).then(
    () => true,
    rethrowAbort(false),
  );
}

function cap(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.lastIndexOf("\n", maxChars);
  return `${text.slice(0, cut > maxChars / 2 ? cut : maxChars)}\n[truncated: summary capped at ${maxChars} characters]`;
}

function splitLines(out: string): string[] {
  return out.split(/\r?\n/).filter((l) => l !== "");
}

/** The history sections, in the same order as history.sh. */
async function summarizeHistory(
  root: string,
  files: readonly string[],
  signal?: AbortSignal,
): Promise<{ text: string; vendored: Set<string> }> {
  // runGit never fetches missing blobs, so this stays fast on a --filter=blob:none clone.
  const base: GitOptions = { cwd: root, signal, maxBuffer: 64 * 1024 * 1024, timeoutMs: 60_000 };
  const git = (args: string[]) => runGit(["-c", "core.quotePath=false", ...args], base);

  // When the root is a subfolder of a larger repo, read only that folder's history.
  const prefix = (await git(["rev-parse", "--show-prefix"]).catch(rethrowAbort(""))).trim();
  const scope = prefix ? ["--", "."] : [];
  const relative = prefix ? ["--relative"] : [];

  const binaries = await findBinaryFiles(root, files, signal);
  const out: string[] = [];
  const section = async (title: string, body: () => Promise<string[]>): Promise<void> => {
    out.push("", title);
    try {
      const lines = await body();
      out.push(...(lines.length > 0 ? lines : ["none"]));
    } catch (error) {
      if (error instanceof GitError && error.code !== "aborted") out.push(`(unavailable: ${error.message})`);
      else throw error;
    }
  };

  // One pass over every commit for counts, dates, authors and the first commits. On the
  // largest repos (hundreds of thousands of commits) it passes the output cap: go on without.
  let commits: { sha: string; date: string; author: string; subject: string }[] = [];
  let commitsError: GitError | null = null;
  try {
    commits = splitLines(await git(["log", "--format=%h%x09%ad%x09%aN%x09%s", "--date=short", ...scope])).map((line) => {
      const [sha = "", date = "", author = "", ...subject] = line.split("\t");
      return { sha, date, author, subject: subject.join("\t") };
    });
  } catch (error) {
    if (!(error instanceof GitError) || error.code === "aborted") throw error;
    commitsError = error;
  }
  const head = (await git(["rev-parse", "--short", "HEAD"])).trim();
  const authors = new Set(commits.map((c) => c.author)).size;
  out.push("## Repo");
  out.push(
    commitsError
      ? `commits: unknown (the full commit list couldn't be read: ${commitsError.message}) | HEAD: ${head}`
      : `commits: ${commits.length} | first: ${commits.at(-1)?.date ?? "?"} | last: ${commits[0]?.date ?? "?"} | authors: ${authors} | HEAD: ${head}`,
  );
  if (prefix) out.push(`note: this folder is ${prefix.replace(/\/$/, "")}/ inside a larger repo; history covers this folder only`);
  const shallow = (await git(["rev-parse", "--is-shallow-repository"]).catch(rethrowAbort(""))).trim();
  if (shallow === "true") out.push("WARNING: shallow clone, early history is missing.");

  await section("## First 15 commits", async () => {
    if (commitsError) throw commitsError;
    return commits.slice(-15).reverse().map((c) => `${c.sha} ${c.date} ${c.subject}`);
  });

  await section("## Commits whose message names a design change (newest 40)", async () =>
    splitLines(
      await git(["log", "--format=%h %ad %s", "--date=short", "-i", "-E", `--grep=${DESIGN_GREP}`, "--max-count=40", ...scope]),
    ),
  );

  // Files touched per commit. Counting files needs only the commit trees, so it stays
  // fast on a clone made with --filter=blob:none. Exact-only rename detection compares
  // object ids, not contents, so a moved file still counts once without fetching blobs;
  // if git wants contents anyway, fall back to no rename detection. Loaded up front
  // because deciding which folders are bundled libraries needs it.
  const logArgs = (renames: string) => [
    "log", "--no-merges", renames, `--max-count=${MAX_FILE_STAT_COMMITS}`,
    `--format=${COMMIT_MARK}%h %ad %s`, "--date=short", "--name-only", ...relative, ...scope,
  ];
  let perCommit: [string, string[]][] | null = null;
  let perCommitError: GitError | null = null;
  try {
    const log = await git(logArgs("--find-renames=100%")).catch((error: unknown) => {
      if (error instanceof GitError && error.code === "failed") return git(logArgs("--no-renames"));
      throw error;
    });
    perCommit = [];
    for (const line of splitLines(log)) {
      if (line.startsWith(COMMIT_MARK)) perCommit.push([line.slice(1), []]);
      else perCommit.at(-1)?.[1].push(line);
    }
  } catch (error) {
    if (!(error instanceof GitError) || error.code === "aborted") throw error;
    perCommitError = error;
  }
  const vendored = detectVendored(files, perCommit?.map(([, paths]) => paths));
  const isNoise = (path: string) => NOISE.test(path) || vendoredRoot(path, vendored) !== null;

  let fileStats: { sizes: [string, number][]; changed: Map<string, number> } | null = null;
  const loadFileStats = async () => {
    if (fileStats) return fileStats;
    if (!perCommit) throw perCommitError!;
    // Judging build output needs every path ever seen.
    const known = new Set([...files, ...perCommit.flatMap(([, paths]) => paths)]);
    const skip = (path: string) => isNoise(path) || isBuildOutput(path, known, binaries);
    const sizes: [string, number][] = [];
    const changed = new Map<string, number>();
    for (const [commit, paths] of perCommit) {
      const kept = paths.filter((p) => !skip(p));
      for (const p of kept) changed.set(p, (changed.get(p) ?? 0) + 1);
      sizes.push([commit, kept.filter((p) => !TEST.test(p)).length]);
    }
    fileStats = { sizes, changed };
    return fileStats;
  };
  const statNote = commitsError || commits.length > MAX_FILE_STAT_COMMITS ? [`(from the newest ${MAX_FILE_STAT_COMMITS} commits)`] : [];

  await section("## Largest commits by files touched, ignoring tests and generated files (top 15)", async () => {
    const { sizes } = await loadFileStats();
    // Stable sort keeps newer commits first among ties.
    return [...statNote, ...[...sizes].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, n]) => `${n}\t${c}`)];
  });

  await section("## Most changed files (top 20)", async () => {
    const { changed } = await loadFileStats();
    return [...statNote, ...byCount(changed).slice(0, 20).map(([f, n]) => `${String(n).padStart(4)}  ${f}`)];
  });

  await section("## Design docs present", async () =>
    files.filter((f) => DESIGN_DOCS.test(f) && !vendoredRoot(f, vendored)).slice(0, 20),
  );

  await section("## Top-level layout", async () => {
    const layout = new Map<string, number>();
    const knownNow = new Set(files);
    for (const f of files) {
      if (isNoise(f) || isBuildOutput(f, knownNow, binaries)) continue;
      const slash = f.indexOf("/");
      const key = slash === -1 ? f : `${f.slice(0, slash)}/`;
      layout.set(key, (layout.get(key) ?? 0) + 1);
    }
    return byCount(layout).slice(0, 25).map(([k, n]) => `${String(n).padStart(4)}  ${k}`);
  });

  return { text: out.join("\n"), vendored };
}
