// Claude Code PreToolUse hook rule: refuse shell commands that edit files with an inline
// Node script. On this machine Git Bash mangles backticks and backslashes in `node -e`
// strings, so such edits half-apply (it happened in step 9). The Edit tool is the way.

/** Why the command is refused, or null to let it run. */
export function scriptedEditReason(command: string): string | null {
  const inline = /\bnode(?:\.exe)?\s+(?:-e|--eval|-p|--print)\b/.test(command);
  const writes = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile)\s*\(/.test(command);
  if (!inline || !writes) return null;
  return (
    "Blocked: this edits files with an inline node script. Git Bash on this machine mangles backticks and " +
    "backslashes in node -e strings, so the edit can half-apply. Use the Edit tool (or Write for a new file) instead."
  );
}
