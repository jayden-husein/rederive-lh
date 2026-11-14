// Finds design answers shown to the learner too early: a decision's technique words
// ("visited set", "inverted index") or the code locations it lives in ("crawler",
// "querier.c"), in learner-visible agent output, before that decision is logged or
// skipped. Pure functions; leak-check.ts does the file reading.
//
// Heuristic by design: words the decision's own problem text uses (the teacher may say
// those) and words the learner has already said are not flagged.
import { TOOL_NAMES } from "../src/names.ts";
import type { DecisionMapResult } from "../src/map.ts";
import { type Chat, stringsIn, textOf } from "./transcripts.ts";

export type LeakKind = "technique" | "component";

export interface Finding {
  /** "leak": two or more technique words of one decision in one piece of output; "hint": anything else, to judge by hand. */
  severity: "leak" | "hint";
  kind: LeakKind;
  term: string;
  /** Decisions the term belongs to, none of them reached yet. */
  decisions: string[];
  /** Where the learner saw it: "text", or the tool that showed it. */
  source: string;
  excerpt: string;
}

// Short or generic words that say nothing about a particular design, and the words the
// tutor uses about rederive itself ("decision", "progress", "code").
const STOP = new Set(
  ("with then from into over onto that this than each when where which while plus also using based like plain text data file files test tests round trip copy " +
    "code decision decisions design problem problems constraint constraints mode progress background learner").split(" "),
);
// Folder names that say nothing about the design.
const GENERIC_PARTS = new Set(["src", "lib", "libs", "common", "test", "tests", "util", "utils", "server", "client", "app", "docs"]);
// Tools whose arguments the learner never sees (the plugin's own, and the file tools).
const HIDDEN_TOOLS = new Set(["read", "ls", "find", "grep"]);

const words = (text: string) => text.toLowerCase().match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) ?? [];

function codeParts(inThisCode: string): string[] {
  const parts = new Set<string>();
  for (const path of inThisCode.match(/[\w.-]+(?:\/[\w.-]+)+|[\w-]+\.(?:c|h|cc|cpp|js|ts|tsx|py|go|rs|java|sql)\b/g) ?? []) {
    for (const segment of path.split("/")) {
      const name = segment.toLowerCase();
      const stem = name.replace(/\.[a-z]+$/, "");
      if (stem.length < 3 || GENERIC_PARTS.has(stem)) continue;
      parts.add(name);
      parts.add(stem);
    }
  }
  return [...parts];
}

/** term → kind and the decisions it would give away. */
export function leakTerms(map: DecisionMapResult): Map<string, { kind: LeakKind; decisions: string[] }> {
  const terms = new Map<string, { kind: LeakKind; decisions: string[] }>();
  const add = (term: string, kind: LeakKind, id: string) => {
    const entry = terms.get(term) ?? { kind, decisions: [] };
    if (kind === "technique") entry.kind = "technique";
    if (!entry.decisions.includes(id)) entry.decisions.push(id);
    terms.set(term, entry);
  };
  const shared = new Set(words(map.rootProblem));
  for (const d of map.decisions) {
    // What the teacher may say while posing this problem.
    const allowed = new Set([...shared, ...words([d.title, d.problem, d.given, ...d.constraints.map((c) => c.text)].join(" "))]);
    for (const w of words(d.decision.technique)) {
      if (w.length >= 4 && !STOP.has(w) && !allowed.has(w)) add(w, "technique", d.id);
    }
    for (const part of codeParts(d.decision.inThisCode)) {
      if (!allowed.has(part)) add(part, "component", d.id);
    }
  }
  return terms;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, term: string) => new RegExp(`(?<![\\w.-])${escape(term)}s?(?![\\w-])`, "i").test(text);

/** Every early mention, in transcript order; one finding per term per piece of output. */
export function findLeaks(chat: Chat, map: DecisionMapResult): Finding[] {
  const terms = leakTerms(map);
  const reached = new Set<string>();
  let learnerSaid = "";
  const findings: Finding[] = [];
  const failed = new Set((chat.messages ?? []).filter((m) => m.role === "toolResult" && m.isError).map((m) => m.toolCallId));

  const check = (text: string, source: string) => {
    const found: Omit<Finding, "severity">[] = [];
    const techniqueHits = new Map<string, number>();
    for (const [term, { kind, decisions }] of terms) {
      if (decisions.some((id) => reached.has(id)) || mentions(learnerSaid, term) || !mentions(text, term)) continue;
      const at = text.toLowerCase().indexOf(term);
      const excerpt = text.slice(Math.max(0, at - 60), at + term.length + 60).replace(/\s+/g, " ");
      found.push({ kind, term, decisions, source, excerpt });
      if (kind === "technique") for (const id of decisions) techniqueHits.set(id, (techniqueHits.get(id) ?? 0) + 1);
    }
    // One technique word is often an ordinary word ("sort out"); two from one decision name it.
    for (const f of found) {
      const leak = f.kind === "technique" && f.decisions.some((id) => (techniqueHits.get(id) ?? 0) >= 2);
      findings.push({ severity: leak ? "leak" : "hint", ...f });
    }
  };

  for (const m of chat.messages ?? []) {
    if (m.role === "user") learnerSaid += ` ${textOf(m.content)}`;
    // Card answers are the learner's words too.
    if (m.role === "toolResult" && m.toolName === "ask_user_question") learnerSaid += ` ${textOf(m.content)}`;
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const p of m.content ?? []) {
      if (p.type === "text" && p.text) check(p.text, "text");
      if (p.type !== "toolCall" || !p.name) continue;
      if ((p.name === TOOL_NAMES.logProblem || p.name === TOOL_NAMES.skipProblem) && !failed.has(p.id)) {
        const id = p.arguments?.id;
        if (typeof id === "string") reached.add(id);
        continue;
      }
      if (p.name.startsWith("rederive_") || HIDDEN_TOOLS.has(p.name)) continue;
      check(stringsIn(p.arguments).join("\n"), p.name);
    }
  }
  return findings;
}
