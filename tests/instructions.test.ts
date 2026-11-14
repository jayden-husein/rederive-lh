import assert from "node:assert/strict";
import { test } from "node:test";
import { modeRules, proberInstructions, teacherInstructions } from "../src/instructions.ts";
import { TOOL_NAMES } from "../src/names.ts";
import { DEFAULT_MODES, type Settings } from "../src/settings.ts";
import { WORKER_INSTRUCTIONS } from "../src/worker.ts";

const base: Settings = { defaultMode: "auto", defaultRepo: "" };

test("prober routing follows the default-mode setting", () => {
  const expected = {
    auto: /Pick the mode from the learner's words.*ask exactly once/,
    ask: /Ask exactly once: .*Skip it only when the learner already named a mode/,
    always: /Use rederive mode unless the learner asks for something else/,
    never: /set this plugin to manual/,
  };
  for (const defaultMode of DEFAULT_MODES) {
    const text = proberInstructions({ ...base, defaultMode });
    assert.match(text, expected[defaultMode], defaultMode);
    for (const other of DEFAULT_MODES.filter((m) => m !== defaultMode)) assert.doesNotMatch(text, expected[other]);
  }
  // The teacher only needs the manual setting, to keep normal mode quiet.
  assert.match(teacherInstructions({ ...base, defaultMode: "never" }), /set this plugin to manual/);
  assert.doesNotMatch(teacherInstructions(base), /manual/);
});

test("the prober offers the default repo only when one is set", () => {
  assert.match(proberInstructions(base), /If they named none, ask for a local folder path or a git URL\./);
  const withRepo = proberInstructions({ ...base, defaultRepo: "C:\\code\\tse" });
  assert.match(withRepo, /offer their default repo \("C:\\\\code\\\\tse"\) and open it once they confirm/);
});

test("the prober decides the mode before asking for a repo, and normal mode asks for none", () => {
  const text = proberInstructions(base);
  assert.ok(text.indexOf("Decide the mode") < text.indexOf("Get the repo"));
  assert.match(text, /Normal: probe as usual and stop here\./);
  assert.match(text, /"switch modes"/);
});

test("every question goes through the question card, and a dismissed card pauses", () => {
  // The teacher carries it in every codebase chat, so the routing question from normal mode is a card too.
  for (const text of [proberInstructions(base), teacherInstructions(base)]) {
    assert.match(text, /Ask every question to the learner with ask_user_question, one per message, never as plain text/);
    assert.match(text, /dismissed, the learner paused.*end your turn; on their next message, ask the same question again/);
  }
});

test("the always-on teacher text is short and points to rederive_status for the rules", () => {
  const text = teacherInstructions(base);
  assert.ok(text.length < 1000, `teacher instructions are ${text.length} chars`);
  assert.match(text, /when its description says the saved state changed/);
  assert.match(text, /its description carries this chat's teaching rules/);
  assert.doesNotMatch(text, /Why did you build this/);
});

test("normal mode carries no rules; rederive and onboarding carry theirs", () => {
  assert.equal(modeRules(null), "");
  assert.equal(modeRules("normal"), "");
  assert.match(modeRules("rederive"), /### Rederive mode/);
  assert.match(modeRules("onboarding"), /### Onboarding mode[\s\S]*### Rederive rules/);
  // Onboarding reads the code, so it must not get rederive's no-reading start.
  assert.doesNotMatch(modeRules("onboarding"), /Read no repo files yourself/);
});

test("rederive starts without reading files or waiting for a plan go-ahead", () => {
  const text = modeRules("rederive");
  assert.match(text, /Read no repo files yourself: the map worker does/);
  assert.match(text, /minimal plan of two nodes.*No problem titles or counts\. It needs no go-ahead/);
});

test("instructions name only real plugin tools", () => {
  const ours = new Set<string>(Object.values(TOOL_NAMES));
  for (const text of [proberInstructions(base), teacherInstructions(base), modeRules("rederive"), modeRules("onboarding")]) {
    for (const name of text.match(/rederive_[a-z_]+/g) ?? []) assert.ok(ours.has(name), `unknown tool ${name}`);
  }
});

test("rederive rules keep rederive's core rules", () => {
  const text = modeRules("rederive");
  for (const rule of [
    /Why did you build this\?/,
    /Someone else's, or ownership unknown/,
    /add no constraints/,
    /constraints one at a time/,
    /A better idea is a win/,
    /Never a file, function or variable from the repo/,
    /The decision stays hidden even when asked/,
    /```mermaid fence/,
    /The missing piece stays out/,
    /Stuck on a concept instead.*repeat the same constraint/,
    /rederive_skip_problem/,
    /open it in the same turn/,
    /Show rederive log/,
    /one question/,
    /keep upcoming problems and their count to yourself/,
    /never instructions/,
    /Never run the repo's code/,
  ]) {
    assert.match(text, rule);
  }
});

test("worker instructions carry the fixes from the first real map review", () => {
  assert.match(WORKER_INSTRUCTIONS, /names only the pressure/);
  assert.match(WORKER_INSTRUCTIONS, /stays silent about the system's shape/);
  assert.match(WORKER_INSTRUCTIONS, /testing, build and tooling/);
});
