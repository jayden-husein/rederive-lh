import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PluginTaskSnapshot } from "learnharness-plugin-api";
import { MapStore, pendingBuild, repoDataDir, type Course, type ReadyCourse, type RecordResult } from "../src/map-store.ts";
import { removeDir, sampleMapResult, succeededTask, tempDir } from "./helpers.ts";

const dir = tempDir("mapstore");
after(() => removeDir(dir));

const entry = { struggled: "s", foundAlone: "f", didWell: "w", didOk: "o" };

function storeWith(tasks: PluginTaskSnapshot[], name: string) {
  const data = join(dir, name);
  return {
    data,
    store: new MapStore(data, () => tasks),
    logFile: (repoId = "r1") => join(repoDataDir(data, repoId), "log.md"),
    mapFile: (repoId = "r1") => join(repoDataDir(data, repoId), "map.json"),
  };
}

function ready(course: Course): ReadyCourse {
  assert.equal(course.state, "ready");
  return course as ReadyCourse;
}

function logged(result: RecordResult) {
  assert.equal(result.state, "logged");
  return result as Extract<RecordResult, { state: "logged" }>;
}

/** Each problem's id and state, in map order. */
function states(course: Course): string[] {
  return ready(course).problems.map((p) => `${p.decision.id}:${p.state}`);
}

test("no tasks and no file: no map, no course, nothing recorded", async () => {
  const { store, logFile } = storeWith([], "empty");
  assert.equal(await store.hasMap("r1"), false);
  assert.equal(await store.current("r1"), null);
  assert.deepEqual(await store.course("r1"), { state: "none" });
  assert.deepEqual(await store.record("r1", "D1", entry), { state: "none" });
  assert.equal(existsSync(logFile()), false);
});

test("a build under way with no map yet: the course and record say building", async () => {
  const running = { ...succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z"), status: "running" } as PluginTaskSnapshot;
  const { store } = storeWith([running], "building");
  assert.deepEqual(await store.course("r1"), { state: "building" });
  assert.deepEqual(await store.record("r1", "D1", "skipped"), { state: "building" });
});

test("a rebuild under way keeps the current map ready and flags building", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "rebuilding");
  assert.equal(ready(await store.course("r1")).building, false);
  tasks.push({ ...succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z"), status: "running" } as PluginTaskSnapshot);
  const course = ready(await store.course("r1"));
  assert.equal(course.map.taskId, "t1");
  assert.equal(course.building, true);
});

test("a finished build is adopted once into map.json and map.md", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data, store, mapFile } = storeWith(tasks, "adopt");
  assert.equal(await store.hasMap("r1"), true);
  const map = await store.current("r1");
  assert.equal(map?.taskId, "t1");
  assert.equal(map?.builtFrom, "abc1234");
  assert.equal(map?.decisions.length, 5);
  assert.equal(JSON.parse(readFileSync(mapFile(), "utf8")).taskId, "t1");
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
  const { data, store, logFile } = storeWith(tasks, "rebuild");
  await store.current("r1");
  writeFileSync(logFile(), "## D1. old\n");
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", sampleMapResult(6)));
  const course = ready(await store.course("r1"));
  assert.equal(course.map.taskId, "t2");
  assert.equal(course.problems.length, 6);
  assert.equal(existsSync(logFile()), false);
  assert.ok(readdirSync(repoDataDir(data, "r1")).some((f) => f.startsWith("log.before-")));
  assert.equal((await store.logView("r1")).archived.length, 1);
});

test("a fresh rebuild starts an empty log and keeps the old one aside", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store, logFile } = storeWith(tasks, "fresh");
  logged(await store.record("r1", "D1", entry));
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z"));
  assert.ok(states(await store.course("r1")).every((s) => s.endsWith(":todo")));
  assert.equal(existsSync(logFile()), false);
  assert.equal((await store.logView("r1")).archived.length, 1);
});

test("a rebuild with keepProgress carries over entries whose problem titles still match, renumbered", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { data, store, logFile } = storeWith(tasks, "carry");
  await store.record("r1", "D2", entry);
  await store.record("r1", "D3", "skipped");
  await store.record("r1", "D4", { ...entry, struggled: "s4" });
  // The new map drops "Problem 2", keeps "Problem 3" as D1 and "Problem 4" as D2.
  const rebuilt = sampleMapResult(3);
  rebuilt.decisions[0]!.title = "problem 3"; // case and spacing don't matter
  rebuilt.decisions[1]!.title = "Problem  4";
  rebuilt.decisions[2]!.title = "Something new";
  const t2 = succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", rebuilt);
  (t2.input as { keepProgress?: boolean }).keepProgress = true;
  tasks.push(t2);
  assert.deepEqual(states(await store.course("r1")), ["D1:skipped", "D2:done", "D3:todo"]);
  assert.equal(
    readFileSync(logFile(), "utf8"),
    "## D1. problem 3\nskipped\n\n## D2. Problem 4\nstruggled with: s4\nfound on their own: f\ndid well: w\ndid ok: o\n",
  );
  // The whole old log is still kept aside.
  const [archived] = (await store.logView("r1")).archived;
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
  const { store, logFile, mapFile } = storeWith(tasks, "orphan-log");
  await store.current("r1");
  writeFileSync(logFile(), "## D1. old\n");
  writeFileSync(mapFile(), "{ not json");
  assert.equal((await store.current("r1"))?.taskId, "t1");
  assert.equal(existsSync(logFile()), false);
});

