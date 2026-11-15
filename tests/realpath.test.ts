// Tests resolve temp roots with realpathSync.native, as the plugin's async realpath does.
// Plain realpathSync keeps Windows 8.3 short names (C:\Users\RUNNER~1\...), so a root it
// returns doesn't contain the paths the plugin resolves, and files look outside the repo.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { test } from "node:test";

test("tests resolve real paths with realpathSync.native", () => {
  const dir = new URL("./", import.meta.url);
  const self = basename(new URL(import.meta.url).pathname);
  const offenders = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== self)
    .filter((name) => /\brealpathSync\(/.test(readFileSync(new URL(name, dir), "utf8")));
  assert.deepEqual(offenders, [], "use realpathSync.native(...) in these files");
});
