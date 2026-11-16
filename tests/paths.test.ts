import assert from "node:assert/strict";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { displayRelative, isWithin, PathEscapeError, resolveInsideRoot } from "../src/paths.ts";
import { removeDir, tempDir } from "./helpers.ts";

let workspace: string;
let root: string;

before(() => {
  workspace = realpathSync.native(tempDir("paths"));
  root = join(workspace, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.c"), "int main(void) { return 0; }\n");
  mkdirSync(join(workspace, "secret"));
  writeFileSync(join(workspace, "secret", "key.txt"), "nope");
  writeFileSync(join(workspace, "repo-sibling.txt"), "sibling");
  // Junctions need no admin rights on Windows; the type argument is ignored elsewhere.
  symlinkSync(join(workspace, "secret"), join(root, "escape"), "junction");
  symlinkSync(join(root, "src"), join(root, "inner"), "junction");
});

after(() => removeDir(workspace));

test("resolves normal relative paths inside the root", async () => {
  assert.equal(await resolveInsideRoot(root, "src/main.c"), join(root, "src", "main.c"));
  assert.equal(await resolveInsideRoot(root, "src\\main.c"), join(root, "src", "main.c"));
  assert.equal(await resolveInsideRoot(root, ""), root);
  assert.equal(await resolveInsideRoot(root, "./src"), join(root, "src"));
});

test("rejects .. segments even when they would stay inside", async () => {
  await assert.rejects(resolveInsideRoot(root, "../secret/key.txt"), PathEscapeError);
  await assert.rejects(resolveInsideRoot(root, "src/../src/main.c"), PathEscapeError);
  await assert.rejects(resolveInsideRoot(root, "src\\..\\..\\secret"), PathEscapeError);
});

test("rejects absolute and drive-qualified paths", async () => {
  await assert.rejects(resolveInsideRoot(root, join(root, "src")), PathEscapeError);
  await assert.rejects(resolveInsideRoot(root, "C:\\Windows"), PathEscapeError);
  await assert.rejects(resolveInsideRoot(root, "C:relative"), PathEscapeError);
  await assert.rejects(resolveInsideRoot(root, "\\\\server\\share"), PathEscapeError);
});

test("rejects links that resolve outside the root, allows links that stay inside", async () => {
  await assert.rejects(resolveInsideRoot(root, "escape/key.txt"), /links outside/);
  assert.equal(await resolveInsideRoot(root, "inner/main.c"), join(root, "src", "main.c"));
});

test("missing paths reject with ENOENT", async () => {
  await assert.rejects(resolveInsideRoot(root, "nope.c"), { code: "ENOENT" });
});

test("isWithin does not treat a name prefix as containment", () => {
  assert.equal(isWithin(root, join(workspace, "repo-sibling.txt")), false);
  assert.equal(isWithin(root, root), true);
  assert.equal(isWithin(root, join(root, "a", "b")), true);
  assert.equal(isWithin(root, join(root, "..cache", "x")), true, 'a folder named "..cache" is inside');
  assert.equal(isWithin(root, workspace), false);
  if (process.platform === "win32") assert.equal(isWithin(root.toUpperCase(), join(root, "src")), true);
});

test("displayRelative uses forward slashes", () => {
  assert.equal(displayRelative(root, join(root, "src", "main.c")), "src/main.c");
  assert.equal(displayRelative(root, root), ".");
});
