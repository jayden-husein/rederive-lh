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
