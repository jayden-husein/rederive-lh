import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { DEFAULT_SETTINGS, parseSettings, SettingsStore } from "../src/settings.ts";
import { removeDir, tempDir } from "./helpers.ts";

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

function store() {
  const dir = tempDir("settings");
  dirs.push(dir);
  return new SettingsStore(dir);
}

test("new installs default to auto with no default repo and update checks on, and nothing is written", async () => {
  const s = store();
  assert.deepEqual(await s.get(), { defaultMode: "auto", defaultRepo: "", checkUpdates: true });
  assert.equal(existsSync(s.file), false);
});

test("save validates, trims, persists and survives a new store", async () => {
  const s = store();
  const saved = await s.save({ defaultMode: "never", defaultRepo: "  \\\\wsl.localhost\\Ubuntu\\home\\me\\tse  ", checkUpdates: false });
  assert.deepEqual(saved, { defaultMode: "never", defaultRepo: "\\\\wsl.localhost\\Ubuntu\\home\\me\\tse", checkUpdates: false });
  assert.deepEqual(await new SettingsStore(s.file.replace(/[\\/]settings\.json$/, "")).get(), saved);
  assert.deepEqual(JSON.parse(readFileSync(s.file, "utf8")), saved);
});

test("bad input is rejected with a readable message and leaves the saved file alone", async () => {
  const s = store();
  await s.save({ defaultMode: "ask", defaultRepo: "" });
  await assert.rejects(s.save({ defaultMode: "sometimes" }), /defaultMode must be one of auto, ask, always, never/);
  await assert.rejects(s.save({ defaultRepo: 3 }), /defaultRepo must be a string/);
  await assert.rejects(s.save(null), /must be an object/);
  await assert.rejects(s.save({ defaultRepo: "x".repeat(1001) }), /longer than 1000/);
  await assert.rejects(s.save({ checkUpdates: "yes" }), /checkUpdates must be true or false/);
  assert.equal((await s.get()).defaultMode, "ask");
});

test("a default repo with a token in its URL is refused, and one saved earlier is not used", async () => {
  const s = store();
  const withToken = { defaultMode: "auto", defaultRepo: "https://me:ghp_token@github.com/user/x", checkUpdates: true };
  await assert.rejects(s.save(withToken), /holds a password or token/);
  assert.equal(existsSync(s.file), false);
  writeFileSync(s.file, JSON.stringify(withToken));
  assert.equal((await s.get()).defaultRepo, "");
});

test("missing fields fall back to defaults", () => {
  assert.deepEqual(parseSettings({}), DEFAULT_SETTINGS);
  assert.deepEqual(parseSettings({ defaultMode: "always" }), { defaultMode: "always", defaultRepo: "", checkUpdates: true });
});

test("a damaged settings file reads as defaults", async () => {
  const s = store();
  writeFileSync(s.file, "{not json");
  assert.deepEqual(await s.get(), DEFAULT_SETTINGS);
});
