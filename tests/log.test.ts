import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { formatLogEntry, formatSkipEntry, nextProblem, parseLog, readLog } from "../src/log.ts";

const entry = { struggled: "where state lives", foundAlone: "a hash table", didWell: "fast", didOk: "naming" };
const decisions = [{ id: "D1" }, { id: "D2" }, { id: "D3" }];

function logOf(...sections: string[]): string {
  return sections.join("\n");
}
const done = (id: string) => formatLogEntry({ id, title: "t" }, entry);
const skip = (id: string) => formatSkipEntry({ id, title: "t" });

test("an entry uses rederive's log format and omits an empty better idea", () => {
  assert.equal(
    formatLogEntry({ id: "D1", title: "Find pages fast" }, entry),
    "## D1. Find pages fast\nstruggled with: where state lives\nfound on their own: a hash table\ndid well: fast\ndid ok: naming\n",
  );
  assert.match(formatLogEntry({ id: "D1", title: "t" }, { ...entry, betterIdea: "a trie" }), /better idea: a trie\n$/);
});

test("a skip is one heading plus the word skipped", () => {
  assert.equal(formatSkipEntry({ id: "D1", title: "Find pages fast" }), "## D1. Find pages fast\nskipped\n");
});

test("multi-line notes are flattened so they can't fake a heading", () => {
  const text = formatLogEntry({ id: "D1", title: "t" }, { ...entry, didOk: "fine\n## D2. fake" });
  assert.deepEqual([...parseLog(text).done], ["D1"]);
});

test("parseLog separates finished from skipped, and finishing clears a skip", () => {
  const progress = parseLog(logOf(skip("D1"), done("D2"), skip("D3"), done("D1")));
  assert.deepEqual([...progress.done].sort(), ["D1", "D2"]);
  assert.deepEqual(progress.skipped, ["D3"]);
});

test("re-skipping moves a problem to the back of the skipped queue", () => {
  assert.deepEqual(parseLog(logOf(skip("D1"), skip("D2"), skip("D1"))).skipped, ["D2", "D1"]);
});

test("untouched problems come first in map order, not log order", () => {
  assert.equal(nextProblem(decisions, parseLog(""))?.id, "D1");
  assert.equal(nextProblem(decisions, parseLog(logOf(done("D2"), done("D1"))))?.id, "D3");
  assert.equal(nextProblem(decisions, parseLog(logOf(done("D1"), done("D3"))))?.id, "D2");
});

test("skipped problems come back once nothing untouched is left", () => {
  assert.equal(nextProblem(decisions, parseLog(skip("D1")))?.id, "D2");
  assert.equal(nextProblem(decisions, parseLog(logOf(skip("D1"), done("D2"), done("D3"))))?.id, "D1");
  assert.equal(nextProblem(decisions, parseLog(logOf(skip("D3"), skip("D1"), done("D2"))))?.id, "D3");
  assert.equal(nextProblem(decisions, parseLog(logOf(done("D1"), done("D2"), done("D3")))), null);
});

test("a missing log reads as empty", async () => {
  assert.equal(await readLog(join(import.meta.dirname, "no-such-log.md")), "");
});
