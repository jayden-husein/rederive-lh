import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { SessionStore } from "../src/sessions.ts";
import { removeDir, tempDir } from "./helpers.ts";

let data: string;

beforeEach(() => {
  data = tempDir("sessions");
});

afterEach(() => removeDir(data));

const repo = { id: "tiny-abc123", name: "tiny", kind: "local" as const, source: "C:\\tiny", path: "C:\\tiny" };

test("a fresh store reports nothing and creates no file", async () => {
  const store = new SessionStore(data);
  assert.deepEqual(await store.getChat("chat-1"), { mode: null, repo: null });
  assert.equal(existsSync(store.file), false);
});

test("mode and repo persist per chat and survive a new store instance", async () => {
  const store = new SessionStore(data);
  await store.setMode("chat-1", "rederive");
  await store.setRepo("chat-1", repo);
  await store.setMode("chat-2", "normal");

  const reopened = new SessionStore(data);
  const one = await reopened.getChat("chat-1");
  assert.equal(one.mode, "rederive");
  assert.equal(one.repo?.id, repo.id);
  assert.deepEqual(await reopened.getChat("chat-2"), { mode: "normal", repo: null });

  const file = JSON.parse(readFileSync(join(data, "sessions.json"), "utf8"));
  assert.equal(file.version, 1);
  assert.equal(file.repos[repo.id].path, repo.path);
});

test("concurrent writes are serialized without losing updates", async () => {
  const store = new SessionStore(data);
  await Promise.all(
    Array.from({ length: 25 }, (_, i) => store.setMode(`chat-${i}`, i % 2 ? "onboarding" : "rederive")),
  );
  const file = JSON.parse(readFileSync(store.file, "utf8"));
  assert.equal(Object.keys(file.chats).length, 25);
  // No temp files left behind.
  assert.deepEqual(readdirSync(data).filter((f) => f.endsWith(".tmp")), []);
});

test("returned records are copies, not live cache entries", async () => {
  const store = new SessionStore(data);
  const saved = await store.setRepo("chat-1", repo);
  saved.name = "mutated";
  assert.equal((await store.getChat("chat-1")).repo?.name, "tiny");
});

test("a corrupt sessions.json is moved aside, not overwritten", async () => {
  writeFileSync(join(data, "sessions.json"), "{ not json");
  const store = new SessionStore(data, () => new Date("2026-01-02T03:04:05.000Z"));
  assert.deepEqual(await store.getChat("chat-1"), { mode: null, repo: null });
  const backup = join(data, "sessions.json.corrupt-2026-01-02T03-04-05-000Z");
  assert.equal(readFileSync(backup, "utf8"), "{ not json");
  await store.setMode("chat-1", "normal");
  assert.equal(JSON.parse(readFileSync(store.file, "utf8")).chats["chat-1"].mode, "normal");
});
