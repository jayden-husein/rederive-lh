import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { analyzeStructure, formatStructure, listRepoFiles } from "../src/structure.ts";
import { removeDir, tempDir } from "./helpers.ts";

let workspace: string;
let project: string;

function write(root: string, files: Record<string, string>): void {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
}

before(() => {
  workspace = tempDir("structure");
  project = join(workspace, "mixed");
  write(project, {
    "package.json": JSON.stringify({ main: "web/index.ts", bin: { tool: "web/cli.js" }, scripts: { build: "tsc" } }),
    "web/index.ts": 'import { db } from "./db";\nimport express from "express";\nimport x from "@scope/pkg/sub";\n',
    "web/db.ts": 'export * from "./models/index";\n',
    "web/models/index.ts": "export const db = 1;\n",
    "web/cli.js": 'const db = require("./db.ts");\n',
    "web/types.d.ts": 'import "./db";\n',
    "node_modules/express/index.js": "module.exports = 1;\n",
    "py/app.py": "from .store import save\nimport requests, os.path\nfrom pkg import mod\nif __name__ == '__main__':\n    save()\n",
    "py/store.py": "def save(): pass\n",
    "py/__init__.py": "",
    "pkg/__init__.py": "",
    "pkg/mod.py": "",
    "go.mod": "module example.com/svc\n\ngo 1.22\n",
    "cmd/main.go": 'package main\n\nimport (\n\t"fmt"\n\t"example.com/svc/store"\n)\n\nfunc main() { fmt.Println(store.X) }\n',
    "store/store.go": "package store\n\nvar X = 1\n",
    "store/store_test.go": 'package store\n\nimport "example.com/svc/cmd"\n',
    "src/main.rs": "mod parser;\nuse crate::lexer::Token;\nuse serde::Serialize;\nfn main() {}\n",
    "src/parser.rs": "use std::io;\n",
    "src/lexer.rs": "",
    ".hidden/secret.c": '#include "x.h"\n',
  });
});

after(() => removeDir(workspace));

function edgesOf(data: Awaited<ReturnType<typeof analyzeStructure>>, src: string): string[] {
  return [...(data.edges.get(src) ?? [])].sort();
}

test("walks non-git folders, skipping dot folders and noise", async () => {
  const files = await listRepoFiles(project);
  assert.ok(files.includes("web/index.ts"));
  assert.ok(!files.some((f) => f.startsWith(".hidden/")));
  assert.ok(!files.some((f) => f.startsWith("node_modules/")), "noise folders are skipped during the walk, before its file limit");
  const data = await analyzeStructure(realpathSync.native(project), { files });
  assert.ok(!data.sources.some((f) => f.startsWith("node_modules/") || f.endsWith(".d.ts")));
});

test("resolves JS/TS, Python, Go and Rust imports like structure.py", async () => {
  const data = await analyzeStructure(realpathSync.native(project));
  assert.deepEqual(edgesOf(data, "web/index.ts"), ["web/db.ts"]);
  assert.deepEqual(edgesOf(data, "web/db.ts"), ["web/models/index.ts"]);
  assert.deepEqual(edgesOf(data, "web/cli.js"), ["web/db.ts"]);
  assert.deepEqual(edgesOf(data, "py/app.py"), ["pkg/mod.py", "py/store.py"]);
  assert.deepEqual(edgesOf(data, "cmd/main.go"), ["store/store.go"]);
  assert.deepEqual(edgesOf(data, "src/main.rs"), ["src/lexer.rs", "src/parser.rs"]);
  assert.equal(data.edges.has("store/store_test.go"), false, "tests are left out of the graph");
  for (const pkg of ["express", "@scope/pkg", "requests", "fmt", "serde"]) {
    assert.ok(data.external.has(pkg), `missing external ${pkg}`);
  }
  assert.equal(data.external.has("std"), false);
});

test("an import of ./b.js finds b.ts, as TypeScript's Node-style modules write it", async () => {
  const esm = join(workspace, "esm");
  write(esm, {
    "src/a.ts": 'import { b } from "./b.js";\nimport "./c.mjs";\n',
    "src/b.ts": "export const b = 1;\n",
    "src/c.mjs": "export {};\n",
  });
  const data = await analyzeStructure(realpathSync.native(esm));
  assert.deepEqual(edgesOf(data, "src/a.ts"), ["src/b.ts", "src/c.mjs"]);
});

test("an export statement doesn't pair with a quoted 'from' further down the file", async () => {
  const far = join(workspace, "far");
  write(far, { "a.ts": "export const A = 1;\n// taken from './b'\n", "b.ts": "export const B = 2;\n" });
  const data = await analyzeStructure(realpathSync.native(far));
  assert.deepEqual(edgesOf(data, "a.ts"), []);
});

test("entry points come from package.json, names and main functions", async () => {
  const text = formatStructure(await analyzeStructure(realpathSync.native(project)));
  for (const line of [
    "package.json main: web/index.ts",
    "package.json bin tool: web/cli.js",
    "package.json script build: tsc",
    "build file: go.mod",
  ]) {
    assert.ok(text.includes(line), `missing "${line}"`);
  }
  assert.match(text, /^py\/app\.py \(\d+ lines, imported by 0\)$/m);
  assert.match(text, /^cmd\/main\.go \(/m);
  assert.match(text, /^src\/main\.rs \(/m);
});

test("never reads through a link that leaves the repo", async (t) => {
  const outside = join(workspace, "outside");
  write(outside, { "leak.h": "int leaked(void);\n" });
  const repo = join(workspace, "linked");
  write(repo, { "main.c": '#include "leak.h"\nint main(void) { return 0; }\n' });
  try {
    symlinkSync(join(outside, "leak.h"), join(repo, "leak.h"), "file");
  } catch {
    t.skip("creating symlinks needs Developer Mode or admin on Windows");
    return;
  }
  const root = realpathSync.native(repo);
  // Pretend git tracks the link, as it would for a committed symlink.
  const data = await analyzeStructure(root, { files: ["main.c", "leak.h"] });
  assert.equal(data.texts.get("leak.h"), "");
  assert.equal((await listRepoFiles(root)).includes("leak.h"), false, "the walk skips links");
});
