// The decision map: the hidden list of design problems the learner re-derives, built by
// the `build-map` worker. Defines the worker's result schema, the semantic checks the
// schema can't express, and the markdown rendering (rederive's map.md format).
import { Type, type Static } from "typebox";

export const MIN_DECISIONS = 5;
export const MAX_DECISIONS = 10;

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
      { minItems: 1, maxItems: 6, description: "Constraints in the order they should be introduced." },
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
        },
        { additionalProperties: false },
      ),
      { minItems: 2, maxItems: 4, description: "2 to 4 approaches, including the real one." },
    ),
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

export type Decision = Static<typeof DecisionSchema>;
export type DecisionMapResult = Static<typeof DecisionMapResultSchema>;

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
  if (problems.length) throw new Error(`Fix the map and submit again:\n- ${problems.join("\n- ")}`);
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
      ...d.options.map((o) => `  - ${o.approach}: ${o.tradeoff}`),
      `- Evidence: ${d.evidence}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
