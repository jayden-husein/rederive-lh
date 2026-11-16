// Self-update from GitHub releases. LearnHarness has no updater for community plugins, so
// the plugin checks its own releases/latest, and on the user's click downloads the zip,
// checks it against GitHub's SHA-256 digest, and swaps it in for dist/. The sibling data/
// is never touched. New code loads only after a LearnHarness restart.
import { createHash } from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { RETRYABLE, renameWithRetry } from "./atomic.ts";
import { RELEASES_REPO, type UpdateState } from "./names.ts";
import { readZip } from "./unzip.ts";

/** Release zips are well under 1 MB; anything near this is not ours. */
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
const API_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Retries for moving dist/ in and out: about 20 s in all (see renameWithRetry). */
const SWAP_RETRIES = 10;
/** Staging folders replaceDist creates beside dist/. */
const STAGE_PREFIX = ".update-";
/** Files in dist/ are flat, with plain names (scripts/package.ts refuses folders in dist/). */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Version = [number, number, number];

export function parseVersion(text: string): Version | null {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** True when `candidate` is a higher x.y.z than `base`. Unparseable versions are never newer. */
export function isNewer(candidate: string, base: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(base);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

export interface ReleaseInfo {
  version: string;
  notesUrl: string;
  asset: { url: string; size: number; sha256: string };
}

/** Read GitHub's release JSON. The asset must be `<id>-<version>.zip` with a sha256 digest. */
export function parseRelease(value: unknown, pluginId: string): ReleaseInfo {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const tag = typeof v.tag_name === "string" ? v.tag_name : "";
  const parsed = parseVersion(tag);
  if (!parsed) throw new Error(`The latest release's tag (${tag || "none"}) is not a version.`);
  const version = parsed.join(".");
  const notesUrl = typeof v.html_url === "string" && v.html_url.startsWith("https://github.com/") ? v.html_url : `https://github.com/${RELEASES_REPO}/releases`;
  const name = `${pluginId}-${version}.zip`;
  const assets = Array.isArray(v.assets) ? (v.assets as Record<string, unknown>[]) : [];
  const asset = assets.find((a) => a && a.name === name);
  if (!asset) throw new Error(`Release ${version} has no ${name}.`);
  const url = asset.browser_download_url;
  if (typeof url !== "string" || !url.startsWith("https://github.com/")) throw new Error(`${name} has no download link.`);
  const size = asset.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) throw new Error(`${name} has no size.`);
  const digest = typeof asset.digest === "string" ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null;
  if (!digest) throw new Error(`GitHub lists no SHA-256 for ${name}, so it can't be checked. Download it from the release page.`);
  return { version, notesUrl, asset: { url, size, sha256: digest[1]!.toLowerCase() } };
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const HEADERS = { "User-Agent": "rederive-lh-updater" };

export async function fetchLatestRelease(fetchFn: Fetch, pluginId: string, signal: AbortSignal): Promise<ReleaseInfo> {
  const response = await fetchFn(`https://api.github.com/repos/${RELEASES_REPO}/releases/latest`, {
    headers: { ...HEADERS, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)]),
  });
  if (response.status === 404) throw new Error("No release is published yet.");
  if (response.status === 403 || response.status === 429) throw new Error("GitHub's rate limit was reached. Try again in an hour.");
  if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
  return parseRelease(await response.json(), pluginId);
}

