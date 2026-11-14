// Group projects: which parts of the repo the learner wrote. Each map decision is tagged
// theirs / partner's / shared by matching its files against those parts, and problems
// are reordered so the learner's own come first, each preceded by the earlier problems
// it builds on. Pure functions: no I/O.
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
  /** Set when a non-own problem runs early because this own problem builds on it. */
  prerequisiteFor?: string;
}

type Plannable = Pick<Decision, "id" | "needs" | "files" | "decision" | "evidence">;

/**
 * The order to run problems in. Without `parts`, map order. With them: each own problem
 * (theirs or shared) in map order, preceded by the earlier problems it needs (directly or
 * through others) that haven't run yet, in map order; then everything else in map order.
 * A decision without `needs` (older maps) needs every earlier one.
 */
export function planProblems<D extends Plannable>(decisions: readonly D[], parts: readonly string[] | null): PlannedProblem<D>[] {
  if (!parts) return decisions.map((decision) => ({ decision, tag: null }));
  const index = new Map(decisions.map((d, i) => [d.id, i]));
  const tags = decisions.map((d) => tagDecision(d, parts));
  const needsOf = (i: number): number[] =>
    decisions[i]!.needs
      ? decisions[i]!.needs!.map((id) => index.get(id)).filter((j): j is number => j !== undefined && j < i)
      : Array.from({ length: i }, (_, j) => j);

  const placed = new Set<number>();
  const plan: PlannedProblem<D>[] = [];
  const place = (i: number, prerequisiteFor?: string) => {
    placed.add(i);
    plan.push({ decision: decisions[i]!, tag: tags[i]!, ...(prerequisiteFor ? { prerequisiteFor } : {}) });
  };
  decisions.forEach((d, i) => {
    if (placed.has(i) || !isOwn(tags[i]!)) return;
    const needed = new Set<number>();
    const visit = (j: number) => {
      for (const k of needsOf(j)) {
        if (needed.has(k)) continue;
        needed.add(k);
        visit(k);
      }
    };
    visit(i);
    for (const j of [...needed].sort((a, b) => a - b)) {
      if (placed.has(j)) continue;
      place(j, isOwn(tags[j]!) ? undefined : d.id);
    }
    place(i);
  });
  decisions.forEach((_, i) => {
    if (!placed.has(i)) place(i);
  });
  return plan;
}
