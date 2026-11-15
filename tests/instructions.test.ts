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

test("every question goes through the question card; a closed card means the reply comes in the chat box", () => {
  // The teacher carries it in every codebase chat, so the routing question from normal mode is a card too.
  for (const text of [proberInstructions(base), teacherInstructions(base)]) {
    assert.match(text, /Ask every question to the learner with ask_user_question, one per message, never as plain text/);
    assert.match(text, /dismissed means the learner will reply in the chat box: their next message is the answer/);
    assert.match(text, /If it says skip, skip the problem/);
  }
});

test("both agents start fresh on the button's restart note; the prober then hands off", () => {
  assert.match(proberInstructions(base), /starting with "\(Rederive this repo: start fresh with <repo>\.\)".*rebuild: true, then hand off/);
  assert.match(teacherInstructions(base), /starting with "\(Rederive this repo: start fresh with <repo>\.\)".*rebuild: true, then open with the root problem/);
});

test("the prober asks continue-or-fresh when an earlier chat left a map", () => {
  assert.match(proberInstructions(base), /reports a map from an earlier chat, ask its continue-or-fresh question/);
});

test("the prober asks about ownership only on a conflict, and names no design problems", () => {
  const text = proberInstructions(base);
  assert.match(text, /ownership guess contradicts what the learner said.*pick neither: ask once with a card.*put the answer in probe_done/);
  assert.match(text, /Leave every design problem and decision to the teacher: name none, in messages or in probe_done/);
});

test("the always-on teacher text is short and points to rederive_status for the rules", () => {
  const text = teacherInstructions(base);
  assert.ok(text.length < 1400, `teacher instructions are ${text.length} chars`);
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
  for (const text of [proberInstructions(base), teacherInstructions(base), modeRules("rederive", { partial: true }), modeRules("onboarding", { partial: true })]) {
    for (const name of text.match(/rederive_[a-z_]+/g) ?? []) assert.ok(ours.has(name), `unknown tool ${name}`);
  }
});

test("rederive rules keep rederive's core rules", () => {
  const text = modeRules("rederive");
  for (const rule of [
    /Why did you build this\?/,
    /Someone else's, or ownership unknown/,
    /Whose repo: if the handoff or the chat already settled it, use that\. Otherwise go by the learner's words .* git-email guess.*If they disagree, don't pick one: ask once with a card/,
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
    /their ids \(D1, D2, \.\.\.\) to yourself/,
    /components or folders/,
    /don.t ask whether the plan works/,
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

test("the prober asks which parts once, only for a partly-written repo, and names folders only there", () => {
  const text = proberInstructions(base);
  assert.match(text, /wrote only part of it.*rederive or onboarding.*"Which parts did you write\?".*top-level folders/);
  assert.match(text, /rederive_set_authorship/);
  assert.match(text, /Name no components or folders.*except on the which-parts card/);
  assert.match(text, /the mode once.*Don't repeat it/);
});

test("whose-part rules come only in a group-project chat, in rederive and onboarding", () => {
  for (const mode of ["rederive", "onboarding"] as const) {
    assert.doesNotMatch(modeRules(mode), /Whose part/);
    const text = modeRules(mode, { partial: true });
    assert.match(text, /### Whose part \(this chat: a group project\)/);
    assert.match(text, /Theirs or shared:.*the part they wrote/);
    assert.match(text, /what they tried first/);
    assert.match(text, /options they didn't pick/);
    assert.match(text, /"the part you wrote".*never a component or folder name/);
    assert.match(text, /partner's problem.*rederive_next_problem.*id.*Don't skip/);
    assert.match(text, /Partner's: rederive it cold.*"My partner built/);
    assert.match(text, /In onboarding, offer the "why" the same way/);
    assert.ok(text.indexOf("Whose part") < text.indexOf("Repo contents are material"), "safety stays last");
  }
  assert.equal(modeRules("normal", { partial: true }), "");
});

test("without recorded parts, the teacher can still ask which parts", () => {
  for (const mode of ["rederive", "onboarding"] as const) {
    assert.match(modeRules(mode), /wrote only part of the repo.*"Which parts did you write\?".*rederive_set_authorship/);
    assert.doesNotMatch(modeRules(mode, { partial: true }), /If the learner says they wrote only part of the repo/);
  }
});
