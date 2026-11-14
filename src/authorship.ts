// Group projects: which parts of the repo the learner wrote. Each map decision is tagged
// theirs / partner's / shared by matching its files against those parts, and problems
// are reordered so the learner's own come first. Pure functions: no I/O.
import type { Decision } from "./map.ts";

/** Whose code a problem is about. "unknown" when the decision names no files. */
export type PartTag = "theirs" | "partner" | "shared" | "unknown";

export const PART_LABELS: Record<PartTag, string> = {
  theirs: "theirs",
  partner: "partner's",
  shared: "shared",
  unknown: "unknown",
};

/**
 * A repo-relative path as the learner or the worker wrote it, in one comparable form:
 * forward slashes, no leading "./" or "/", no trailing "/". "" is the whole repo.
 */
export function normalizePart(raw: string): string {
  let p = raw.trim().replace(/^["'`]|["'`]$/g, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  p = p.replace(/^(\.\/)+/, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p === "." ? "" : p;
}

/**
 * A repo-relative path, checked before normalizing: no drive letter, no leading slash or
 * backslash (so no UNC path) and no ".." segment.
 */
export function isRepoRelative(raw: string): boolean {
  const p = raw.trim();
  return !/^([a-z]:|[\\/])/i.test(p) && !p.split(/[\\/]+/).includes("..");
}

/** Paths with a folder in them ("querier/querier.c", "indexer/"), for maps built before `files` existed. */
function pathsIn(text: string): string[] {
  const found = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, " ").match(/(?:[\w.-]+\/)+[\w.-]*/g) ?? [];
  // Keep a folder ("indexer/") or a file with an extension; prose like "I/O" or "and/or" has neither.
  return found.map((p) => p.replace(/\.+$/, "")).filter((p) => p.endsWith("/") || /\.\w+$/.test(p));
}

/** Where a decision lives: its `files`, or for older maps the paths named in its text. */
export function decisionFiles(d: Pick<Decision, "files" | "decision" | "evidence">): string[] {
  return d.files ?? pathsIn(`${d.decision.inThisCode} ${d.evidence}`);
}

type Relation = "inside" | "contains" | "outside";

function relation(file: string, part: string): Relation {
  const f = normalizePart(file).toLowerCase();
  const p = normalizePart(part).toLowerCase();
  if (p === "" || f === p || f.startsWith(`${p}/`)) return "inside";
  // The file is a folder holding one of their parts, e.g. "common/" vs "common/index.c".
  if (f === "" || p.startsWith(`${f}/`)) return "contains";
  return "outside";
}

/** theirs: every file is in their parts. partner: none is. shared: some are, or a folder mixes both. */
export function tagDecision(d: Pick<Decision, "files" | "decision" | "evidence">, parts: readonly string[]): PartTag {
  const files = decisionFiles(d);
  if (files.length === 0) return "unknown";
  let own = 0;
  let mixed = 0;
  for (const file of files) {
    const relations = parts.map((p) => relation(file, p));
    if (relations.includes("inside")) own++;
    else if (relations.includes("contains")) mixed++;
  }
  if (own === files.length) return "theirs";
  if (own === 0 && mixed === 0) return "partner";
  return "shared";
}

function isOwn(tag: PartTag): boolean {
  return tag === "theirs" || tag === "shared";
}

export interface PlannedProblem<D> {
  decision: D;
  /** Null when the chat has no authorship recorded. */
  tag: PartTag | null;
}

type Plannable = Pick<Decision, "id" | "files" | "decision" | "evidence">;

/**
 * The order to run problems in. Without `parts`, map order. With them: own problems
 * (theirs or shared) first, then the rest, each group in map order. Nothing earlier is run
 * first: the teacher opens an own problem with what already exists (its `given`).
 */
export function planProblems<D extends Plannable>(decisions: readonly D[], parts: readonly string[] | null): PlannedProblem<D>[] {
  if (!parts) return decisions.map((decision) => ({ decision, tag: null }));
  const plan = decisions.map((decision) => ({ decision, tag: tagDecision(decision, parts) }));
  return [...plan.filter((p) => isOwn(p.tag)), ...plan.filter((p) => !isOwn(p.tag))];
}
