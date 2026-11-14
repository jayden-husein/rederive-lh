// Port of rederive's scripts/structure.py, plus C/C++ (`#include`) support.
// Summarizes a repo's code structure: entry points, the internal import graph (most
// imported files, files that import the most, edges among the central files) and the
// external packages used most. Reads files only through `resolveInsideRoot`, never
// follows links out of the repo, and never runs anything from it.
import { lstat, open, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { GitError, runGit } from "./git.ts";
import { detectVendored, vendoredRoot } from "./filters.ts";
import { resolveInsideRoot } from "./paths.ts";

const C_EXT = [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"];
const JS_EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];
const SOURCE_EXT = new Set([...JS_EXT, ".py", ".go", ".rs", ...C_EXT]);

const NOISE =
  /(^|\/)(node_modules|vendor|dist|build|\.next|target|third_party|__pycache__|\.venv|venv)\/|\.min\.js$|\.d\.ts$/;
const ENTRY_NAMES =
  /(^|\/)(main|index|app|server|cli|__main__|manage|background|content|popup|worker)\.[a-z]+$/;
/** Tests import everything, so they would crowd out the real structure. */
export const TEST =
  /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|[._](test|spec)\.[a-z]+$|_test\.(go|py|c|cc|cpp)$/;
const BUILD_FILES = /(^|\/)(Makefile|makefile|GNUmakefile|CMakeLists\.txt|meson\.build|Cargo\.toml|go\.mod|pyproject\.toml|setup\.py)$/;

const JS_IMPORT =
  /(?:import\s[^'"]*?from\s*|import\s*\(?\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
const PY_FROM = /^\s*from\s+(\.*[\w.]*)\s+import\s+([\w*, ()]+)/gm;
const PY_IMPORT = /^\s*import\s+([\w., ]+)/gm;
const GO_IMPORT_BLOCK = /import\s*\(([^)]*)\)/g;
const GO_IMPORT_ONE = /import\s+(?:\w+\s+)?"([^"]+)"/g;
const RS_MOD = /^\s*(?:pub\s+)?mod\s+(\w+)\s*;/gm;
const RS_USE = /^\s*(?:pub\s+)?use\s+(crate|super|self)::(\w+)/gm;
const RS_EXT = /^\s*(?:pub\s+)?use\s+(\w+)::/gm;
const C_INCLUDE = /^[ \t]*#[ \t]*include[ \t]*([<"])([^>"\n]+)[>"]/gm;
const HAS_MAIN = /\bint\s+main\s*\(|^\s*func\s+main\s*\(\s*\)|^\s*fn\s+main\s*\(/m;

const READ_LIMIT = 400_000;
const MAX_SOURCES_READ = 5_000;
const READ_CONCURRENCY = 16;

export interface StructureOptions {
  signal?: AbortSignal;
  /** Repo-relative paths from `git ls-files`, when the caller already has them. */
  files?: readonly string[];
  /** Bundled library folders, when the caller decided them from history. */
  vendored?: ReadonlySet<string>;
}

/** Every file in the repo, repo-relative with `/` separators. Uses git when it can. */
export async function listRepoFiles(root: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const out = await runGit(["-c", "core.quotePath=false", "ls-files"], { cwd: root, signal, maxBuffer: 64 * 1024 * 1024 });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    // Not a repo, git missing or too slow: fall back to walking the folder.
    if (!(error instanceof GitError) || error.code === "aborted") throw error;
  }
  return walk(root, signal);
}

/** Directory walk for non-git folders. Skips dot folders and every link/junction. */
async function walk(root: string, signal?: AbortSignal, limit = 50_000): Promise<string[]> {
  const out: string[] = [];
  const queue = [""];
  while (queue.length > 0 && out.length < limit) {
    signal?.throwIfAborted();
    const rel = queue.shift()!;
    const entries = await readdir(join(root, rel), { withFileTypes: true }).catch(() => []);
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".")) queue.push(child);
      } else if (entry.isFile()) {
        out.push(child);
      }
    }
  }
  return out.sort();
}

