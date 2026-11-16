// File filters that go beyond rederive's originals: bundled third-party libraries and
// committed build output. Both would otherwise crowd the learner's own design out of
// the summary (a course library dominating "most imported", binaries dominating
// "most changed").
import { posix } from "node:path";
import { readHead, resolveInsideRoot } from "./paths.ts";

/** Folder names that always mean someone else's code. */
const VENDOR_DIR = /(^|\/)(external|extern|3rdparty|third[-_]party)\//i;
/**
 * `lib<name>/` (libcs50, libuv) is only a hint: a project's own `libparser/` looks the
 * same. Plain `lib/`, `libs/`, `library/` and `libraries/` never count.
 */
const LIB_DIR = /(^|\/)(?!(?:libs?|library|libraries)\/)lib[a-z0-9][\w.-]*\//i;
/** Files a dropped-in library ships with and a project's own module rarely does. */
const LIBRARY_MARKER = /^(licen[cs]e|copying|notice)(\.[a-z]+)?$|\.(a|so|dylib|lib|dll)$/i;

/** Below this many commits there is too little history to call a folder untouched. */
const MIN_COMMITS_FOR_EVIDENCE = 10;

function rootOf(path: string, match: RegExpExecArray): string {
  return path.slice(0, match.index + match[0].length).replace(/^\//, "");
}

/**
 * Decides which folders hold bundled third-party code. `external/`-style names always
 * do. A `lib<name>/` folder does only with evidence: it ships a license or a prebuilt
 * library, or the history shows it was dropped in and left alone (touched by at most
 * max(2, 5%) of the commits). Without evidence it stays in: hiding the learner's own
 * code from the map is worse than showing a library.
 *
 * `commits` lists the paths each commit touched, newest first, when history is known.
 */
export function detectVendored(files: readonly string[], commits?: readonly (readonly string[])[]): Set<string> {
  const roots = new Set<string>();
  const libCandidates = new Map<string, string[]>();
  for (const f of files) {
    const strong = VENDOR_DIR.exec(f);
    if (strong) {
      roots.add(rootOf(f, strong));
      continue;
    }
    const lib = LIB_DIR.exec(f);
    if (lib) {
      const root = rootOf(f, lib);
      libCandidates.set(root, [...(libCandidates.get(root) ?? []), f]);
    }
  }
  for (const [root, inside] of libCandidates) {
    if (inside.some((f) => LIBRARY_MARKER.test(f.slice(root.length)))) {
      roots.add(root);
      continue;
    }
    if (!commits || commits.length < MIN_COMMITS_FOR_EVIDENCE) continue;
    const touching = commits.filter((paths) => paths.some((p) => p.startsWith(root))).length;
    if (touching <= Math.max(2, Math.floor(commits.length * 0.05))) roots.add(root);
  }
  return roots;
}

/** The bundled folder (from `detectVendored`) a path lives in, e.g. "libcs50/", or null. */
export function vendoredRoot(path: string, roots: ReadonlySet<string>): string | null {
  for (const root of roots) if (path.startsWith(root)) return root;
  return null;
}

/** Compiled objects, executables, core dumps and program output files. */
export const BUILD_OUTPUT =
  /\.(o|obj|a|so|dylib|dll|exe|lib|out|class|pyc|pyo|elf|bin)$|(^|\/)(core(\.\d+)?|a\.out|vgcore\.\d+)$/i;

const COMPILED_SOURCE_EXT = [".c", ".cc", ".cpp", ".cxx", ".go", ".rs"];

/**
 * Build output, judged from the path alone (so it also works for files deleted long
 * ago): known output extensions, files sniffed as binary, and extensionless files named
 * after their folder (`crawler/crawler`) or sitting beside a source of the same name
 * (`indexer/indextest` next to `indexer/indextest.c`). `knownPaths` is every path the
 * history or checkout mentions.
 */
export function isBuildOutput(path: string, knownPaths: ReadonlySet<string>, binaries: ReadonlySet<string>): boolean {
  if (BUILD_OUTPUT.test(path) || binaries.has(path)) return true;
  if (posix.extname(path) !== "") return false;
  const name = posix.basename(path);
  if (name.startsWith(".")) return false;
  const dir = posix.dirname(path);
  if (dir !== "." && posix.basename(dir) === name) return true;
  return COMPILED_SOURCE_EXT.some((e) => knownPaths.has(path + e));
}

const SNIFF_BYTES = 8 * 1024;
const MAX_SNIFFED = 500;

/**
 * Tracked files without an extension whose first bytes contain a NUL: committed
 * executables like `crawler/crawler`. Only files still in the checkout can be checked.
 */
export async function findBinaryFiles(root: string, files: readonly string[], signal?: AbortSignal): Promise<Set<string>> {
  const candidates = files.filter((f) => posix.extname(f) === "" && !posix.basename(f).startsWith(".")).slice(0, MAX_SNIFFED);
  const binaries = new Set<string>();
  for (const rel of candidates) {
    signal?.throwIfAborted();
    try {
      if ((await readHead(await resolveInsideRoot(root, rel), SNIFF_BYTES)).includes(0)) binaries.add(rel);
    } catch {
      // Missing, unreadable or outside the root: not something we can call binary.
    }
  }
  return binaries;
}
