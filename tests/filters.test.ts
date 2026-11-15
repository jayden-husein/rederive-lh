import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { detectVendored, findBinaryFiles, isBuildOutput, vendoredRoot } from "../src/filters.ts";
import { removeDir, tempDir } from "./helpers.ts";

let workspace: string;

before(() => {
  workspace = tempDir("filters");
});

after(() => removeDir(workspace));

test("external/-style folders are always bundled; plain lib/ folders never are", () => {
  const roots = detectVendored([
    "external/zlib/zlib.h", "third_party/x.c", "src/3rdparty/y.c",
    "lib/util.c", "libs/a.c", "library/b.py", "libraries/c.rs", "src/library.c", "libcs50.c", "common/index.c",
  ]);
  assert.deepEqual([...roots].sort(), ["external/", "src/3rdparty/", "third_party/"]);
  assert.equal(vendoredRoot("external/zlib/zlib.h", roots), "external/");
  assert.equal(vendoredRoot("lib/util.c", roots), null);
});

test("lib<name>/ needs evidence: a license or prebuilt library inside", () => {
  const roots = detectVendored([
    "libcs50/mem.c", "libcs50/libcs50-given.a",
    "src/libuv/loop.c", "src/libuv/LICENSE",
    "libparser/parse.c", "libparser/Makefile", "libparser/README.md",
  ]);
  assert.deepEqual([...roots].sort(), ["libcs50/", "src/libuv/"]);
});

test("lib<name>/ needs evidence: history shows it was dropped in and left alone", () => {
  const files = ["libdrop/a.c", "libparser/parse.c", "main.c"];
  // 20 commits: libdrop/ added once and touched once more; libparser/ edited throughout.
  const commits = Array.from({ length: 20 }, (_, i) => [
    "main.c",
    ...(i % 3 === 0 ? ["libparser/parse.c"] : []),
    ...(i === 19 || i === 10 ? ["libdrop/a.c"] : []),
  ]);
  assert.deepEqual([...detectVendored(files, commits)], ["libdrop/"]);
  // Too little history to tell: keep everything.
  assert.equal(detectVendored(files, commits.slice(0, 9)).size, 0);
  assert.equal(detectVendored(files).size, 0);
});

test("build output is judged from the path, including files deleted long ago", () => {
  const known = new Set(["indexer/indextest.c", "indexer/indextest", "crawler/crawler", "Makefile", "crawler/Makefile"]);
  const none = new Set<string>();
  for (const out of ["crawler/crawler", "indexer/indextest", "crawler/core.680317", "core", "a.out", "x/testing.out", "y.o", "z.exe"]) {
    assert.ok(isBuildOutput(out, known, none), out);
  }
  for (const src of ["Makefile", "crawler/Makefile", "LICENSE", "README", "crawler/crawler.c", ".gitignore", "bin/tool"]) {
    assert.ok(!isBuildOutput(src, known, none), src);
  }
  assert.ok(isBuildOutput("bin/tool", known, new Set(["bin/tool"])), "sniffed binaries count");
});

test("extensionless files with NUL bytes are sniffed as binary", async () => {
  const root = join(workspace, "sniff");
  mkdirSync(join(root, "bin"), { recursive: true });
  writeFileSync(join(root, "bin", "tool"), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
  writeFileSync(join(root, "Makefile"), "all:\n");
  const found = await findBinaryFiles(realpathSync.native(root), ["bin/tool", "Makefile", "missing"]);
  assert.deepEqual([...found], ["bin/tool"]);
});