test("record appends in rederive's format, refuses duplicates and unknown ids", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store, logFile } = storeWith(tasks, "logging");
  const first = logged(await store.record("r1", "D1", entry));
  assert.equal(first.decision.id, "D1");
  assert.equal(first.course.next?.decision.id, "D2");
  await store.record("r1", "D3", entry);
  assert.equal(
    readFileSync(logFile(), "utf8"),
    "## D1. Problem 1\nstruggled with: s\nfound on their own: f\ndid well: w\ndid ok: o\n\n## D3. Problem 3\nstruggled with: s\nfound on their own: f\ndid well: w\ndid ok: o\n",
  );
  await assert.rejects(store.record("r1", "D1", entry), /already logged/);
  await assert.rejects(store.record("r1", "D9", entry), /No problem D9/);
  const course = ready(await store.course("r1"));
  assert.deepEqual(states(course), ["D1:done", "D2:todo", "D3:done", "D4:todo", "D5:todo"]);
  assert.equal(course.next?.decision.id, "D2");
});

test("a skipped problem is deferred, can be finished later, and can't be logged twice once finished", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store, logFile } = storeWith(tasks, "skipping");
  const skipped = logged(await store.record("r1", "D1", "skipped"));
  assert.deepEqual({ id: skipped.course.next?.decision.id, state: skipped.course.next?.state }, { id: "D2", state: "todo" });
  assert.equal(readFileSync(logFile(), "utf8"), "## D1. Problem 1\nskipped\n");
  for (const id of ["D2", "D3", "D4"]) await store.record("r1", id, entry);
  const afterD5 = logged(await store.record("r1", "D5", entry));
  assert.deepEqual({ id: afterD5.course.next?.decision.id, state: afterD5.course.next?.state }, { id: "D1", state: "skipped" });
  const finished = logged(await store.record("r1", "D1", entry));
  assert.equal(finished.course.next, null);
  await assert.rejects(store.record("r1", "D1", "skipped"), /already logged as finished/);
});

test("with parts, own problems come first and are tagged; the log entry records whose part", async () => {
  const result = sampleMapResult(3);
  result.decisions[0]!.files = ["querier/"];
  result.decisions[1]!.files = ["indexer/"];
  result.decisions[2]!.files = ["indexer/", "querier/"];
  const { store, logFile } = storeWith([succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z", result)], "parts");
  const course = ready(await store.course("r1", ["indexer"]));
  assert.deepEqual(course.problems.map((p) => p.tag), ["partner", "theirs", "shared"]);
  assert.equal(course.next?.decision.id, "D2");
  await store.record("r1", "D2", entry, { parts: ["indexer"] });
  assert.match(readFileSync(logFile(), "utf8"), /whose part: theirs\n$/);
  // Without parts there are no tags and no whose-part line.
  assert.deepEqual(ready(await store.course("r1")).problems.map((p) => p.tag), [null, null, null]);
  await store.record("r1", "D1", entry);
  assert.doesNotMatch(readFileSync(logFile(), "utf8").split("## D1.")[1]!, /whose part/);
});

test("a course read alongside a log write sees one log: its states and next agree", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store } = storeWith(tasks, "snapshot");
  await store.course("r1");
  const [before, , afterWrite] = await Promise.all([store.course("r1"), store.record("r1", "D1", entry), store.course("r1")]);
  for (const course of [ready(before), ready(afterWrite)]) {
    const firstTodo = course.problems.find((p) => p.state === "todo");
    assert.equal(course.next?.decision.id, firstTodo?.decision.id);
  }
  assert.equal(ready(before).problems[0]!.state, "todo");
  assert.equal(ready(afterWrite).problems[0]!.state, "done");
});

test("a log entry queued behind a rebuild lands in the new map's log, matched to the new map", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store, logFile } = storeWith(tasks, "race");
  await store.current("r1");
  tasks.push(succeededTask("t2", "r1", "2026-11-14T11:00:00.000Z", sampleMapResult(6)));
  // Adoption and logging share one lock, so the log write sees the adopted map.
  const [, result] = await Promise.all([store.current("r1"), store.record("r1", "D6", entry)]);
  assert.equal(logged(result).decision.id, "D6");
  assert.match(readFileSync(logFile(), "utf8"), /^## D6\. Problem 6\n/);
});

test("logView adopts a finished build first and returns the log with its path", async () => {
  const tasks = [succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z")];
  const { store, logFile } = storeWith(tasks, "logview");
  assert.deepEqual(await store.logView("r1"), { path: logFile(), text: "", archived: [] });
  await store.record("r1", "D1", "skipped");
  assert.equal((await store.logView("r1")).text, "## D1. Problem 1\nskipped\n");
});

test("pendingBuild finds queued or running builds for the repo only", () => {
  const running = { ...succeededTask("t1", "r1", "2026-11-14T10:00:00.000Z"), status: "running" } as PluginTaskSnapshot;
  assert.equal(pendingBuild(() => [running], "r1")?.id, "t1");
  assert.equal(pendingBuild(() => [running], "r2"), null);
  assert.equal(pendingBuild(() => [succeededTask("t2", "r1", "x")], "r1"), null);
});
