// Writes a page that renders a chat's Mermaid diagrams the way LearnHarness does, to look
// at in the browser pane (read-only on the chat).
// Usage: npm run render-diagrams -- [chatId|latest] [--since <time>] [--chats <folder>]
//   --since 30m   only diagrams from the last 30 minutes (m, h), or since an ISO time
// Writes .scratch/diagrams.html (gitignored) and prints its file:// URL.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { diagramPage, diagramsIn } from "./diagrams.ts";
import { DEFAULT_CHATS_DIR, parseSince, PROJECT_ROOT, readChat } from "./transcripts.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { since: { type: "string" }, chats: { type: "string" } },
});

const chat = await readChat(values.chats ?? DEFAULT_CHATS_DIR, positionals[0] ?? "latest");
const since = values.since === undefined ? 0 : parseSince(values.since);
if (since === null) {
  console.error(`--since must be like 30m, 2h or an ISO time: ${values.since}`);
  process.exit(2);
}
const diagrams = diagramsIn(chat).filter((d) => d.timestamp === 0 || d.timestamp >= since);
const dir = join(PROJECT_ROOT, ".scratch");
await mkdir(dir, { recursive: true });
const file = join(dir, "diagrams.html");
await writeFile(file, diagramPage(diagrams));
console.log(`${chat.id}: ${diagrams.length} diagram(s)`);
console.log(pathToFileURL(file).href);
