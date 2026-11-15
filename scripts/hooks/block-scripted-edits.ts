// PreToolUse hook (.claude/settings.json): reads the tool call as JSON on stdin and exits 2
// with a reason on stderr when scriptedEditReason refuses the command. Exit 0 lets it run.
import { scriptedEditReason } from "./scripted-edits.ts";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
let command = "";
try {
  const input = JSON.parse(raw) as { tool_input?: { command?: unknown } };
  if (typeof input.tool_input?.command === "string") command = input.tool_input.command;
} catch {
  // Not a tool call we understand: let it run.
}
const reason = scriptedEditReason(command);
if (reason) {
  process.stderr.write(reason);
  process.exit(2);
}
