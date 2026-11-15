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

/** Where a problem stands in the log. */
export type ProblemState = "done" | "skipped" | "todo";

/** One problem of a course, as the agent sees it. */
export interface CourseProblem {
  decision: Decision;
  /** Whose code it is about; null when the chat recorded no authorship. */
  tag: PartTag | null;
  state: ProblemState;
}

/** A course whose decision map exists. */
export interface ReadyCourse {
  state: "ready";
  map: StoredMap;
  /** Every problem, in map order. */
  problems: CourseProblem[];
  /** Untouched problems first, then skipped ones; null once all are done. */
  next: CourseProblem | null;
  /** A rebuild is under way; this map stays current until it finishes. */
  building: boolean;
}

/** A repo's decision map seen from the learner's side (see GLOSSARY.md). */
export type Course = { state: "none" } | { state: "building" } | ReadyCourse;

/** What `record` did. Without a map nothing is written. */
export type RecordResult = { state: "none" } | { state: "building" } | { state: "logged"; decision: Decision; course: ReadyCourse };

export interface LogContents {
  path: string;
  text: string;
  /** Logs set aside by earlier rebuilds, newest first (file names only). */
  archived: string[];
}

/** Which parts of the repo the learner wrote (repo-relative), or null when not recorded. */
export type Parts = readonly string[] | null;

function stateOf(id: string, progress: LogProgress): ProblemState {
  return progress.done.has(id) ? "done" : progress.skipped.includes(id) ? "skipped" : "todo";
}

/** The whole course from one read of the log, so its problem states and `next` agree. */
function courseFrom(map: StoredMap, progress: LogProgress, parts: Parts, building: boolean): ReadyCourse {
  const problems: CourseProblem[] = map.decisions.map((decision) => ({
    decision,
    tag: parts ? tagDecision(decision, parts) : null,
    state: stateOf(decision.id, progress),
  }));
  const plan = planProblems(map.decisions, parts);
  const picked = nextProblemIn(plan.map((p) => ({ ...p, id: p.decision.id })), progress);
  const next = picked ? problems.find((p) => p.decision.id === picked.id) ?? null : null;
  return { state: "ready", map, problems, next, building };
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

  private mapFile(repoId: string): string {
    return join(repoDataDir(this.dataDirectory, repoId), "map.json");
  }

  private logFile(repoId: string): string {
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

  /** Just the repo's map, adopting a newer finished build first. Null if none exists. */
  current(repoId: string): Promise<StoredMap | null> {
    return this.serialize(() => this.adopt(repoId));
  }

  private building(repoId: string): boolean {
    return pendingBuild(this.listTasks, repoId) !== null;
  }

  /**
   * The repo's course: every problem with its state and the next one to run (map order, or
   * with `parts` the learner's own problems first; see planProblems). Adopts a newer
   * finished build first, and reads map and log under one lock.
   */
  course(repoId: string, parts: Parts = null): Promise<Course> {
    return this.serialize(async () => {
      const map = await this.adopt(repoId);
      const building = this.building(repoId);
      if (!map) return { state: building ? "building" : "none" };
      return courseFrom(map, parseLog(await readLog(this.logFile(repoId))), parts, building);
    });
  }

  /**
   * Append a finished (`entry`) or skipped (`"skipped"`) problem to log.md, rewritten
   * atomically, and return the updated course. Looks the map up under the same lock as
   * adoption, so the entry always matches the map it was run from. A skipped problem can
   * be skipped again or finished. Throws for an unknown id or one already finished.
   */
  record(repoId: string, id: string, entry: LogEntry | "skipped", options: { parts?: Parts; signal?: AbortSignal } = {}): Promise<RecordResult> {
    const parts = options.parts ?? null;
    return this.serialize(async () => {
      const map = await this.adopt(repoId);
      const building = this.building(repoId);
      if (!map) return { state: building ? "building" : "none" };
      const decision = map.decisions.find((d) => d.id === id);
      if (!decision) throw new Error(`No problem ${id} in this map.`);
      const file = this.logFile(repoId);
      const existing = await readLog(file);
      if (parseLog(existing).done.has(id)) throw new Error(`${id} is already logged as finished.`);
      if (options.signal?.aborted) throw new Error("Rederive tool cancelled.");
      const tag = parts ? tagDecision(decision, parts) : null;
      const section = entry === "skipped"
        ? formatSkipEntry(decision)
        : formatLogEntry(decision, tag && tag !== "unknown" ? { ...entry, part: tag } : entry);
      const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
      const updated = `${existing}${separator}${section}`;
      await writeFileAtomic(file, updated);
      return { state: "logged", decision, course: courseFrom(map, parseLog(updated), parts, building) };
    });
  }

  /** The log as the "Show rederive log" dialog shows it, after adopting a finished build. */
  logView(repoId: string): Promise<LogContents> {
    return this.serialize(async () => {
      await this.adopt(repoId);
      const path = this.logFile(repoId);
      const [text, archived] = await Promise.all([readLog(path), this.archivedLogs(repoId)]);
      return { path, text, archived };
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

  private async archivedLogs(repoId: string): Promise<string[]> {
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
