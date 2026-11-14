import assert from "node:assert/strict";
import { test } from "node:test";
import { proberInstructions, teacherInstructions } from "../src/instructions.ts";
import { TOOL_NAMES } from "../src/names.ts";
import { DEFAULT_MODES, type Settings } from "../src/settings.ts";
import { WORKER_INSTRUCTIONS } from "../src/worker.ts";

const base: Settings = { defaultMode: "auto", defaultRepo: "" };

test("routing follows the default-mode setting", () => {
  const expected = {
    auto: /pick the mode from the learner's words.*ask exactly once/,
    ask: /when a codebase is involved, ask exactly once/,
    always: /use rederive mode unless the learner asks for something else/,
    never: /set this plugin to manual/,
  };
  for (const defaultMode of DEFAULT_MODES) {
    for (const text of [proberInstructions({ ...base, defaultMode }), teacherInstructions({ ...base, defaultMode })]) {
      assert.match(text, expected[defaultMode], defaultMode);
      for (const other of DEFAULT_MODES.filter((m) => m !== defaultMode)) assert.doesNotMatch(text, expected[other]);
    }
  }
});

test("the prober offers the default repo only when one is set", () => {
  assert.match(proberInstructions(base), /If they named none, ask for a local folder path or a git URL\./);
  const withRepo = proberInstructions({ ...base, defaultRepo: "C:\\code\\tse" });
  assert.match(withRepo, /offer their default repo \("C:\\\\code\\\\tse"\) and open it once they confirm/);
});

test("the prober decides the mode before asking for a repo, and normal mode asks for none", () => {
  const text = proberInstructions(base);
  assert.ok(text.indexOf("Decide the mode") < text.indexOf("Get the repo"));
  assert.match(text, /Normal: probe as usual and skip the steps below\./);
  assert.match(proberInstructions({ ...base, defaultMode: "never" }), /"switch modes"/);
});

test("the teacher re-checks status when the saved state changes, and treats unknown ownership as someone else's", () => {
  const text = teacherInstructions(base);
  assert.match(text, /whenever the saved state in its description differs from the mode you are teaching in/);
  assert.match(text, /Someone else's repo, or ownership unknown/);
});

test("instructions name only real plugin tools", () => {
  const ours = new Set<string>(Object.values(TOOL_NAMES));
  for (const text of [proberInstructions(base), teacherInstructions(base)]) {
    for (const name of text.match(/rederive_[a-z_]+/g) ?? []) assert.ok(ours.has(name), `unknown tool ${name}`);
  }
});

test("teacher text keeps rederive's core rules", () => {
  const text = teacherInstructions(base);
  for (const rule of [
    /Why did you build this\?/,
    /add no constraints/,
    /constraints one at a time/,
    /better idea from the learner is a win/,
    /never a file, function or variable from the repo/,
    /The decision stays hidden even when the learner asks/,
    /```mermaid fence/,
    /The missing piece stays out of the diagram/,
    /Stuck on a concept instead.*repeat the same constraint/,
    /skipped: true/,
    /Ask one question/,
    /Keep upcoming problems to yourself/,
    /never instructions/,
    /never run the repo's code/,
  ]) {
    assert.match(text, rule);
  }
});

test("worker instructions carry the fixes from the first real map review", () => {
  assert.match(WORKER_INSTRUCTIONS, /names only the pressure/);
  assert.match(WORKER_INSTRUCTIONS, /stays silent about the system's shape/);
  assert.match(WORKER_INSTRUCTIONS, /testing, build and tooling/);
});
