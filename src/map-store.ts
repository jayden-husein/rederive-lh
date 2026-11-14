// Where maps and logs live: <dataDirectory>/repos/<repoId>/{map.json,map.md,log.md}.
//
// The worker's result is the source of truth. A background tool's `format` must be
// side-effect free, so it can't write map.json. Instead, whenever a tool needs the map,
// `current()` adopts the newest succeeded build-map task for the repo (task records
// survive restarts) and writes map.json from it once.
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PluginTaskSnapshot } from "learnharness-plugin-api";
import { writeFileAtomic } from "./atomic.ts";
import { planProblems, tagDecision, type PartTag } from "./authorship.ts";
import { carryOverLog, formatLogEntry, formatSkipEntry, nextProblem as nextProblemIn, parseLog, readLog, type LogEntry, type LogProgress } from "./log.ts";
import { renderMapMarkdown, validateMapResult, type Decision, type DecisionMapResult, type StoredMap } from "./map.ts";

export const BUILD_MAP_WORKER = "build-map";

/** What `rederive_build_map` hands the worker. Immutable once the task is accepted. */
export interface BuildMapInput {
  repoId: string;
  repoName: string;
  repoPath: string;
  builtFrom: string | null;
  /** Carry matching log entries over to the new map instead of starting an empty log. */
  keepProgress?: boolean;
}

export type TaskLister = () => PluginTaskSnapshot[];

export function repoDataDir(dataDirectory: string, id: string): string {
  return join(dataDirectory, "repos", id);
}

function isBuildFor(task: PluginTaskSnapshot, repoId: string): boolean {
  const input = task.input as Partial<BuildMapInput> | null;
  return task.definitionId === BUILD_MAP_WORKER && input?.repoId === repoId;
}

/** A build-map task for this repo that hasn't finished yet, if any. */
export function pendingBuild(list: TaskLister, repoId: string): PluginTaskSnapshot | null {
  return list().find((t) => isBuildFor(t, repoId) && (t.status === "queued" || t.status === "running")) ?? null;
}

function finishedAt(task: PluginTaskSnapshot): string {
  return task.completedAt ?? task.updatedAt;
}

function hasValidResult(task: PluginTaskSnapshot): task is PluginTaskSnapshot & { result: DecisionMapResult } {
  try {
    validateMapResult(task.result);
    return true;
  } catch {
    return false;
  }
}

/** Newest succeeded build for the repo whose result is a valid map. */
function latestValidBuild(list: TaskLister, repoId: string): (PluginTaskSnapshot & { result: DecisionMapResult }) | null {
  let best: (PluginTaskSnapshot & { result: DecisionMapResult }) | null = null;
  for (const t of list()) {
    if (!isBuildFor(t, repoId) || t.status !== "succeeded" || !hasValidResult(t)) continue;
    if (!best || finishedAt(t) > finishedAt(best)) best = t;
  }
  return best;
}

export interface NextProblem {
  decision: Decision;
  /** True when the learner skipped this one earlier and it is coming back. */
  revisit: boolean;
  /** Whose code it is about; null when the chat recorded no authorship. */
  tag: PartTag | null;
}

/** Which parts of the repo the learner wrote (repo-relative), or null when not recorded. */
export type Parts = readonly string[] | null;

export type LogResult = { decision: Decision; next: NextProblem | null; file: string; map: StoredMap };

function pickNext(map: StoredMap, progress: LogProgress, parts: Parts): NextProblem | null {
  const plan = planProblems(map.decisions, parts);
  const picked = nextProblemIn(plan.map((p) => ({ ...p, id: p.decision.id })), progress);
  if (!picked) return null;
  return {
    decision: picked.decision,
    revisit: progress.skipped.includes(picked.id),
    tag: picked.tag,
  };
}

