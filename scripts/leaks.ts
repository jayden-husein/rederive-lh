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
  ("with then from into over onto that this than each when where which while before after until plus also using based like plain text data file files test tests round trip copy " +
    "code decision decisions design problem problems constraint constraints mode progress background learner").split(" "),
);
// Everyday words a technique name can contain ("read write split", "shared secret"): a
// tutor says them in plain teaching, so they stay hints and never make a pair a leak.
const COMMON = new Set(
  ("read reads write writes shared share query queries store check list request requests response work works call calls send sends " +
    "data table tables user users page pages time open close start stop find search filter value values name names order step steps " +
    "single first last only same each every value state status").split(" "),
);
// A claim the learner derived it; next to an unreached technique word, that is the reveal.
const DERIVED_CLAIM = /\byou (re)?derived (it|this|that)\b|\byou rederived\b/i;
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
      if (kind === "technique" && !COMMON.has(term)) for (const id of decisions) techniqueHits.set(id, (techniqueHits.get(id) ?? 0) + 1);
    }
    // One technique word is often an ordinary word ("sort out"); two distinctive ones from
    // one decision name it, and so does one next to "you rederived it".
    const claimsDerived = DERIVED_CLAIM.test(text);
    for (const f of found) {
      const distinctive = f.kind === "technique" && !COMMON.has(f.term);
      const leak = distinctive && (claimsDerived || f.decisions.some((id) => (techniqueHits.get(id) ?? 0) >= 2));
      findings.push({ severity: leak ? "leak" : "hint", ...f });
    }
  };

  const messages = chat.messages ?? [];
  // The learner speaks in chat messages and in card answers.
  const isLearnerInput = (m: (typeof messages)[number]) => m.role === "user" || (m.role === "toolResult" && m.toolName === "ask_user_question");
  // The teacher names a technique once the learner reaches it (rule 4), then logs it. So a
  // problem logged before the learner's next input counts as reached from that learner
  // input on. Skips don't: naming a skipped problem's design is still a leak.
  const loggedAfter = new Map<number, string[]>();
  let lastInput = -1;
  messages.forEach((m, i) => {
    if (isLearnerInput(m)) lastInput = i;
    if (m.role !== "assistant" || typeof m.content === "string") return;
    for (const p of m.content ?? []) {
      if (p.type === "toolCall" && p.name === TOOL_NAMES.logProblem && !failed.has(p.id) && typeof p.arguments?.id === "string") {
        loggedAfter.set(lastInput, [...(loggedAfter.get(lastInput) ?? []), p.arguments.id]);
      }
    }
  });
  for (const id of loggedAfter.get(-1) ?? []) reached.add(id);

  for (const [i, m] of messages.entries()) {
    if (isLearnerInput(m)) {
      learnerSaid += ` ${textOf(m.content)}`;
      for (const id of loggedAfter.get(i) ?? []) reached.add(id);
    }
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
