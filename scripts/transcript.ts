// Prints one chat transcript compactly (read-only), one line per event.
// Usage: npm run transcript -- [chatId|latest] [--from <tool name>] [--width <n>] [--chats <folder>]
//   --from probe_done   start at the prober's handoff
//   --width 0           don't cut long lines (default 300)
import { parseArgs } from "node:util";
import { DEFAULT_CHATS_DIR, readChat, renderChat } from "./transcripts.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { from: { type: "string" }, width: { type: "string" }, chats: { type: "string" } },
});
const width = Number(values.width ?? 300);
if (!Number.isInteger(width) || width < 0) {
  console.error(`--width must be a whole number: ${values.width}`);
  process.exit(2);
}
const chat = await readChat(values.chats ?? DEFAULT_CHATS_DIR, positionals[0] ?? "latest");
console.log(`${chat.id ?? "?"}  created ${chat.createdAt ?? "?"}`);
for (const line of renderChat(chat, { width, ...(values.from ? { from: values.from } : {}) })) console.log(line);
