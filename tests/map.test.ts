import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { DecisionMapResultSchema, renderMapMarkdown, validateMapResult, type StoredMap } from "../src/map.ts";
import { sampleMapResult } from "./helpers.ts";

test("a well-formed result passes the schema and the semantic checks", () => {
  const result = sampleMapResult(5);
  assert.equal(Value.Check(DecisionMapResultSchema, result), true);
  assert.doesNotThrow(() => validateMapResult(result));
});

test("the schema enforces 5 to 10 decisions and 2 to 4 options", () => {
  assert.equal(Value.Check(DecisionMapResultSchema, sampleMapResult(4)), false);
  assert.equal(Value.Check(DecisionMapResultSchema, sampleMapResult(11)), false);
  const oneOption = sampleMapResult(5);
  oneOption.decisions[0]!.options.pop();
  assert.equal(Value.Check(DecisionMapResultSchema, oneOption), false);
});

test("ids must run D1..Dn in order, with feedback naming the fix", () => {
  const result = sampleMapResult(5);
  result.decisions[2]!.id = "D4";
  assert.throws(() => validateMapResult(result), /decisions\[2\]\.id is "D4".*must be "D3"/);
});

test("two decisions with the same technique are rejected", () => {
  const result = sampleMapResult(5);
  result.decisions[3]!.decision.technique = "Technique 1";
  assert.throws(() => validateMapResult(result), /D4 and D1 have the same technique/);
});

test("map.md follows rederive's layout", () => {
  const map: StoredMap = {
    version: 1, repoName: "tiny-search", builtFrom: "abc1234", builtAt: "2026-11-14T10:00:00.000Z", taskId: "t",
    ...sampleMapResult(5),
  };
  const md = renderMapMarkdown(map);
  assert.match(md, /^# Decision map\nrepo: tiny-search \| built from: abc1234 \| date: 2026-11-14\nroot problem: Finding pages/);
  assert.match(md, /## D1\. Problem 1\n- Problem: .*\n- Given: .*\n- Constraints, in order:\n {2}1\. Constraint 1 -> breaks: the naive design\n- Decision: technique 1: /);
  assert.match(md, /- Evidence: code only\n$/);
});

test("files must be repo-relative", () => {
  const result = sampleMapResult(5);
  result.decisions[3]!.files = ["../outside.c", "C:/abs.c", "ok/file.c"];
  assert.throws(() => validateMapResult(result), (error: Error) => {
    assert.match(error.message, /D4\.files has "\.\.\/outside\.c"/);
    assert.match(error.message, /D4\.files has "C:\/abs\.c"/);
    assert.doesNotMatch(error.message, /ok\/file\.c/);
    return true;
  });
});

test("the worker must give files, but maps built before them still load", () => {
  const missing = sampleMapResult(5) as { decisions: Record<string, unknown>[] };
  delete missing.decisions[0]!.files;
  assert.equal(Value.Check(DecisionMapResultSchema, missing), false);
  const old = sampleMapResult(5) as { decisions: Record<string, unknown>[] };
  for (const d of old.decisions) {
    delete d.files;
  }
  assert.doesNotThrow(() => validateMapResult(old));
});

test("each decision marks exactly one real option, and every other option says where it fails", () => {
  const noReal = sampleMapResult(5);
  noReal.decisions[1]!.options[0]!.real = false;
  assert.throws(() => validateMapResult(noReal), /D2 must mark exactly one option real: true/);

  const twoReal = sampleMapResult(5);
  twoReal.decisions[1]!.options[1]!.real = true;
  assert.throws(() => validateMapResult(twoReal), /D2 must mark exactly one option real: true/);

  const noFailsAt = sampleMapResult(5) as { decisions: { options: Record<string, unknown>[] }[] };
  delete noFailsAt.decisions[2]!.options[1]!.failsAt;
  assert.throws(() => validateMapResult(noFailsAt), /D3 option 2 is not real, so it needs failsAt/);

  const pastEnd = sampleMapResult(5);
  pastEnd.decisions[2]!.options[1]!.failsAt = 2; // only one constraint
  assert.throws(() => validateMapResult(pastEnd), /D3 option 2 has failsAt 2, but D3 has 1 constraint/);

  const bareProblem = sampleMapResult(5);
  bareProblem.decisions[2]!.options[1]!.failsAt = 0;
  assert.doesNotThrow(() => validateMapResult(bareProblem));
});

test("the worker must mark options, but maps built before step 9 still load", () => {
  const unmarked = sampleMapResult(5) as { decisions: { options: Record<string, unknown>[] }[] };
  for (const d of unmarked.decisions) for (const o of d.options) {
    delete o.real;
    delete o.failsAt;
  }
  assert.equal(Value.Check(DecisionMapResultSchema, unmarked), false);
  assert.doesNotThrow(() => validateMapResult(unmarked));
});

test("map.md marks the real option and where the others fail", () => {
  const map: StoredMap = {
    version: 1, repoName: "tiny-search", builtFrom: null, builtAt: "2026-11-14T10:00:00.000Z", taskId: "t",
    ...sampleMapResult(5),
  };
  const md = renderMapMarkdown(map);
  assert.match(md, / {2}- real approach: good \(real\)\n {2}- other approach: worse \(fails at constraint 1\)/);
});
