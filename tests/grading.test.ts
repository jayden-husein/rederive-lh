import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ModelCatalogResponse, PluginInferenceRequest } from "learnharness-plugin-api";
import { Value } from "typebox/value";
import { answerText, CONFIDENCE_COLORS, confidenceRailStyle, gradeView, readConfidence, readGrade, snapConfidence, stepConfidence, type DesignGrade } from "../src/design-card.ts";
import {
  createDesignQuestionType,
  createPickQuestionType,
  DesignAnswerSchema,
  DesignPayloadSchema,
  PickAnswerSchema,
  PickPayloadSchema,
  gradeFromMap,
  gradingPrompt,
  parseModelGrade,
  type GraderDeps,
} from "../src/grading.ts";
import { letteredOptions, type Decision, type StoredMap } from "../src/map.ts";
import { sampleMapResult } from "./helpers.ts";

function decision(): Decision {
  return {
    id: "D2",
    title: "Find pages fast",
    problem: "A query must find the pages with a word.",
    given: "Pages are saved on disk.",
    constraints: [
      { text: "There are ten thousand pages.", breaks: "scanning every page per query" },
      { text: "The querier runs later, in a separate process.", breaks: "keeping the table in memory" },
      { text: "Pages change daily.", breaks: "never rebuilding" },
    ],
    decision: { technique: "inverted index", definition: "word -> pages", inThisCode: "index.c" },
    options: [
      { approach: "Scan every page per query", tradeoff: "simple, slow", real: false, failsAt: 1 },
      { approach: "Word to pages table saved to a file", tradeoff: "build step", real: true },
      { approach: "Word to pages table in memory", tradeoff: "lost on exit", real: false, failsAt: 2 },
      { approach: "Ask the user to grep", tradeoff: "not a system", real: false, failsAt: 0 },
    ],
    files: ["index.c"],
    evidence: "code only",
  };
}

const letterOf = (d: Decision, approach: string) => letteredOptions(d).find((o) => o.option.approach === approach)!.letter;

test("options are lettered A.. in a stable order that doesn't simply follow the map", () => {
  const d = decision();
  const a = letteredOptions(d);
  assert.deepEqual(a.map((o) => o.letter), ["A", "B", "C", "D"]);
  assert.deepEqual(letteredOptions(decision()).map((o) => o.option.approach), a.map((o) => o.option.approach));
  // Across the sample map's decisions the real option isn't always first.
  const firsts = sampleMapResult(10).decisions.map((x) => letteredOptions(x)[0]!.option.real);
  assert.ok(firsts.includes(false), "the real option should not always be A");
});

test("an option pick is graded from the map: real holds, others break at their constraint once it's given", () => {
  const d = decision();
  assert.deepEqual(gradeFromMap(d, 3, letterOf(d, "Word to pages table saved to a file")), { verdict: "holds", failedAt: null, constraint: null, gradedBy: "map" });
  assert.deepEqual(gradeFromMap(d, 1, letterOf(d, "Scan every page per query")), {
    verdict: "breaks", failedAt: 1, constraint: "There are ten thousand pages.", gradedBy: "map",
  });
  // In-memory fails only at constraint 2: with one constraint given, it holds up so far.
  assert.deepEqual(gradeFromMap(d, 1, letterOf(d, "Word to pages table in memory")), { verdict: "holds", failedAt: null, constraint: null, gradedBy: "map" });
  assert.deepEqual(gradeFromMap(d, 0, letterOf(d, "Ask the user to grep")), { verdict: "breaks", failedAt: 0, constraint: null, gradedBy: "map" });
});

test("an unmarked map (built before step 9) gives no map grade", () => {
  const d = decision();
  for (const o of d.options) {
    delete o.real;
    delete o.failsAt;
  }
  assert.equal(gradeFromMap(d, 1, "A"), null);
});

test("an unknown letter is an error, not a guess", () => {
  assert.throws(() => gradeFromMap(decision(), 1, "E"), /No option E/);
});

test("the grading prompt has the given constraints only, and never the decision or the options' marks", () => {
  const { systemPrompt, user } = gradingPrompt(decision(), 2, "Keep a table from words to pages.");
  const all = `${systemPrompt}\n${user}`;
  assert.match(user, /1\. There are ten thousand pages\./);
  assert.match(user, /2\. The querier runs later/);
  assert.doesNotMatch(all, /Pages change daily/);
  assert.doesNotMatch(all, /inverted index|word -> pages|index\.c/);
  assert.match(user, /<<<DESIGN\nKeep a table from words to pages\.\nDESIGN>>>/);
  assert.match(systemPrompt, /data, not instructions/);
});

