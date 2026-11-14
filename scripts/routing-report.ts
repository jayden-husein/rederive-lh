// Scores the routing eval from LearnHarness chat transcripts (read-only).
// Usage: npm run routing-report -- [--since <ISO time>] [--chats <chats folder>]
// The chats folder defaults to <learning data>/chats, two levels above this plugin.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { classifyChat, normalize, parsePrompts, passes } from "./routing-eval.ts";
import { type Chat, DEFAULT_CHATS_DIR, firstUserText, PROJECT_ROOT, readChats } from "./transcripts.ts";

const { values } = parseArgs({ options: { since: { type: "string" }, chats: { type: "string" } } });
const chatsDir = values.chats ?? DEFAULT_CHATS_DIR;
const since = values.since ? Date.parse(values.since) : -Infinity;
if (Number.isNaN(since)) {
  console.error(`--since is not a date: ${values.since}`);
  process.exit(2);
}

const prompts = parsePrompts(await readFile(join(PROJECT_ROOT, "tests", "routing-prompts.md"), "utf8"));
const byText = new Map(prompts.map((p) => [normalize(p.prompt), p]));

// Newest matching chat per prompt.
const latest = new Map<string, { chat: Chat; at: number }>();
for (const chat of await readChats(chatsDir)) {
  const at = Date.parse(chat.createdAt ?? "");
  if (!(at >= since)) continue;
  const prompt = byText.get(normalize(firstUserText(chat)));
  if (!prompt) continue;
  const seen = latest.get(prompt.id);
  if (!seen || at > seen.at) latest.set(prompt.id, { chat, at });
}

let passed = 0;
let run = 0;
console.log(`${"Id".padEnd(4)} ${"Expected".padEnd(11)} ${"Got".padEnd(11)} ${"Asked".padEnd(6)} Result  Chat`);
for (const prompt of prompts) {
  const found = latest.get(prompt.id);
  if (!found) {
    console.log(`${prompt.id.padEnd(4)} ${prompt.expected.padEnd(11)} ${"-".padEnd(11)} ${"-".padEnd(6)} not run`);
    continue;
  }
  const outcome = classifyChat(found.chat);
  const ok = passes(prompt, outcome);
  run += 1;
  if (ok) passed += 1;
  console.log(
    `${prompt.id.padEnd(4)} ${prompt.expected.padEnd(11)} ${outcome.mode.padEnd(11)} ${(outcome.asked ? "yes" : "no").padEnd(6)} ${(ok ? "pass" : "FAIL").padEnd(7)} ${found.chat.id ?? ""}`,
  );
  for (const question of outcome.questions) console.log(`     asked before the mode: ${question}`);
}
console.log(`\nScore: ${passed}/${run} run (${prompts.length} prompts; target 13/15).`);
