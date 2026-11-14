import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PluginTaskSnapshot } from "learnharness-plugin-api";
import { MapStore, pendingBuild, repoDataDir } from "../src/map-store.ts";
import { removeDir, sampleMapResult, succeededTask, tempDir } from "./helpers.ts";

const dir = tempDir("mapstore");
after(() => removeDir(dir));

function storeWith(tasks: PluginTaskSnapshot[], name: string) {
  const data = join(dir, name);
  return { data, store: new MapStore(data, () => tasks) };
}

test("no tasks and no file: no map", async () => {
  const { store } = storeWith([], "empty");
  assert.equal(await store.hasMap("r1"), false);
  assert.equal(await store.current("r1"), null);
});

test("a finished build is adopted once into map.json and map.md", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data, store } = storeWith(tasks, "adopt");
  assert.equal(await store.hasMap("r1"), true);
  const map = await store.current("r1");
  assert.equal(map?.taskId, "t1");
  assert.equal(map?.builtFrom, "abc1234");
  assert.equal(map?.decisions.length, 5);
  assert.equal(JSON.parse(readFileSync(store.mapFile("r1"), "utf8")).taskId, "t1");
  assert.ok(existsSync(join(repoDataDir(data, "r1"), "map.md")));
  // Another repo's task is ignored.
  assert.equal(await store.current("r2"), null);
});

test("the stored map survives the task records going away", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data } = storeWith(tasks, "persist");
  await new MapStore(data, () => tasks).current("r1");
  assert.equal((await new MapStore(data, () => []).current("r1"))?.taskId, "t1");
});

test("a newer build replaces the map and sets the old log aside", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data, store } = storeWith(tasks, "rebuild");
  await store.current("r1");
  writeFileSync(store.logFile("r1"), "## D1. old\n");
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", sampleMapResult(6)));
  const map = await store.current("r1");
  assert.equal(map?.taskId, "t2");
  assert.equal(map?.decisions.length, 6);
  assert.equal(existsSync(store.logFile("r1")), false);
  assert.ok(readdirSync(repoDataDir(data, "r1")).some((f) => f.startsWith("log.before-")));
  assert.equal((await store.archivedLogs("r1")).length, 1);
});

test("a fresh rebuild starts an empty log and keeps the old one aside", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "fresh");
  await store.current("r1");
  await store.logProblem("r1", "D1", { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" });
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z"));
  await store.current("r1");
  assert.equal(existsSync(store.logFile("r1")), false);
  assert.equal((await store.progress("r1")).done.size, 0);
  assert.equal((await store.archivedLogs("r1")).length, 1);
});