/** Reads up to READ_LIMIT bytes of a regular file inside the root; "" on any problem. */
async function readCapped(root: string, rel: string): Promise<string> {
  try {
    const real = await resolveInsideRoot(root, rel);
    if (!(await lstat(real)).isFile()) return "";
    const handle = await open(real, "r");
    try {
      const buffer = Buffer.alloc(READ_LIMIT);
      const { bytesRead } = await handle.read(buffer, 0, READ_LIMIT, 0);
      return buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return "";
  }
}

function ext(path: string): string {
  return posix.extname(path);
}

function countLines(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

function norm(path: string): string {
  return posix.normalize(path);
}

/** Highest count first, then path, so output is stable. */
function byCount<T extends string>(entries: Iterable<[T, number]>): [T, number][] {
  return [...entries].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function bump(counter: Map<string, number>, key: string): void {
  counter.set(key, (counter.get(key) ?? 0) + 1);
}

export interface StructureData {
  files: string[];
  sources: string[];
  edges: Map<string, Set<string>>;
  external: Map<string, number>;
  lines: Map<string, number>;
  texts: Map<string, string>;
  /** Bundled third-party folders ("libcs50/") and how many files each holds. */
  vendored: Map<string, number>;
}

/** Builds the internal import graph. Exported for tests. */
export async function analyzeStructure(root: string, options: StructureOptions = {}): Promise<StructureData> {
  const { signal } = options;
  const all = options.files ? [...options.files] : await listRepoFiles(root, signal);
  const files = all.filter((f) => !NOISE.test(f));
  const fileset = new Set(files);
  // Bundled libraries stay in `fileset` so imports into them still resolve.
  const roots = options.vendored ?? detectVendored(files);
  const vendored = new Map<string, number>();
  for (const f of files) {
    const vendor = vendoredRoot(f, roots);
    if (vendor) bump(vendored, vendor);
  }
  const sources = files.filter((f) => SOURCE_EXT.has(ext(f)) && !vendoredRoot(f, roots));

  // Read sources (and package.json / go.mod) with a small concurrency pool.
  const texts = new Map<string, string>();
  const toRead = sources.slice(0, MAX_SOURCES_READ);
  for (const extra of ["package.json", "go.mod"]) if (fileset.has(extra)) toRead.push(extra);
  let next = 0;
  await Promise.all(
    Array.from({ length: READ_CONCURRENCY }, async () => {
      while (next < toRead.length) {
        signal?.throwIfAborted();
        const path = toRead[next++]!;
        texts.set(path, await readCapped(root, path));
      }
    }),
  );
  const read = (path: string): string => texts.get(path) ?? "";

  const goModule = /^module\s+(\S+)/m.exec(read("go.mod"))?.[1] ?? "";

  // Index for C includes that name a header by a path relative to some include dir.
  const bySuffix = new Map<string, string[]>();
  for (const f of files) {
    if (!C_EXT.includes(ext(f))) continue;
    const name = posix.basename(f);
    bySuffix.set(name, [...(bySuffix.get(name) ?? []), f]);
  }

  const resolveJs = (src: string, spec: string): string | null => {
    if (!spec.startsWith(".")) return null;
    const base = norm(posix.join(posix.dirname(src), spec));
    const candidates = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => `${base}/index${e}`)];
    return candidates.find((c) => fileset.has(c)) ?? null;
  };

  const resolvePy = (src: string, module: string, names: string): string[] => {
    let base: string;
    if (module.startsWith(".")) {
      const dots = module.length - module.replace(/^\.+/, "").length;
      let pkg = posix.dirname(src);
      for (let i = 0; i < dots - 1; i++) pkg = posix.dirname(pkg);
      const rest = module.replace(/^\.+/, "");
      base = rest ? posix.join(pkg, ...rest.split(".")) : pkg;
    } else {
      base = posix.join(...module.split("."));
    }
    let tries = [`${base}.py`, `${base}/__init__.py`];
    const nameList = names
      .split(",")
      .map((n) => n.replace(/^[ ()]+|[ ()]+$/g, "").split(" as ")[0]!.trim())
      .filter((n) => n !== "" && n !== "*");
    tries.push(...nameList.map((n) => `${posix.join(base, n)}.py`));
    // Projects often keep packages under src/.
    tries = [...tries, ...tries.map((t) => `src/${t}`)];
    const hits = [...new Set(tries.map(norm).filter((t) => fileset.has(t)))];
    // "from pkg import mod" points at mod, not at the package's __init__.
    const specific = hits.filter((h) => !h.endsWith("__init__.py"));
    return specific.length > 0 ? specific : hits;
  };

  const resolveC = (src: string, spec: string): string | null => {
    const here = posix.dirname(src);
    const tries = [posix.join(here, spec), spec, `include/${spec}`, `src/${spec}`, `inc/${spec}`, `lib/${spec}`].map(norm);
    const direct = tries.find((t) => fileset.has(t));
    if (direct) return direct;
    // Fall back to the one header whose path ends with the include spec.
    const matches = (bySuffix.get(posix.basename(spec)) ?? []).filter((f) => f === spec || f.endsWith(`/${spec}`));
    return matches.length === 1 ? matches[0]! : null;
  };

  const goPkgFiles = (dir: string): string[] =>
    sources.filter((f) => (posix.dirname(f) === dir || (dir === "" && posix.dirname(f) === ".")) && f.endsWith(".go") && !f.endsWith("_test.go"));

  const edges = new Map<string, Set<string>>();
  const external = new Map<string, number>();
  const addEdge = (src: string, target: string): void => {
    // An import into a bundled library is a dependency, not part of the design.
    const vendor = vendoredRoot(target, roots);
    if (vendor) return bump(external, vendor);
    let set = edges.get(src);
    if (!set) edges.set(src, (set = new Set()));
    set.add(target);
  };

  for (const src of sources) {
    const text = read(src);
    if (!text) continue;
    const e = ext(src);
    if (JS_EXT.includes(e)) {
      for (const [, spec] of text.matchAll(JS_IMPORT)) {
        const target = resolveJs(src, spec!);
        if (target) addEdge(src, target);
        else if (!spec!.startsWith(".")) {
          const parts = spec!.split("/");
          bump(external, spec!.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!);
        }
      }
    } else if (e === ".py") {
      for (const [, module, names] of text.matchAll(PY_FROM)) {
        const hits = resolvePy(src, module!, names!);
        for (const h of hits) addEdge(src, h);
        if (hits.length === 0 && !module!.startsWith(".")) bump(external, module!.split(".")[0]!);
      }
      for (const [, group] of text.matchAll(PY_IMPORT)) {
        for (const raw of group!.split(",")) {
          const module = raw.trim().split(" ")[0]!;
          if (!module) continue;
          const hits = resolvePy(src, module, "");
          for (const h of hits) addEdge(src, h);
          if (hits.length === 0) bump(external, module.split(".")[0]!);
        }
      }
    } else if (e === ".go") {
      const specs = [...text.matchAll(GO_IMPORT_ONE)].map((m) => m[1]!);
      for (const [, block] of text.matchAll(GO_IMPORT_BLOCK)) {
        specs.push(...[...block!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!));
      }
      for (const spec of specs) {
        if (goModule && spec.startsWith(`${goModule}/`)) {
          for (const t of goPkgFiles(spec.slice(goModule.length + 1))) addEdge(src, t);
        } else if (goModule && spec === goModule) {
          for (const t of goPkgFiles("")) addEdge(src, t);
        } else {
          bump(external, spec);
        }
      }
    } else if (e === ".rs") {
      const here = posix.dirname(src);
      for (const [, name] of text.matchAll(RS_MOD)) {
        for (const c of [posix.join(here, `${name}.rs`), posix.join(here, name!, "mod.rs")].map(norm)) {
          if (fileset.has(c)) addEdge(src, c);
        }
      }
      for (const [, , name] of text.matchAll(RS_USE)) {
        for (const c of [posix.join(here, `${name}.rs`), `src/${name}.rs`, `src/${name}/mod.rs`].map(norm)) {
          if (fileset.has(c)) addEdge(src, c);
        }
      }
      for (const [, crate] of text.matchAll(RS_EXT)) {
        if (!["crate", "super", "self", "std", "core", "alloc"].includes(crate!)) bump(external, crate!);
      }
    } else if (C_EXT.includes(e)) {
      for (const [, kind, spec] of text.matchAll(C_INCLUDE)) {
        const target = resolveC(src, spec!.trim());
        if (target) addEdge(src, target);
        else bump(external, kind === "<" ? `<${spec!.trim()}>` : spec!.trim());
      }
    }
  }

  for (const [src, targets] of [...edges]) {
    targets.delete(src);
    if (TEST.test(src)) edges.delete(src);
  }

  const lines = new Map<string, number>();
  for (const [path, text] of texts) lines.set(path, countLines(text));
  return { files, sources, edges, external, lines, texts, vendored };
}

/** The structure summary, in the same sections and order as structure.py. */
export async function summarizeStructure(root: string, options: StructureOptions = {}): Promise<string> {
  const data = await analyzeStructure(root, options);
  return formatStructure(data);
}

export function formatStructure(data: StructureData): string {
  const { files, sources, edges, external, texts } = data;
  const lines = (f: string): number => data.lines.get(f) ?? 0;
  const indegree = new Map<string, number>();
  for (const targets of edges.values()) for (const t of targets) bump(indegree, t);
  const out: string[] = [];

  const edgeCount = [...edges.values()].reduce((n, t) => n + t.size, 0);
  const tests = sources.filter((f) => TEST.test(f)).length;
  out.push("## Code size");
  out.push(`source files: ${sources.length} (${tests} tests, left out of the graph) | internal import edges: ${edgeCount}`);
  const byExt = new Map<string, number>();
  for (const f of sources) bump(byExt, ext(f));
  out.push(`by type: ${byCount(byExt).slice(0, 6).map(([e, n]) => `${e} ${n}`).join(", ") || "none"}`);
  if (sources.length > MAX_SOURCES_READ) {
    out.push(`note: only the first ${MAX_SOURCES_READ} source files were read for imports`);
  }
  if (data.vendored.size > 0) {
    const list = byCount(data.vendored).map(([dir, n]) => `${dir} (${n} files)`).join(", ");
    out.push(`bundled libraries, left out of every section and listed under external packages: ${list}`);
  }

  out.push("", "## Entry points");
  const entries: string[] = [];
  const pkgText = texts.get("package.json");
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as Record<string, unknown>;
      for (const key of ["main", "module", "bin"]) {
        const val = pkg[key];
        if (typeof val === "string") entries.push(`package.json ${key}: ${val}`);
        else if (val && typeof val === "object") {
          for (const [k, v] of Object.entries(val)) entries.push(`package.json bin ${k}: ${String(v)}`);
        }
      }
      const scripts = pkg.scripts;
      if (scripts && typeof scripts === "object") {
        for (const [k, v] of Object.entries(scripts).slice(0, 6)) entries.push(`package.json script ${k}: ${String(v).slice(0, 100)}`);
      }
    } catch {
      // Not valid JSON; skip.
    }
  }
  const vendoredDirs = new Set(data.vendored.keys());
  for (const f of files) {
    if (vendoredRoot(f, vendoredDirs)) continue;
    if (f.endsWith("manifest.json") && depth(f) <= 2) entries.push(`extension or app manifest: ${f}`);
    if (BUILD_FILES.test(f) && depth(f) <= 1) entries.push(`build file: ${f}`);
  }
  for (const f of sources) {
    if (depth(f) > 3) continue;
    // Names like index.* or app.* mark entry points in JS/Python, not in C; there only
    // a main() counts, and a header never does.
    const isC = C_EXT.includes(ext(f));
    if (isC && /\.h[hpx]*$/.test(f)) continue;
    const named = !isC && ENTRY_NAMES.test(f);
    const text = texts.get(f) ?? "";
    const runnable = text.slice(-3000).includes("if __name__") || HAS_MAIN.test(text);
    if ((named || runnable) && ((indegree.get(f) ?? 0) === 0 || named)) {
      entries.push(`${f} (${lines(f)} lines, imported by ${indegree.get(f) ?? 0})`);
    }
  }
  if (entries.length === 0) out.push("none found by name; start from the files that import the most");
  else out.push(...entries.slice(0, 20));

  const mostImported = byCount(indegree).slice(0, 15);
  out.push("", "## Most imported internal files (top 15): the shared core");
  for (const [f, n] of mostImported) out.push(`${String(n).padStart(3)}  ${f} (${lines(f)} lines)`);

  const orchestrators = byCount([...edges].map(([f, t]) => [f, t.size] as [string, number])).filter(([, n]) => n > 0);
  out.push("", "## Files that import the most internal files (top 10): the orchestrators");
  for (const [f, n] of orchestrators.slice(0, 10)) out.push(`${String(n).padStart(3)}  ${f} (${lines(f)} lines)`);

  out.push("", "## Largest source files (top 10)");
  for (const [f, n] of byCount(sources.map((f) => [f, lines(f)] as [string, number])).slice(0, 10)) {
    out.push(`${String(n).padStart(5)}  ${f}`);
  }

  const central = new Set([...mostImported.slice(0, 12).map(([f]) => f), ...orchestrators.slice(0, 6).map(([f]) => f)]);
  out.push("", "## Edges among the central files (who imports whom)");
  let shown = 0;
  for (const src of [...central].sort()) {
    const targets = [...(edges.get(src) ?? [])].filter((t) => central.has(t)).sort();
    if (targets.length > 0 && shown < 25) {
      out.push(`${src} -> ${targets.join(", ")}`);
      shown++;
    }
  }

  out.push("", "## External packages used most (top 15)");
  out.push(byCount(external).slice(0, 15).map(([p, n]) => `${p} (${n})`).join(", ") || "none found");
  return out.join("\n");
}

function depth(path: string): number {
  return path.split("/").length - 1;
}