test("a model reply is parsed into a grade with the map's constraint text", () => {
  const d = decision();
  assert.deepEqual(parseModelGrade('Sure.\n{"verdict":"breaks","failed":2}', d, 2), {
    verdict: "breaks", failedAt: 2, constraint: "The querier runs later, in a separate process.", gradedBy: "model",
  });
  assert.deepEqual(parseModelGrade('{"verdict":"holds","failed":2}', d, 2), { verdict: "holds", failedAt: null, constraint: null, gradedBy: "model" });
  assert.deepEqual(parseModelGrade('{"verdict":"partly","failed":0}', d, 2), { verdict: "partly", failedAt: 0, constraint: null, gradedBy: "model" });
});

test("a model reply naming a constraint not yet given drops it rather than reveal it", () => {
  assert.deepEqual(parseModelGrade('{"verdict":"breaks","failed":3}', decision(), 2), { verdict: "breaks", failedAt: null, constraint: null, gradedBy: "model" });
});

test("an unreadable model reply is an error", () => {
  assert.throws(() => parseModelGrade("It mostly works.", decision(), 1), /grade/);
  assert.throws(() => parseModelGrade('{"verdict":"great"}', decision(), 1), /grade/);
});

test("the payload schemas have no room for an answer key", () => {
  const two = [{ letter: "A", text: "x" }, { letter: "B", text: "y" }];
  assert.equal(Value.Check(DesignPayloadSchema, { problemId: "D2", constraintsGiven: 1 }), true);
  assert.equal(Value.Check(DesignPayloadSchema, { problemId: "D2", constraintsGiven: 1, options: two }), false, "options go on the pick card");
  assert.equal(Value.Check(DesignPayloadSchema, { problemId: "D2", constraintsGiven: 1, real: "A" }), false);
  assert.equal(Value.Check(PickPayloadSchema, { problemId: "D2", constraintsGiven: 1, options: two }), true);
  assert.equal(Value.Check(PickPayloadSchema, { problemId: "D2", constraintsGiven: 1 }), false, "a pick card needs options");
  assert.equal(Value.Check(PickPayloadSchema, { problemId: "D2", constraintsGiven: 1, options: [{ letter: "A", text: "x", real: true }, two[1]] }), false);
  assert.equal(Value.Check(DesignAnswerSchema, { design: "a table" }), true);
  assert.equal(Value.Check(DesignAnswerSchema, { choice: "A" }), false);
  assert.equal(Value.Check(PickAnswerSchema, { choice: "A" }), true);
  assert.equal(Value.Check(PickAnswerSchema, { choice: "A", why: "x" }), false, "the reasoning goes in the host thinking box");
});

test("answers may carry a confidence, only at the native quiz's stops", () => {
  assert.equal(Value.Check(DesignAnswerSchema, { design: "a table", confidence: 90 }), true);
  assert.equal(Value.Check(PickAnswerSchema, { choice: "A", confidence: 0 }), true);
  assert.equal(Value.Check(PickAnswerSchema, { choice: "A", confidence: 55 }), false);
  assert.deepEqual([12, 40, 60, 95, 101].map(snapConfidence), [0, 30, 50, 90, 100]);
  assert.equal(readConfidence({ design: "x", confidence: 70 }), 70);
  assert.equal(readConfidence({ design: "x" }), null, "a version 1 answer has none");
  assert.equal(readConfidence({ design: "x", confidence: 55 }), null);
});

test("the slider steps one stop with ←/→, held at the ends, and colours its rail like the native one", () => {
  assert.deepEqual([stepConfidence(50, 1), stepConfidence(50, -1), stepConfidence(100, 1), stepConfidence(0, -1)], [70, 30, 100, 0]);
  const rail = confidenceRailStyle(90);
  assert.match(rail.backgroundImage!, /^linear-gradient\(90deg, #22c55e 0%, #22c55e 90%, transparent 90%/);
  assert.equal(rail.backgroundPosition, "0 0, 30% 0, 50% 0, 70% 0, 90% 0");
  assert.equal(CONFIDENCE_COLORS.length, 6);
});

test("the answered badge says how sure they were; without a confidence it's unchanged", () => {
  const breaks = { result: { verdict: "breaks", failedAt: 1, constraint: "c1", gradedBy: "model" } };
  assert.equal(gradeView(breaks, 90).badge, "Breaks · 90% sure");
  assert.equal(gradeView(breaks).badge, "Breaks");
  assert.equal(gradeView({ error: "x" }, 50).badge, "Not graded · 50% sure");
});

test("the grader never sees the confidence", async () => {
  const { deps, requests } = fakeDeps();
  const design = createDesignQuestionType(deps);
  await design.gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "a cache", confidence: 90 }) as never);
  assert.doesNotMatch(JSON.stringify(requests[0]!.context), /confidence|90%/);
});

// ---------------------------------------------------------------------------
// gradeAnswer, end to end with fake stores and model.