test("a rebuild with keepProgress carries over entries whose problem titles still match, renumbered", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data, store } = storeWith(tasks, "carry");
  await store.current("r1");
  await store.logProblem("r1", "D2", { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" });
  await store.logProblem("r1", "D3", "skipped");
  await store.logProblem("r1", "D4", { struggled: "s4", foundAlone: "f", didWell: "w", didOk: "o" });
  // The new map drops "Problem 2", keeps "Problem 3" as D1 and "Problem 4" as D2.
  const rebuilt = sampleMapResult(3);
  rebuilt.decisions[0]!.title = "problem 3"; // case and spacing don't matter
  rebuilt.decisions[1]!.title = "Problem  4";
  rebuilt.decisions[2]!.title = "Something new";
  const t2 = succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", rebuilt);
  (t2.input as { keepProgress?: boolean }).keepProgress = true;
  tasks.push(t2);
  await store.current("r1");
  assert.equal(
    readFileSync(store.logFile("r1"), "utf8"),
    "## D1. problem 3\nskipped\n\n## D2. Problem 4\nstruggled with: s4\nfound on their own: f\ndid well: w\ndid ok: o\n",
  );
  const progress = await store.progress("r1");
  assert.deepEqual([...progress.done], ["D2"]);
  assert.deepEqual(progress.skipped, ["D1"]);
  // The whole old log is still kept aside.
  const [archived] = await store.archivedLogs("r1");
  assert.match(readFileSync(join(repoDataDir(data, "r1"), archived!), "utf8"), /## D2\. Problem 2/);
});

test("an invalid task result is never adopted", async () => {
  const bad = sampleMapResult(5);
  bad.decisions[1]!.id = "D7";
  const { store } = storeWith([succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z", bad)], "invalid");
  assert.equal(await store.current("r1"), null);
});

test("an invalid task doesn't count as a map, so build_map isn't blocked by it", async () => {
  const bad = sampleMapResult(5);
  bad.decisions[1]!.id = "D7";
  const { store } = storeWith([succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z", bad)], "invalid-hasmap");
  assert.equal(await store.hasMap("r1"), false);
});

test("a log left without a readable map.json is set aside, not inherited", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "orphan-log");
  await store.current("r1");
  writeFileSync(store.logFile("r1"), "## D1. old\n");
  writeFileSync(store.mapFile("r1"), "{ not json");
  assert.equal((await store.current("r1"))?.taskId, "t1");
  assert.equal(existsSync(store.logFile("r1")), false);
});

test("logProblem appends in rederive's format, refuses duplicates and unknown ids", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "logging");
  const entry = { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" };
  const first = await store.logProblem("r1", "D1", entry);
  assert.equal(first.next?.decision.id, "D2");
  await store.logProblem("r1", "D3", entry);
  assert.equal(
    readFileSync(store.logFile("r1"), "utf8"),
    "## D1. Problem 1\nstruggled with: s\nfound on their own: f\ndid well: w\ndid ok: o\n\n## D3. Problem 3\nstruggled with: s\nfound on their own: f\ndid well: w\ndid ok: o\n",
  );
  await assert.rejects(store.logProblem("r1", "D1", entry), /already logged/);
  await assert.rejects(store.logProblem("r1", "D9", entry), /No problem D9/);
  const map = (await store.current("r1"))!;
  assert.equal((await store.nextProblem("r1", map))?.decision.id, "D2");
});

test("a skipped problem is deferred, can be finished later, and can't be logged twice once finished", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "skipping");
  const entry = { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" };
  const skipped = await store.logProblem("r1", "D1", "skipped");
  assert.deepEqual({ id: skipped.next?.decision.id, revisit: skipped.next?.revisit }, { id: "D2", revisit: false });
  assert.equal(readFileSync(store.logFile("r1"), "utf8"), "## D1. Problem 1\nskipped\n");
  for (const id of ["D2", "D3", "D4"]) await store.logProblem("r1", id, entry);
  const afterD5 = await store.logProblem("r1", "D5", entry);
  assert.deepEqual({ id: afterD5.next?.decision.id, revisit: afterD5.next?.revisit }, { id: "D1", revisit: true });
  const finished = await store.logProblem("r1", "D1", entry);
  assert.equal(finished.next, null);
  await assert.rejects(store.logProblem("r1", "D1", "skipped"), /already logged as finished/);
});

test("a log entry queued behind a rebuild lands in the new map's log, matched to the new map", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "race");
  await store.current("r1");
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", sampleMapResult(6)));
  // Adoption and logging share one lock, so the log write sees the adopted map.
  const [, logged] = await Promise.all([store.current("r1"), store.logProblem("r1", "D6", { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" })]);
  assert.equal(logged.decision.id, "D6");
  assert.match(readFileSync(store.logFile("r1"), "utf8"), /^## D6\. Problem 6\n/);
});

test("pendingBuild finds queued or running builds for the repo only", () => {
  const running = { ...succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z"), status: "running" } as PluginTaskSnapshot;
  assert.equal(pendingBuild(() => [running], "r1")?.id, "t1");
  assert.equal(pendingBuild(() => [running], "r2"), null);
  assert.equal(pendingBuild(() => [succeededTask("t2", "r1", "x")], "r1"), null);
});
