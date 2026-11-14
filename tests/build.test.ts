// Builds the real package once, then checks the runtime layout and the backend's
// registrations through a fake host context.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { before, test } from "node:test";
import { removeDir, tempDir } from "./helpers.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

before(() => {
  execFileSync(process.execPath, [join(root, "scripts", "build.ts")], { cwd: root, stdio: "pipe" });
});

test("dist has the runtime layout LearnHarness expects", () => {
  for (const file of ["manifest.json", "backend.cjs", "main.js"]) {
    assert.ok(existsSync(join(dist, file)), `missing dist/${file}`);
  }
  assert.equal(existsSync(join(dist, "data")), false);
});

test("manifest matches the plugin id and package version", () => {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8"));
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.apiVersion, 1);
  assert.equal(manifest.id, "rederive-lh");
  assert.equal(manifest.version, pkg.version);
  assert.match(manifest.minAppVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.main, "main.js");
  assert.equal(manifest.backend, "backend.cjs");
});

test("frontend bundle is an ES module exporting activate", () => {
  const source = readFileSync(join(dist, "main.js"), "utf8");
  assert.match(source, /export\s*\{[^}]*\bactivate\b/);
});

test("backend registers the worker, tools, instructions and frontend operations", async () => {
  const backend = createRequire(import.meta.url)(join(dist, "backend.cjs"));
  assert.equal(typeof backend.activate, "function");

  const registrations: { agents: string[]; create: (c: object) => any[] }[] = [];
  const workers: { id: string; tools?: unknown; validateResult?: unknown }[] = [];
  const instructions: { agents: string[]; text: string; active: boolean }[] = [];
  const handlers = new Map<string, (input: unknown) => unknown>();
  const controller = new AbortController();
  const data = tempDir("build-backend");
  await backend.activate({
    signal: controller.signal,
    dataDirectory: data,
    registerTools: (r: any) => registrations.push(r),
    registerInstructions: (r: { agents: string[]; text: string }) => {
      const entry = { ...r, active: true };
      instructions.push(entry);
      return () => (entry.active = false);
    },
    handle: (name: string, fn: (input: unknown) => unknown) => (handlers.set(name, fn), () => {}),
    workers: { register: (d: any) => (workers.push(d), () => {}), list: () => [] },
    inference: { catalog: async () => ({ slots: { cheap: null } }) },
    createBackgroundTool: (_c: object, d: { name: string }) => ({ ...d, execute: async () => ({}) }),
  });

  const active = () => instructions.filter((i) => i.active);
  assert.deepEqual(active().map((i) => i.agents), [["prober"], ["teacher"]]);
  assert.match(active()[0]!.text, /Pick the mode from the learner's words/);
  assert.deepEqual([...handlers.keys()].sort(), ["clear-start", "get-log", "get-settings", "pending-start", "save-settings", "start-rederive"]);
  assert.deepEqual(await handlers.get("get-log")!({ chatId: "c" }), { repoName: null, path: null, text: "", archived: [] });
  assert.equal(await handlers.get("pending-start")!({ chatId: "c" }), null);
  await assert.rejects(Promise.resolve(handlers.get("clear-start")!({ chatId: "c" })), /stamp is required/);

  // Saving settings swaps the instructions for ones that follow the new default mode.
  assert.deepEqual(await handlers.get("get-settings")!(undefined), { defaultMode: "auto", defaultRepo: "" });
  await handlers.get("save-settings")!({ defaultMode: "never", defaultRepo: "" });
  assert.equal(active().length, 2);
  assert.match(active()[0]!.text, /set this plugin to manual/);
  await assert.rejects(Promise.resolve(handlers.get("save-settings")!({ defaultMode: "sometimes" })), /defaultMode must be one of/);

  // The action handler validates before touching anything.
  const start = handlers.get("start-rederive")!;
  await assert.rejects(Promise.resolve(start({ chatId: "c", source: "  " })), /Enter a folder path or git URL/);
  await assert.rejects(Promise.resolve(start({ source: "C:\\x" })), /chat id is required/);
  await assert.rejects(Promise.resolve(start({ chatId: "c", source: join(data, "missing") })), /Folder not found/);
  removeDir(data);

  assert.deepEqual(workers.map((w) => w.id), ["build-map"]);
  assert.equal(typeof workers[0]!.tools, "function");
  assert.equal(typeof workers[0]!.validateResult, "function");

  assert.equal(registrations.length, 1);
  const registration = registrations[0]!;
  assert.deepEqual(registration.agents, ["prober", "teacher"]);
  // A chat with no repo gets only the routing tools; tools.test.ts covers the full set.
  const names = registration.create({ chatId: "chat-1", agent: "teacher" }).map((t) => t.name);
  assert.deepEqual(names, ["rederive_open_repo", "rederive_set_mode", "rederive_status", "rederive_set_authorship", "rederive_build_map"]);
  controller.abort();
});

test("frontend registers the tool cards, settings rows and the top-bar action", async () => {
  const frontend = await import(pathToFileURL(join(dist, "main.js")).href);
  const renderers: string[] = [];
  const actions: { id: string; shortcut?: { defaultBinding?: string } }[] = [];
  const placements: { actionId: string; location: string; sessions?: string[] }[] = [];
  let settingsRows: { key: string }[] = [];
  const interceptors: { id: string }[] = [];
  frontend.activate({
    signal: new AbortController().signal,
    registerToolRenderer: (r: { toolName: string }) => (renderers.push(r.toolName), () => {}),
    registerAction: (a: any) => (actions.push(a), () => {}),
    placeAction: (p: any) => (placements.push(p), () => {}),
    registerSettings: (s: { rows: { key: string }[] }) => ((settingsRows = s.rows), { update: () => {}, dispose: () => {} }),
    registerSubmissionInterceptor: (i: { id: string }) => (interceptors.push(i), () => {}),
    call: async () => ({ defaultMode: "auto", defaultRepo: "" }),
    onResync: () => () => {},
  });
  assert.deepEqual(interceptors.map((i) => i.id), ["rederive-restart-note"]);
  assert.deepEqual(renderers.sort(), [
    "rederive_build_map",
    "rederive_log_problem",
    "rederive_next_problem",
    "rederive_set_authorship",
    "rederive_set_mode",
    "rederive_skip_problem",
    "rederive_status",
  ]);
  assert.deepEqual(settingsRows.map((r) => r.key), ["defaultMode", "defaultRepo"]);
  assert.deepEqual(actions.map((a) => [a.id, a.shortcut?.defaultBinding]), [["rederive-repo", "mod+shift+r"], ["rederive-log", undefined]]);
  assert.deepEqual(placements.map((p) => [p.actionId, p.location, p.sessions]), [
    ["rederive-repo", "top-bar", ["teaching"]],
    ["rederive-log", "top-bar", ["teaching"]],
  ]);
});

test("after the button, the next teaching message gets the restart note, cleared once accepted", async () => {
  const frontend = await import(pathToFileURL(join(dist, "main.js")).href);
  let interceptor: any;
  const calls: [string, any][] = [];
  let pending: object | null = { repoName: "dali-challenge", stamp: "s1" };
  let failLookup = false;
  frontend.activate({
    signal: new AbortController().signal,
    registerToolRenderer: () => () => {},
    registerAction: () => () => {},
    placeAction: () => () => {},
    registerSettings: () => ({ update: () => {}, dispose: () => {} }),
    registerSubmissionInterceptor: (i: any) => ((interceptor = i), () => {}),
    call: async (name: string, input: any) => {
      calls.push([name, input]);
      if (name === "pending-start") {
        if (failLookup) throw new Error("backend down");
        return pending;
      }
      return name === "get-settings" ? { defaultMode: "auto", defaultRepo: "" } : null;
    },
    onResync: () => () => {},
  });
  const accepted: (() => unknown)[] = [];
  const context = (sessionKind = "teaching") => ({
    sessionId: "chat-1",
    sessionKind,
    signal: new AbortController().signal,
    onAccepted: (cb: () => unknown) => accepted.push(cb),
  });
  const message = { type: "text", content: { text: "start", images: [] } };

  const out = await interceptor.intercept(message, context());
  assert.equal(out.content.text, "(Rederive this repo: start fresh with dali-challenge.)\n\nstart");
  assert.equal(calls.some(([n]) => n === "clear-start"), false, "not cleared before acceptance");
  await accepted[0]!();
  assert.deepEqual(calls.at(-1), ["clear-start", { chatId: "chat-1", stamp: "s1" }]);

  // Practice chats, other submission types, no pending start, or a failed lookup: unchanged.
  assert.equal(await interceptor.intercept(message, context("practice")), undefined);
  assert.equal(await interceptor.intercept({ type: "answer" }, context()), undefined);
  pending = null;
  assert.equal(await interceptor.intercept(message, context()), undefined);
  failLookup = true;
  assert.equal(await interceptor.intercept(message, context()), undefined);
});

test("frontend bundle contains no Node-only modules", () => {
  const source = readFileSync(join(dist, "main.js"), "utf8");
  assert.doesNotMatch(source, /node:|require\(/);
});
