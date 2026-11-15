import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { scriptedEditReason } from "../scripts/hooks/scripted-edits.ts";
import { PROJECT_ROOT } from "../scripts/transcripts.ts";

test("inline node scripts that write files are refused; reads and other commands run", () => {
  // The step 9 command that half-applied.
  assert.match(scriptedEditReason(`node -e "const fs=require('fs');let s=fs.readFileSync(p,'utf8');s=s.replace(a,b);fs.writeFileSync(p,s);"`)!, /Use the Edit tool/);
  assert.ok(scriptedEditReason("node --eval \"require('fs').appendFileSync('x','y')\""));
  assert.equal(scriptedEditReason(`node -e "const c=require('./chat.json');console.log(c.id)"`), null);
  assert.equal(scriptedEditReason("node scripts/build.ts"), null);
  assert.equal(scriptedEditReason("npm test"), null);
});

test("the hook script exits 2 with the reason for a refused command, 0 otherwise", () => {
  const hook = join(PROJECT_ROOT, "scripts", "hooks", "block-scripted-edits.ts");
  const run = (command: string) => {
    try {
      execFileSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), stdio: "pipe" });
      return { code: 0, stderr: "" };
    } catch (error) {
      const e = error as { status: number; stderr: Buffer };
      return { code: e.status, stderr: e.stderr.toString() };
    }
  };
  const refused = run(`node -e "require('fs').writeFileSync('a','b')"`);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Use the Edit tool/);
  assert.equal(run("git status").code, 0);
});
