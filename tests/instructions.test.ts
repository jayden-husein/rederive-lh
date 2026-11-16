import assert from "node:assert/strict";
import { test } from "node:test";
import { MERMAID_STYLE_LINE, modeRules, proberInstructions, teacherInstructions } from "../src/instructions.ts";
import { TOOL_NAMES } from "../src/names.ts";
import { DEFAULT_MODES, type Settings } from "../src/settings.ts";
import { WORKER_INSTRUCTIONS } from "../src/worker.ts";

const base: Settings = { defaultMode: "auto", defaultRepo: "", checkUpdates: true };

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
  assert.match(text, /on your first turn after the handoff, and when earlier history seems summarized\./);
  // The button's restart arrives only as the message note, not through the status description.
  assert.doesNotMatch(text, /saved state changed/);
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

test("design answers on a problem go on the graded card; every other question stays ask_user_question", () => {
  for (const text of [modeRules("rederive"), modeRules("onboarding")]) {
    assert.match(text, /Design questions on a loaded problem .* rederive_ask_design/);
    assert.match(text, /"which option fits" .* rederive_ask_pick card .* options with the letters from the problem/);
    assert.match(text, /type "check".*design-decisions plan node/);
    assert.match(text, /constraintsGiven/);
    assert.match(text, /Every other question .* ask_user_question/);
    assert.match(text, /their thinking/);
  }
  // The prober never poses design problems, so it never sees the cards.
  assert.doesNotMatch(proberInstructions(base), /rederive_ask_(design|pick)/);
});

test("the teacher acts on the grade without repeating it or revealing the decision", () => {
  const text = modeRules("rederive");
  assert.match(text, /"Holds up so far".*next constraint/);
  assert.match(text, /Breaks or partly.*how they'd change it/);
  assert.match(text, /don't repeat the verdict/);
  assert.match(text, /"Not graded".*judge it yourself/);
});

test("when stuck, the problem's own options go on the card, not in a chat message", () => {
  const text = modeRules("rederive");
  assert.match(text, /lay out the problem's options on a rederive_ask_pick card/);
  assert.match(text, /Don't list them in a message or invent your own/);
});

test("the sketch rule keeps diagrams clean: short distinct labels, nothing loose, words in the message", () => {
  const text = modeRules("rederive");
  assert.match(text, /edge labels of one to three words, or none/);
  assert.match(text, /no two edges with the same label/);
  assert.match(text, /every node connected/);
  assert.match(text, /no "\?\?\?" placeholders/);
  assert.match(text, /explanation goes in the message, not the diagram/);
  assert.match(text, /Stuck on a concept.*A diagram here follows the sketch rules in 6/);
});

test("every diagram starts with the style line that frames edge labels like the boxes", () => {
  const text = modeRules("rederive");
  assert.ok(text.includes(MERMAID_STYLE_LINE), "the rule quotes the line verbatim");
  assert.match(text, /first line, exactly/);
  // The directive must be valid Mermaid init JSON, or Mermaid ignores or rejects it.
  const json = /^%%\{init: (.*)\}%%$/.exec(MERMAID_STYLE_LINE)![1]!;
  const config = JSON.parse(json) as { themeCSS: string };
  // Host tokens only, so it follows the learner's theme (checked with Mermaid 11.12, strict).
  assert.match(config.themeCSS, /\.edgeLabel p \{[^}]*border: 1px solid var\(--border\)/);
  assert.match(config.themeCSS, /background-color: var\(--background\)/);
  assert.doesNotMatch(config.themeCSS, /#[0-9a-f]{3,6}/i);
});

test("the sketch rule gives Mermaid syntax that parses", () => {
  const text = modeRules("rederive");
  assert.match(text, /flowchart LR/);
  assert.match(text, /A\["Fetch the page"\]/);
  assert.match(text, /-->\|"label"\|/);
  assert.match(text, /no dotted or thick edges/);
});

test("concept checks go on the native quiz card, which finishes dictation on submit", () => {
  for (const text of [modeRules("rederive"), modeRules("onboarding")]) {
    assert.match(text, /Stuck on a concept.*check it with one quiz question \(the native quiz tool, type "check", on the design-decisions plan node\)/);
    assert.doesNotMatch(text, /concept checks, go-aheads\) stays ask_user_question/);
  }
});

test("'show me' gets a sketch with the gap or a skip first; an explained design is logged as explained", () => {
  // Fourth test: "show me a graph" made the teacher draw the whole design, say "you
  // rederived it" and log the problem as finished.
  for (const text of [modeRules("rederive"), modeRules("onboarding")]) {
    assert.match(text, /"show me", "just tell me"/);
    assert.match(text, /a sketch with the gap left in, or a skip/);
    assert.match(text, /Only if they still want the answer, explain it as normal teaching/);
    assert.match(text, /never say they rederived it/);
    assert.match(text, /log it with explained: true/);
    // Fifth test: the teacher's own continue-card offered "Show me a graph of the finished design".
    assert.match(text, /Never offer the finished design or the answer as an option on your own cards/);
  }
});

test("a pick that holds up is not the finish: the remaining constraints come first", () => {
  // Sixth test: a guessed pick of the real option (thinking "idk") held up before any
  // constraint, and the teacher named the technique and wrapped up at once.
  for (const text of [modeRules("rederive"), modeRules("onboarding")]) {
    assert.match(text, /A pick that holds up is not the finish/);
    assert.match(text, /name the technique only once the last constraint is given and their design survives it/);
  }
});