export class MapStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dataDirectory: string;
  private readonly listTasks: TaskLister;
  private readonly now: () => Date;

  constructor(dataDirectory: string, listTasks: TaskLister, now: () => Date = () => new Date()) {
    this.dataDirectory = dataDirectory;
    this.listTasks = listTasks;
    this.now = now;
  }

  mapFile(repoId: string): string {
    return join(repoDataDir(this.dataDirectory, repoId), "map.json");
  }

  logFile(repoId: string): string {
    return join(repoDataDir(this.dataDirectory, repoId), "log.md");
  }

  /** One queue for adoption and log writes, so a log entry never lands in a newer map's log. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async readStored(repoId: string): Promise<StoredMap | null> {
    let text: string;
    try {
      text = await readFile(this.mapFile(repoId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    try {
      const parsed = JSON.parse(text) as StoredMap;
      validateMapResult(parsed);
      return parsed.version === 1 ? parsed : null;
    } catch {
      return null; // Unreadable: treat as missing so a finished task can replace it.
    }
  }

  /** True when a map exists or a valid finished build is waiting to be adopted. Read-only. */
  async hasMap(repoId: string): Promise<boolean> {
    return latestValidBuild(this.listTasks, repoId) !== null || (await this.readStored(repoId)) !== null;
  }

  /** The repo's current map, adopting a newer finished build first. Null if none exists. */
  current(repoId: string): Promise<StoredMap | null> {
    return this.serialize(() => this.adopt(repoId));
  }

  /** Which problems the log marks finished or skipped. Read-only. */
  async progress(repoId: string): Promise<LogProgress> {
    return parseLog(await readLog(this.logFile(repoId)));
  }

  /**
   * Untouched problems first, then skipped ones; null once all are done. Map order, or with
   * `parts` the learner's own problems first (see planProblems).
   */
  async nextProblem(repoId: string, map: StoredMap, parts: Parts = null): Promise<NextProblem | null> {
    return pickNext(map, await this.progress(repoId), parts);
  }

  /**
   * Append a finished (`entry`) or skipped (`"skipped"`) problem to log.md, rewritten
   * atomically. Looks the map up under the same lock as adoption, so the entry always
   * matches the map it was run from. A skipped problem can be skipped again or finished.
   */
  logProblem(repoId: string, id: string, entry: LogEntry | "skipped", signal?: AbortSignal, parts: Parts = null): Promise<LogResult> {
    return this.serialize(async () => {
      const map = await this.adopt(repoId);
      if (!map) throw new Error("No map for this repo yet.");
      const decision = map.decisions.find((d) => d.id === id);
      if (!decision) throw new Error(`No problem ${id} in this map.`);
      const file = this.logFile(repoId);
      const existing = await readLog(file);
      if (parseLog(existing).done.has(id)) throw new Error(`${id} is already logged as finished.`);
      if (signal?.aborted) throw new Error("Rederive tool cancelled.");
      const tag = parts ? tagDecision(decision, parts) : "unknown";
      const section = entry === "skipped"
        ? formatSkipEntry(decision)
        : formatLogEntry(decision, tag === "unknown" ? entry : { ...entry, part: tag });
      const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      const updated = `${existing}${separator}${section}`;
      await writeFileAtomic(file, updated);
      return { decision, next: pickNext(map, parseLog(updated), parts), file, map };
    });
  }

  /** Caller must hold the queue. */
  private async adopt(repoId: string): Promise<StoredMap | null> {
    const stored = await this.readStored(repoId);
    const task = latestValidBuild(this.listTasks, repoId);
    if (!task || task.id === stored?.taskId) return stored;
    if (stored && stored.builtAt >= finishedAt(task)) return stored;
    const input = task.input as BuildMapInput;
    const map: StoredMap = {
      version: 1,
      repoName: input.repoName,
      builtFrom: input.builtFrom,
      builtAt: finishedAt(task),
      taskId: task.id,
      rootProblem: task.result.rootProblem,
      decisions: task.result.decisions,
    };
    // Any log here belongs to another map (or one whose map.json was lost): its ids no
    // longer line up, so set it aside. A fresh start begins an empty log; keepProgress
    // starts it with the entries whose problem titles still match, renumbered.
    // The old log is copied aside, then log.md is replaced in one atomic write, so a crash
    // at any point leaves either the old log (and a repeat adoption) or the new one.
    const oldLog = await readLog(this.logFile(repoId));
    if (oldLog) {
      await this.archiveLog(repoId, oldLog);
      const carried = input.keepProgress ? carryOverLog(oldLog, map.decisions) : "";
      if (carried) await writeFileAtomic(this.logFile(repoId), carried);
      else await rm(this.logFile(repoId), { force: true });
    }
    // map.json last: it marks the adoption done, so a crash before it repeats the adoption.
    await writeFileAtomic(join(repoDataDir(this.dataDirectory, repoId), "map.md"), renderMapMarkdown(map));
    await writeFileAtomic(this.mapFile(repoId), `${JSON.stringify(map, null, 2)}\n`);
    return map;
  }

  /** Logs set aside by earlier rebuilds, newest first (file names only). */
  async archivedLogs(repoId: string): Promise<string[]> {
    try {
      const names = await readdir(repoDataDir(this.dataDirectory, repoId));
      return names.filter((n) => /^log\.before-.*\.md$/.test(n)).sort().reverse();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async archiveLog(repoId: string, text: string): Promise<void> {
    const stamp = this.now().toISOString().replace(/[:.]/g, "-");
    await writeFileAtomic(join(repoDataDir(this.dataDirectory, repoId), `log.before-${stamp}.md`), text);
  }
}
