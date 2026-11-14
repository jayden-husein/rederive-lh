import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { cleanDist } from "../scripts/clean-dist.ts";

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "rederive-clean-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

test("removes a normal dist directory", () => {
  const dist = join(workspace, "dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "main.js"), "");
  cleanDist(dist);
  assert.equal(existsSync(dist), false);
});

test("missing dist is not an error", () => {
  cleanDist(join(workspace, "dist"));
});

test("refuses a dist that contains data", () => {
  const dist = join(workspace, "dist");
  mkdirSync(join(dist, "data"), { recursive: true });
  assert.throws(() => cleanDist(dist), /contains "data"/);
  assert.equal(existsSync(join(dist, "data")), true);
});

test("refuses a symlinked dist and leaves its target alone", () => {
  const target = join(workspace, "data");
  mkdirSync(target);
  writeFileSync(join(target, "keep.txt"), "important");
  const dist = join(workspace, "dist");
  // A junction needs no admin rights on Windows; the type is ignored elsewhere.
  symlinkSync(target, dist, "junction");
  assert.throws(() => cleanDist(dist), /symlink or junction/);
  assert.equal(existsSync(join(target, "keep.txt")), true);
});

test("refuses a path not named dist", () => {
  const other = join(workspace, "src");
  mkdirSync(other);
  assert.throws(() => cleanDist(other), /not a dist directory/);
  assert.equal(existsSync(other), true);
});
