import assert from "node:assert/strict";
import { test } from "node:test";
import { decisionFiles, isRepoRelative, normalizePart, planProblems, tagDecision } from "../src/authorship.ts";
import type { Decision } from "../src/map.ts";

type D = Pick<Decision, "id" | "files" | "decision" | "evidence">;

function d(id: string, files: string[] | undefined, inThisCode = "", evidence = "code only"): D {
  return { id, ...(files ? { files } : {}), decision: { technique: id, definition: "", inThisCode }, evidence };
}

// Shaped like cs50final's map: crawler, page directory, index, querier.
const cs50 = [
  d("D1", ["crawler/crawler.c"]),
  d("D2", ["common/pagedir.c"]),
  d("D3", ["common/index.c", "indexer/indexer.c"]),
  d("D4", ["common/index.c", "indexer/indextest.c"]),
  d("D5", ["querier/querier.c"]),
  d("D6", ["querier/querier.c"]),
  d("D7", ["querier/querier.c", "common/pagedir.c"]),
];

const ids = (plan: { decision: D }[]) => plan.map((p) => p.decision.id);

test("parts normalize to forward slashes with no leading ./ or trailing /", () => {
  assert.equal(normalizePart(" .\\querier\\ "), "querier");
  assert.equal(normalizePart("/common//index.c"), "common/index.c");
  assert.equal(normalizePart("`indexer/`"), "indexer");
  assert.equal(normalizePart("."), "");
  assert.equal(normalizePart("./"), "");
});

test("a problem is theirs when all its files are in their parts, partner's when none are, shared otherwise", () => {
  const parts = ["querier/"];
  assert.equal(tagDecision(cs50[4]!, parts), "theirs");
  assert.equal(tagDecision(cs50[0]!, parts), "partner");
  assert.equal(tagDecision(cs50[6]!, parts), "shared");
  // Case and slashes don't matter; a single file counts as a part.
  assert.equal(tagDecision(cs50[2]!, ["Indexer", "common\\index.c"]), "theirs");
  // A folder that holds one of their files is mixed.
  assert.equal(tagDecision(d("D1", ["common/"]), ["common/index.c"]), "shared");
  // "." is the whole repo.
  assert.equal(tagDecision(cs50[0]!, ["."]), "theirs");
  // A name prefix is not a folder match.
  assert.equal(tagDecision(d("D1", ["querier2/q.c"]), ["querier"]), "partner");
});

test("older maps without files fall back to paths in inThisCode and evidence, or unknown", () => {
  const old = d("D3", undefined, "common/index.c nests counters. indexer/indexer.c builds it.", "abc123 add indexer/");
  assert.deepEqual(decisionFiles(old), ["common/index.c", "indexer/indexer.c", "indexer/"]);
  assert.equal(tagDecision(old, ["indexer/", "common/"]), "theirs");
  // Bare file names and function names name no folder: unknown.
  assert.equal(tagDecision(d("D6", undefined, "querier.c runQuery builds a running and-sequence."), ["querier/"]), "unknown");
  assert.deepEqual(decisionFiles(d("D1", undefined, "", "see https://example.com/x")), []);
});

test("without authorship, problems run in map order with no tags", () => {
  const plan = planProblems(cs50, null);
  assert.deepEqual(ids(plan), ["D1", "D2", "D3", "D4", "D5", "D6", "D7"]);
  assert.ok(plan.every((p) => p.tag === null));
});

test("own problems (theirs and shared) come first, then the rest, each in map order", () => {
  // They wrote the querier; D7 shares pagedir with the partner.
  const plan = planProblems(cs50, ["querier/"]);
  assert.deepEqual(ids(plan), ["D5", "D6", "D7", "D1", "D2", "D3", "D4"]);
  assert.deepEqual(plan.map((p) => p.tag), ["theirs", "theirs", "shared", "partner", "partner", "partner", "partner"]);
});

test("own problems keep map order among themselves, and nothing runs twice", () => {
  const plan = planProblems(cs50, ["common/pagedir.c", "querier/"]);
  assert.deepEqual(ids(plan), ["D2", "D5", "D6", "D7", "D1", "D3", "D4"]);
  assert.equal(new Set(ids(plan)).size, plan.length);
});

test("unknown problems are not own: they keep map order after the own ones", () => {
  const map = [d("D1", []), d("D2", ["b/x"])];
  const plan = planProblems(map, ["b"]);
  assert.deepEqual(ids(plan), ["D2", "D1"]);
  assert.equal(plan[1]!.tag, "unknown");
});

test("prose with a slash is not a path; absolute, UNC and .. paths are not repo-relative", () => {
  assert.deepEqual(decisionFiles(d("D1", undefined, "Handles I/O and read/write errors, and/or TCP/IP.")), []);
  for (const bad of ["/abs", String.raw`\\server\share\x`, String.raw`C:\x`, "c:x", "a/../b", String.raw`..\x`]) assert.equal(isRepoRelative(bad), false, bad);
  for (const ok of ["querier/", String.raw`.\querier`, "common/index.c", "."]) assert.equal(isRepoRelative(ok), true, ok);
});
