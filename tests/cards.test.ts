import assert from "node:assert/strict";
import { test } from "node:test";
import { cardText, RENDERED_TOOLS } from "../src/cards.ts";
import { sampleMapResult } from "./helpers.ts";

const done = (toolName: string, output: unknown, extra: object = {}) => cardText({ toolName, state: "output-available", output, ...extra });

test("each tool gets a short fixed card", () => {
  assert.equal(done("rederive_set_mode", { mode: "onboarding" }), "Mode: Onboarding");
  assert.equal(done("rederive_status", { mode: "rederive" }), "Checked rederive progress");
  assert.equal(done("rederive_build_map", {}), "Building the decision map in the background…");
  assert.equal(done("rederive_build_map", { count: 6 }, { background: {} }), "Decision map ready");
  assert.equal(done("rederive_build_map", { status: "failed" }, { background: {} }), "Decision map failed");
  assert.equal(done("rederive_next_problem", { id: "D3", state: "loaded", revisit: false }), "Problem loaded");
  assert.equal(done("rederive_next_problem", { id: "D3", state: "loaded", revisit: true }), "Back to a skipped problem");
  assert.equal(done("rederive_next_problem", { id: null, state: "all-done" }), "Every problem done");
  assert.equal(done("rederive_log_problem", { id: "D1", skipped: false }), "Progress logged");
  assert.equal(done("rederive_log_problem", { id: "D1", skipped: true }), "Problem skipped for now");
  assert.equal(cardText({ toolName: "rederive_next_problem", state: "output-error" }), "Couldn't load a problem");
});

test("no card ever shows problem ids, counts or map content", () => {
  const map = sampleMapResult();
  const leaky = { ...map, ...map.decisions[0], id: "D7", count: 9, nextProblemId: "D8", text: "technique 1" };
  for (const toolName of RENDERED_TOOLS) {
    for (const state of ["input-available", "output-available", "output-error"] as const) {
      for (const background of [undefined, {}]) {
        const card = cardText({ toolName, state, output: leaky, ...(background ? { background: background as never } : {}) });
        assert.doesNotMatch(card, /D\d|\d|technique|Constraint|Problem 1/, `${toolName} ${state}: ${card}`);
      }
    }
  }
});