/** Download the release zip and check its size and SHA-256 against GitHub's listing. */
export async function downloadPackage(fetchFn: Fetch, release: ReleaseInfo, signal: AbortSignal): Promise<Buffer> {
  if (release.asset.size > MAX_ZIP_BYTES) throw new Error("The release zip is unexpectedly large.");
  const response = await fetchFn(release.asset.url, {
    headers: { ...HEADERS, Accept: "application/octet-stream" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
  });
  if (!response.ok) throw new Error(`The download failed: GitHub answered ${response.status}.`);
  const zip = Buffer.from(await response.arrayBuffer());
  if (zip.length !== release.asset.size) throw new Error("The download was incomplete.");
  if (createHash("sha256").update(zip).digest("hex") !== release.asset.sha256) {
    throw new Error("The download doesn't match the release's SHA-256.");
  }
  return zip;
}

/** The manifest fields the updater compares. */
export interface PluginIdentity {
  id: string;
  version: string;
  minAppVersion: string;
}

/**
 * Unpack and check a release zip: flat plain file names, a manifest for this plugin at the
 * expected version, and every entry file the manifest names. Plugins can't read the app's
 * version, so a release that raises minAppVersion above the running one's is refused: the
 * user may need a newer LearnHarness, and a plugin that fails to load can't update itself.
 */
export function checkPackage(zip: Buffer, expected: PluginIdentity): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const seen = new Set<string>();
  for (const entry of readZip(zip, { maxTotalBytes: MAX_UNPACKED_BYTES })) {
    if (!FILE_NAME.test(entry.name) || entry.name.toLowerCase() === "data") {
      throw new Error(`The zip holds an unexpected entry: ${entry.name}`);
    }
    // Windows and macOS folders are case-insensitive: two names differing only in case would collide.
    if (seen.has(entry.name.toLowerCase())) throw new Error(`The zip holds ${entry.name} twice.`);
    seen.add(entry.name.toLowerCase());
    files.set(entry.name, entry.data);
  }
  const manifestFile = files.get("manifest.json");
  if (!manifestFile) throw new Error("The zip has no manifest.json.");
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestFile.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("The zip's manifest.json is not valid JSON.");
  }
  if (manifest.id !== expected.id) throw new Error(`The zip is for another plugin (${String(manifest.id)}).`);
  if (manifest.version !== expected.version) throw new Error(`The zip holds version ${String(manifest.version)}, not ${expected.version}.`);
  if (manifest.apiVersion !== 1) throw new Error("The zip needs a newer plugin API than this LearnHarness has.");
  const needs = typeof manifest.minAppVersion === "string" ? manifest.minAppVersion : "";
  if (!parseVersion(needs)) throw new Error("The zip's manifest has no valid minAppVersion.");
  if (isNewer(needs, expected.minAppVersion)) {
    throw new Error(
      `Rederive ${expected.version} needs LearnHarness ${needs} or later. ` +
        "Update LearnHarness first, then install this release by hand from the release page.",
    );
  }
  for (const key of ["main", "backend", "styles"]) {
    const file = manifest[key];
    if (file === undefined) continue;
    if (typeof file !== "string" || !files.has(file)) throw new Error(`The zip's manifest names ${String(file)}, which the zip lacks.`);
  }
  return files;
}

/**
 * Remove staging folders a crashed or failed update left beside dist/. Safe at startup:
 * the plugin is running from dist/, so none of them holds the only copy of the code.
 */
