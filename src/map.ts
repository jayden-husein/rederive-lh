// The decision map: the hidden list of design problems the learner re-derives, built by
// the `build-map` worker. Defines the worker's result schema, the semantic checks the
// schema can't express, and the markdown rendering (rederive's map.md format).
import { Type, type Static } from "typebox";
import { isRepoRelative } from "./authorship.ts";

export const MIN_DECISIONS = 5;
export const MAX_DECISIONS = 10;
export const MAX_CONSTRAINTS = 6;

const Text = (description: string, maxLength = 1000) => Type.String({ minLength: 1, maxLength, description });

export const DecisionSchema = Type.Object(
  {
    id: Type.String({ pattern: "^D([1-9]|10)$", description: 'Position in build order: "D1", "D2", ...' }),
    title: Text("The problem as a short heading, without naming the solution.", 120),
    problem: Text("What has to work, in plain words, with no solution terms."),
    given: Text("What already exists at this point in the build order."),
    constraints: Type.Array(
      Type.Object(
        {
          text: Text("One constraint, introduced to the learner on its own."),
          breaks: Text("The naive design this constraint rules out."),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: MAX_CONSTRAINTS, description: "Constraints in the order they should be introduced." },
    ),
    decision: Type.Object(
      {
        technique: Text('General name engineers outside this project know, e.g. "middleware chain".', 120),
        definition: Text("One-line definition of the technique."),
        inThisCode: Text("What this codebase does with it."),
      },
      { additionalProperties: false },
    ),
    options: Type.Array(
      Type.Object(
        {
          approach: Text("One approach to the problem.", 300),
          tradeoff: Text("Its tradeoff in one line.", 300),
          real: Type.Boolean({ description: "true for the approach this codebase uses; exactly one per decision." }),
          failsAt: Type.Optional(
            Type.Integer({
              minimum: 0,
              maximum: MAX_CONSTRAINTS,
              description: "Other approaches only: the first constraint (1-based) it can't survive, or 0 if it fails the bare problem.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 4, description: "2 to 4 approaches, including the real one." },
    ),
    files: Type.Array(Text("A repo-relative path with forward slashes: a file, or a folder ending in /.", 300), {
      minItems: 1,
      maxItems: 12,
      description: "Where this decision lives in the code.",
    }),
    evidence: Text('Commits (short sha and message) and file paths, or "code only".'),
  },
  { additionalProperties: false },
);

export const DecisionMapResultSchema = Type.Object(
  {
    rootProblem: Text("Why the project exists: what its author faced before any code was written."),
    decisions: Type.Array(DecisionSchema, { minItems: MIN_DECISIONS, maxItems: MAX_DECISIONS }),
  },
  { additionalProperties: false },
);

type WorkerDecision = Static<typeof DecisionSchema>;
type WorkerOption = WorkerDecision["options"][number];
/** A map option. Maps built before step 9 have no `real`/`failsAt`. */
export type DecisionOption = Omit<WorkerOption, "real"> & Partial<Pick<WorkerOption, "real">>;
/** A map decision. Maps built before step 8 have no `files`. */
export type Decision = Omit<WorkerDecision, "files" | "options"> & Partial<Pick<WorkerDecision, "files">> & { options: DecisionOption[] };

export const OPTION_LETTERS = ["A", "B", "C", "D"] as const;

/** FNV-1a: a small stable hash, so the option order is the same on every turn. */
function stableHash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The options as the teacher poses them: lettered A.. in an order shuffled by a stable
 * hash, because the worker tends to list the real one first. Grading maps a letter back
 * through this same order.
 */
export function letteredOptions(d: Pick<Decision, "id" | "options">): { letter: string; option: DecisionOption }[] {
  return d.options
    .map((option, index) => ({ option, index, key: stableHash(`${d.id}|${option.approach}`) }))
    .sort((a, b) => a.key - b.key || a.index - b.index)
    .map(({ option }, i) => ({ letter: OPTION_LETTERS[i] ?? String(i + 1), option }));
}

/** True when the map says which option is real (maps built from step 9 on). */
export function hasMarkedOptions(d: Decision): boolean {
  return d.options.some((o) => typeof o.real === "boolean");
}
export type DecisionMapResult = Omit<Static<typeof DecisionMapResultSchema>, "decisions"> & { decisions: Decision[] };

/** What we store in map.json: the worker's result plus where it came from. */
export interface StoredMap extends DecisionMapResult {
  version: 1;
  repoName: string;
  /** Short HEAD sha the map was built from, or null for a folder without git. */
  builtFrom: string | null;
  builtAt: string;
  /** The worker task that produced it. */
  taskId: string;
}

/**
 * Checks the schema can't express. Throws one message listing every problem, which the
 * host feeds back to the worker as correction feedback. Side-effect free.
 */
export function validateMapResult(result: unknown): asserts result is DecisionMapResult {
  const problems: string[] = [];
  const decisions = (result as Partial<DecisionMapResult> | null)?.decisions;
  if (!Array.isArray(decisions)) throw new Error("result.decisions must be an array.");
  decisions.forEach((d, i) => {
    const expected = `D${i + 1}`;
    if (d?.id !== expected) problems.push(`decisions[${i}].id is "${String(d?.id)}"; ids must run D1, D2, ... in build order, so this one must be "${expected}".`);
  });
  const techniques = new Map<string, string>();
  for (const d of decisions) {
    const key = String(d?.decision?.technique ?? "").trim().toLowerCase();
    const earlier = techniques.get(key);
    if (key && earlier) problems.push(`${d.id} and ${earlier} have the same technique "${d.decision.technique}"; each decision must be a different mechanism.`);
    else if (key) techniques.set(key, d.id);
  }
  decisions.forEach((d) => {
    for (const file of Array.isArray(d?.files) ? d.files : []) {
      if (!isRepoRelative(String(file))) problems.push(`${d.id}.files has "${file}"; use paths relative to the repo root, without "..".`);
    }
  });
  // Grading reads these; maps built before step 9 carry no marks and are graded by the model.
  decisions.forEach((d) => {
    const options: DecisionOption[] = Array.isArray(d?.options) ? d.options : [];
    if (!hasMarkedOptions({ ...d, options })) return;
    if (options.filter((o) => o.real === true).length !== 1) problems.push(`${d.id} must mark exactly one option real: true (the approach this codebase uses).`);
    const count = Array.isArray(d.constraints) ? d.constraints.length : 0;
    options.forEach((o, i) => {
      const where = `${d.id} option ${i + 1}`;
      if (o.real === true) {
        if (o.failsAt !== undefined) problems.push(`${where} is real, so leave out failsAt.`);
      } else if (o.failsAt === undefined) {
        problems.push(`${where} is not real, so it needs failsAt: the first constraint it can't survive (0 if it fails the bare problem).`);
      } else if (o.failsAt > count) {
        problems.push(`${where} has failsAt ${o.failsAt}, but ${d.id} has ${count} constraint${count === 1 ? "" : "s"}.`);
      }
    });
  });
  if (problems.length) throw new Error(`Fix the map and submit again:\n- ${problems.join("\n- ")}`);
}

function optionMark(o: DecisionOption): string {
  if (o.real === true) return " (real)";
  if (o.failsAt === undefined) return "";
  return o.failsAt === 0 ? " (fails the bare problem)" : ` (fails at constraint ${o.failsAt})`;
}

/** Rederive's map.md layout, for the learner to read after the session (never shown mid-problem). */
export function renderMapMarkdown(map: StoredMap): string {
  const lines = [
    "# Decision map",
    `repo: ${map.repoName} | built from: ${map.builtFrom ?? "no git"} | date: ${map.builtAt.slice(0, 10)}`,
    `root problem: ${map.rootProblem}`,
  ];
  for (const d of map.decisions) {
    lines.push(
      "",
      `## ${d.id}. ${d.title}`,
      `- Problem: ${d.problem}`,
      `- Given: ${d.given}`,
      "- Constraints, in order:",
      ...d.constraints.map((c, i) => `  ${i + 1}. ${c.text} -> breaks: ${c.breaks}`),
      `- Decision: ${d.decision.technique}: ${d.decision.definition} In this code: ${d.decision.inThisCode}`,
      "- Options:",
      ...d.options.map((o) => `  - ${o.approach}: ${o.tradeoff}${optionMark(o)}`),
      ...(d.files ? [`- Files: ${d.files.join(", ")}`] : []),
      `- Evidence: ${d.evidence}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
