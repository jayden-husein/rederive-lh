// Copies the LearnHarness plugin SDK types from the authoring skill into .sdk/.
// Run before `npm install` on a fresh clone: package.json depends on file:./.sdk.
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, ".claude", "skills", "learnharness-plugins", "types");
const target = join(root, ".sdk");

if (!existsSync(join(source, "index.d.ts"))) {
  console.error(
    `SDK types not found at ${source}.\n` +
      "Download the authoring skill from LearnHarness (Settings -> Community plugins -> " +
      "Download authoring skill) and extract it to .claude/skills/learnharness-plugins/.",
  );
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Copied SDK types to ${target}`);
