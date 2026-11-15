// Refreshes the LearnHarness plugin SDK types in .sdk/ (tracked in git; package.json
// depends on file:./.sdk) from a newer authoring skill extracted to .claude/skills/.
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
