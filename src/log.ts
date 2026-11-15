// The learner's progress log, in rederive's log.md format: one "## D<n>. <title>" section
// per finished problem. The headings double as the record of which problems are done.
// A skipped problem gets a section whose body is just "skipped": it is deferred, not
// done, and comes back once every untouched problem has been run.
import { readFile } from "node:fs/promises";
import { PART_LABELS, type PartTag } from "./authorship.ts";
import type { Decision } from "./map.ts";

export interface LogEntry {
  struggled: string;
  foundAlone: string;
  didWell: string;
  didOk: string;
  betterIdea?: string;
  /** The design was explained to them, not derived: the log says so in a fixed line. */
  explained?: boolean;
  /** Whose code the problem is about, when the chat recorded which parts the learner wrote. */
  part?: Exclude<PartTag, "unknown">;
  /** How sure the learner was on their last card answer for the problem, in percent. */
  confidence?: number;
}

const SKIPPED_BODY = "skipped";
/** Fixed wording, so an explained problem never reads as derived whatever the notes say. */
const EXPLAINED_LINE = "how: explained to them, not derived";

/** Collapse to one line so a stray "## D3." in the agent's text can't fake a heading. */
function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim() || "-";
}

function heading(decision: Pick<Decision, "id" | "title">): string {
  return `## ${decision.id}. ${oneLine(decision.title)}`;
}

export function formatLogEntry(decision: Pick<Decision, "id" | "title">, entry: LogEntry): string {
  const lines = [
    heading(decision),
    `struggled with: ${oneLine(entry.struggled)}`,
    `found on their own: ${oneLine(entry.foundAlone)}`,
    `did well: ${oneLine(entry.didWell)}`,
    `did ok: ${oneLine(entry.didOk)}`,
  ];
  if (entry.part) lines.push(`whose part: ${PART_LABELS[entry.part]}`);
  if (entry.betterIdea?.trim()) lines.push(`better idea: ${oneLine(entry.betterIdea)}`);
  if (entry.explained) lines.push(EXPLAINED_LINE);
  if (entry.confidence !== undefined) lines.push(`confidence: ${entry.confidence}% on the last answer`);
  return `${lines.join("\n")}\n`;
}

export function formatSkipEntry(decision: Pick<Decision, "id" | "title">): string {
  return `${heading(decision)}\n${SKIPPED_BODY}\n`;
}

export interface LogProgress {
  /** Problems with a full entry. */
  done: Set<string>;
  /** Skipped and not done since, oldest skip first (a re-skip moves a problem to the back). */
  skipped: string[];
}

export function parseLog(logText: string): LogProgress {
  const done = new Set<string>();
  const skipped: string[] = [];
  const headings = [...logText.matchAll(/^## (D\d+)\. .*$/gm)];
  headings.forEach((match, i) => {
    const id = match[1]!;
    const bodyStart = match.index + match[0].length;
    const body = logText.slice(bodyStart, headings[i + 1]?.index ?? logText.length).trim();
    const at = skipped.indexOf(id);
    if (at !== -1) skipped.splice(at, 1);
    if (body === SKIPPED_BODY) {
      if (!done.has(id)) skipped.push(id);
    } else {
      done.add(id);
    }
  });
  return { done, skipped };
}

/**
 * The next problem to run: the first untouched one in map order, then skipped ones in
 * the order they were skipped. Null once every problem is done.
 */
export function nextProblem<T extends Pick<Decision, "id">>(decisions: readonly T[], progress: LogProgress): T | null {
  const untouched = decisions.find((d) => !progress.done.has(d.id) && !progress.skipped.includes(d.id));
  if (untouched) return untouched;
  for (const id of progress.skipped) {
    const d = decisions.find((x) => x.id === id);
    if (d) return d;
  }
  return null;
}

export async function readLog(file: string): Promise<string> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function titleKey(title: string): string {
  return oneLine(title).toLowerCase();
}

/**
 * The part of an old log that still applies to a rebuilt map: sections whose problem
 * title matches a new problem's title, renumbered to the new id, in their old order.
 * Returns "" when nothing matches.
 */
export function carryOverLog(oldLog: string, decisions: readonly Pick<Decision, "id" | "title">[]): string {
  const byTitle = new Map(decisions.map((d) => [titleKey(d.title), d]));
  const headings = [...oldLog.matchAll(/^## D\d+\. (.*)$/gm)];
  const kept: string[] = [];
  headings.forEach((match, i) => {
    const decision = byTitle.get(titleKey(match[1]!));
    if (!decision) return;
    const body = oldLog.slice(match.index + match[0].length, headings[i + 1]?.index ?? oldLog.length).trim();
    kept.push(`${heading(decision)}\n${body}\n`);
  });
  return kept.join("\n");
}
