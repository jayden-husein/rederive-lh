// Builds the real package once, then checks the runtime layout and the backend's
// registrations through a fake host context.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { before, test } from "node:test";

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

test("backend registers a working echo tool for prober and teacher", async () => {
  const backend = createRequire(import.meta.url)(join(dist, "backend.cjs"));
  assert.equal(typeof backend.activate, "function");

  const registrations: { agents: string[]; create: (c: object) => any[] }[] = [];
  const controller = new AbortController();
  backend.activate({ signal: controller.signal, registerTools: (r: any) => registrations.push(r) });

  assert.equal(registrations.length, 1);
  const registration = registrations[0]!;
  assert.deepEqual(registration.agents, ["prober", "teacher"]);

  const [tool] = registration.create({ chatId: "chat-1", agent: "teacher" });
  assert.equal(tool.name, "rederive_echo");
  const result = await tool.execute("call-1", { text: "hello" }, new AbortController().signal);
  assert.deepEqual(result.content, [{ type: "text", text: "Rederive echo: hello" }]);
  assert.deepEqual(result.details, { text: "hello", chatId: "chat-1", agent: "teacher" });

  controller.abort();
  await assert.rejects(tool.execute("call-2", { text: "x" }), /cancelled/);
});