export async function removeLeftoverStages(directory: string): Promise<void> {
  if (basename(directory) !== "dist") return;
  const parent = dirname(directory);
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(STAGE_PREFIX)) {
      await rm(join(parent, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/** A git checkout next to dist/ builds dist/ itself, so the updater must leave it alone. */
export function installKind(directory: string): UpdateState["install"] {
  return existsSync(join(dirname(directory), ".git")) ? "source" : "release";
}

/**
 * Replace `directory` (the installed dist/) with `files`. Stages the new files beside it,
 * moves the old dist/ aside, moves the new one in, and puts the old one back if that fails.
 * Old files are removed rather than merged. The sibling data/ is never touched.
 * `rename` is a parameter so tests can fail a move.
 */
export async function replaceDist(directory: string, files: Map<string, Buffer>, rename: typeof renameWithRetry = renameWithRetry): Promise<void> {
  if (basename(directory) !== "dist") throw new Error(`Refusing to replace ${directory}: not a dist directory.`);
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Refusing to replace ${directory}: not a plain directory.`);
  if (lstatSync(join(directory, "data"), { throwIfNoEntry: false })) {
    throw new Error(`Refusing to replace ${directory}: it holds a data folder, which belongs beside it.`);
  }
  // Beside dist/, so the final moves are renames within one folder (same drive, atomic).
  const stage = await mkdtemp(join(dirname(directory), STAGE_PREFIX));
  const next = join(stage, "next");
  const previous = join(stage, "previous");
  let movedOld = false;
  let installed = false;
  let keepStage = false;
  try {
    await mkdir(next);
    for (const [name, data] of files) await writeFile(join(next, name), data);
    // Antivirus and the search indexer often hold freshly written files for seconds.
    await rename(directory, previous, SWAP_RETRIES);
    movedOld = true;
    await rename(next, directory, SWAP_RETRIES);
    installed = true;
  } catch (error) {
    if (movedOld && !installed) {
      try {
        await rename(previous, directory, SWAP_RETRIES);
      } catch {
        keepStage = true;
        throw new Error(`The update failed and the old version couldn't be put back. It is kept at ${previous}.`, { cause: error });
      }
    }
    throw error;
  } finally {
    // The running backend and open windows already loaded the old code, so deleting it is safe.
    if (!keepStage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Turn fetch and file-system failures into a sentence for the settings page. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "GitHub took too long to answer.";
    if (error.name === "TypeError" && error.message === "fetch failed") return "Couldn't reach GitHub. Check the internet connection.";
    if (RETRYABLE.has((error as NodeJS.ErrnoException).code ?? "")) {
      return (
        "Couldn't replace the plugin's files: another program (often antivirus) is holding them. " +
        "Try again in a minute, or close LearnHarness and replace dist/ with the release zip by hand."
      );
    }
    return error.message;
  }
  return String(error);
}

export interface UpdaterDeps {
  /** The running plugin's manifest. */
  manifest: PluginIdentity;
  /** The installed dist/ (ctx.directory). */
  directory: string;
  fetch: Fetch;
  signal: AbortSignal;
  /** Called with a copy of the state after every change. */
  onChange(state: UpdateState): void;
  now?: () => Date;
}

export class Updater {
  private readonly deps: UpdaterDeps;
  private snapshot: UpdateState;
  private release: ReleaseInfo | null = null;

  constructor(deps: UpdaterDeps) {
    this.deps = deps;
    this.snapshot = {
      current: deps.manifest.version,
      install: installKind(deps.directory),
      checking: false,
      installing: false,
      available: null,
      installed: null,
      checkedAt: null,
      error: null,
    };
  }

  state(): UpdateState {
    return { ...this.snapshot, available: this.snapshot.available && { ...this.snapshot.available } };
  }

  private set(patch: Partial<UpdateState>): void {
    if (this.deps.signal.aborted) return;
    this.snapshot = { ...this.snapshot, ...patch };
    this.deps.onChange(this.state());
  }

  /**
   * Run one check or install: nothing else may be running, `flag` is set while it runs,
   * and `body`'s patch (or its failure, as `error`) is applied when it ends.
   */
  private async exclusive(
    flag: "checking" | "installing",
    body: () => Promise<Partial<UpdateState>>,
    onError: (message: string) => Partial<UpdateState>,
  ): Promise<UpdateState> {
    if (this.snapshot.checking || this.snapshot.installing) return this.state();
    this.set({ [flag]: true, error: null });
    let patch: Partial<UpdateState>;
    try {
      patch = await body();
    } catch (error) {
      patch = onError(describeError(error));
    }
    this.set({ ...patch, [flag]: false });
    return this.state();
  }

  /** Ask GitHub for the latest release. A check already running or an install in progress wins. */
  check(): Promise<UpdateState> {
    const checkedAt = () => (this.deps.now?.() ?? new Date()).toISOString();
    return this.exclusive(
      "checking",
      async () => {
        const release = await fetchLatestRelease(this.deps.fetch, this.deps.manifest.id, this.deps.signal);
        this.release = release;
        // After an install, compare with what is on disk, not with what is still running.
        const base = this.snapshot.installed ?? this.deps.manifest.version;
        const available = isNewer(release.version, base) ? { version: release.version, notesUrl: release.notesUrl } : null;
        return { available, checkedAt: checkedAt() };
      },
      (message) => ({ error: message, checkedAt: checkedAt() }),
    );
  }

  /** Download, check and install the release the last check found. */
  async install(): Promise<UpdateState> {
    if (this.snapshot.install === "source") {
      throw new Error("This copy is a git checkout. Update it with git pull and npm run build.");
    }
    const release = this.release;
    const waiting = this.snapshot.available;
    if (!release || !waiting || waiting.version !== release.version) {
      throw new Error("No update is waiting. Check for updates first.");
    }
    return this.exclusive(
      "installing",
      async () => {
        const zip = await downloadPackage(this.deps.fetch, release, this.deps.signal);
        const files = checkPackage(zip, { ...this.deps.manifest, version: release.version });
        if (this.deps.signal.aborted) throw new Error("The plugin was disabled during the update.");
        await replaceDist(this.deps.directory, files);
        return { installed: release.version, available: null };
      },
      (message) => ({ error: `Couldn't update: ${message}` }),
    );
  }
}