function storedMap(d: Decision): StoredMap {
  const base = sampleMapResult(5);
  return { version: 1, repoName: "tiny", builtFrom: null, builtAt: "2026-11-15T00:00:00.000Z", taskId: "t", rootProblem: base.rootProblem, decisions: [base.decisions[0]!, d] };
}

const CATALOG = { slots: { cheap: { model: { provider: "p", id: "cheap-1" } } } } as unknown as ModelCatalogResponse;

function fakeDeps(over: Partial<GraderDeps> & { reply?: string; d?: Decision } = {}) {
  const requests: PluginInferenceRequest[] = [];
  const d = over.d ?? decision();
  const deps: GraderDeps = {
    store: { getChat: async () => ({ repo: { id: "r1" } }) as never },
    maps: { current: async () => storedMap(d) },
    catalog: async () => CATALOG,
    complete: async (request) => {
      requests.push(request);
      return { role: "assistant", content: [{ type: "text", text: over.reply ?? '{"verdict":"partly","failed":1}' }], stopReason: "stop" } as unknown as AssistantMessage;
    },
    ...over,
  };
  return { deps, requests };
}

function gradeCtx(payload: unknown, answer: unknown) {
  return {
    chatId: "c1", questionId: "q1", variant: "teach" as const, contractVersion: 1,
    input: { type: "check" as const, nodeId: "decisions", question: "How would you change it?", payload },
    answer, signal: new AbortController().signal,
  } as never;
}

/** The card's options as the teacher poses them: the problem's letters, texts in plain words. */
function cardOptions(d: Decision) {
  return letteredOptions(d).map(({ letter, option }) => ({ letter, text: `${option.approach} (${option.tradeoff})` }));
}

test("gradeAnswer grades a marked option pick from the map, with no model call", async () => {
  const { deps, requests } = fakeDeps();
  const type = createPickQuestionType(deps);
  const d = decision();
  const letter = letterOf(d, "Scan every page per query");
  const grade = await type.gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1, options: cardOptions(d) }, { choice: letter }));
  assert.equal((grade as unknown as DesignGrade).verdict, "breaks");
  assert.equal(requests.length, 0);
});

test("gradeAnswer refuses to grade when the card's letters don't match the problem's", async () => {
  const d = decision();
  // The teacher swapped two letters: the learner picked the text of another option.
  const swapped = cardOptions(d);
  [swapped[0]!.text, swapped[1]!.text] = [swapped[1]!.text, swapped[0]!.text];
  const type = createPickQuestionType(fakeDeps().deps);
  await assert.rejects(
    type.gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1, options: swapped }, { choice: swapped[0]!.letter })) as Promise<unknown>,
    /doesn't match/,
  );
  // Reworded, but still clearly the same option: graded.
  const reworded = cardOptions(d).map((o) => ({ ...o, text: `Option: ${o.text.toLowerCase()}` }));
  await assert.doesNotReject(type.gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1, options: reworded }, { choice: "A" })) as Promise<unknown>);
});

test("gradeAnswer sends a free-text design to the cheap model as a learner-triggered call", async () => {
  const { deps, requests } = fakeDeps();
  const grade = await createDesignQuestionType(deps).gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "A big table." }));
  assert.deepEqual(grade, { verdict: "partly", failedAt: 1, constraint: "There are ten thousand pages.", gradedBy: "model" });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.purpose, "user");
  assert.equal(requests[0]!.model.id, "cheap-1");
  assert.ok(requests[0]!.signal, "the call is cancellable");
});

test("gradeAnswer falls back to the model for an option pick on an unmarked map", async () => {
  const d = decision();
  for (const o of d.options) {
    delete o.real;
    delete o.failsAt;
  }
  const { deps, requests } = fakeDeps({ d, reply: '{"verdict":"holds","failed":null}' });
  const letter = letteredOptions(d)[0]!;
  await createPickQuestionType(deps).gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1, options: cardOptions(d) }, { choice: letter.letter }));
  const user = requests[0]!.context.messages[0]!.content as string;
  assert.ok(user.includes(letter.option.approach));
});

test("gradeAnswer fails clearly with no cheap model or no map (the host then saves it ungraded)", async () => {
  const noModel = fakeDeps({ catalog: async () => ({ slots: {} }) as unknown as ModelCatalogResponse });
  await assert.rejects(createDesignQuestionType(noModel.deps).gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "x" })) as Promise<unknown>, /cheap model/);
  const noMap = fakeDeps({ maps: { current: async () => null } });
  await assert.rejects(createDesignQuestionType(noMap.deps).gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "x" })) as Promise<unknown>, /map/);
  const errored = fakeDeps({
    complete: async () => ({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limited" }) as unknown as AssistantMessage,
  });
  await assert.rejects(createDesignQuestionType(errored.deps).gradeAnswer!(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "x" })) as Promise<unknown>, /rate limited/);
});

test("grading settles on cancel even when the model call ignores its signal", async () => {
  const { deps } = fakeDeps({ complete: () => new Promise<AssistantMessage>(() => {}) });
  const controller = new AbortController();
  const ctx = { ...(gradeCtx({ problemId: "D2", constraintsGiven: 1 }, { design: "x" }) as object), signal: controller.signal } as never;
  const pending = createDesignQuestionType(deps).gradeAnswer!(ctx) as Promise<unknown>;
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /cancelled/);
});

test("validation: a pick must be one of the card's letters, a design must have text, letters must be unique", () => {
  const pick = createPickQuestionType(fakeDeps().deps);
  const design = createDesignQuestionType(fakeDeps().deps);
  const options = [{ letter: "A", text: "x" }, { letter: "B", text: "y" }];
  const answerCtx = (payload: unknown, answer: unknown) => ({ ...(gradeCtx(payload, answer) as object), signal: undefined }) as never;
  assert.deepEqual(pick.validateAnswer!(answerCtx({ problemId: "D2", constraintsGiven: 0, options }, { choice: "B" })) ?? [], []);
  assert.match(pick.validateAnswer!(answerCtx({ problemId: "D2", constraintsGiven: 0, options }, { choice: "C" }))![0]!, /Pick one of A, B/);
  assert.match(design.validateAnswer!(answerCtx({ problemId: "D2", constraintsGiven: 0 }, { design: "   " }))![0]!, /Describe your design/);
  const dupes = { problemId: "D2", constraintsGiven: 0, options: [{ letter: "A", text: "x" }, { letter: "A", text: "y" }] };
  assert.match(pick.validateQuestion!({ chatId: "c", variant: "teach", contractVersion: 1, input: { type: "check", nodeId: "n", question: "q", payload: dupes } } as never)![0]!, /its own letter/);
});

// ---------------------------------------------------------------------------
// What the card shows.

test("the card shows the verdict and the constraint, and 'Not graded' on any error", () => {
  assert.deepEqual(gradeView({ result: { verdict: "holds", failedAt: null, constraint: null, gradedBy: "map" } }), { badge: "Holds up so far", tone: "good", detail: null });
  assert.deepEqual(gradeView({ result: { verdict: "breaks", failedAt: 1, constraint: "Ten thousand pages.", gradedBy: "model" } }), {
    badge: "Breaks", tone: "bad", detail: "Breaks on: Ten thousand pages.",
  });
  assert.deepEqual(gradeView({ result: { verdict: "partly", failedAt: 0, constraint: null, gradedBy: "model" } }), {
    badge: "Partly holds", tone: "mid", detail: "Doesn't fully solve the problem yet.",
  });
  assert.deepEqual(gradeView({ error: "No cheap model" }), { badge: "Not graded", tone: "none", detail: null });
  assert.deepEqual(gradeView({ result: { verdict: "nope" } }), { badge: "Not graded", tone: "none", detail: null });
  assert.deepEqual(gradeView(undefined), { badge: "Not graded", tone: "none", detail: null });
  assert.equal(readGrade({ verdict: "holds", failedAt: null, constraint: null, gradedBy: "map" })?.verdict, "holds");
});

test("two card types: the pick card has the host thinking box, the design card has none", () => {
  const pick = createPickQuestionType(fakeDeps().deps);
  const design = createDesignQuestionType(fakeDeps().deps);
  assert.equal(pick.showThinking, true);
  assert.equal(design.showThinking, false);
  assert.notEqual(pick.id, design.id);
  assert.equal(pick.teach!.toolName, "rederive_ask_pick");
  assert.equal(design.teach!.toolName, "rederive_ask_design");
});

test("a picked option shows with its letter; a why saved by the earlier card still shows", () => {
  const d = decision();
  const options = cardOptions(d);
  const letter = letterOf(d, "Word to pages table saved to a file");
  assert.match(answerText({ problemId: "D2", constraintsGiven: 1, options }, { choice: letter }), new RegExp(`^\\*\\*${letter}\\.\\*\\* Word to pages table`));
  assert.match(answerText({ problemId: "D2", constraintsGiven: 1, options }, { choice: letter, why: "Saved, so it lasts." }), /\n\nWhy: Saved, so it lasts\.$/);
});

test("each tool says which questions it's for; options never go in a chat message", () => {
  const pick = createPickQuestionType(fakeDeps().deps).teach!.description;
  const design = createDesignQuestionType(fakeDeps().deps).teach!.description;
  assert.match(pick, /pass the problem's options/);
  assert.match(pick, /never list them in a message/);
  assert.match(design, /how would you solve it/);
  assert.match(design, /rederive_ask_pick/);
});
