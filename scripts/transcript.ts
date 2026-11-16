// Prints one chat transcript compactly (read-only), one line per event.
// Usage: npm run transcript -- [chatId|latest] [--from <tool name>] [--since <time>] [--tail <n>] [--width <n>] [--grep <text>] [--chats <folder>]
//   latest              the most recently updated chat (tests often continue an old chat)
//   --from probe_done   start at the prober's handoff
//   --since 30m         only messages from the last 30 minutes (m, h), or since an ISO time
//   --tail 40           only the last 40 lines
//   --width 0           don't cut long lines (default 300)
//   --grep "partner"    only lines containing the text, in full
import { parseArgs } from "node:util";
import { DEFAULT_CHATS_DIR, parseSince, readChat, renderChat } from "./transcripts.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    from: { type: "string" },
    since: { type: "string" },
    tail: { type: "string" },
    width: { type: "string" },
    grep: { type: "string" },
    chats: { type: "string" },
  },
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const width = Number(values.width ?? 300);
if (!Number.isInteger(width) || width < 0) fail(`--width must be a whole number: ${values.width}`);
const tail = values.tail === undefined ? undefined : Number(values.tail);
if (tail !== undefined && (!Number.isInteger(tail) || tail < 1)) fail(`--tail must be a positive whole number: ${values.tail}`);

const since =
  values.since === undefined
    ? undefined
    : (parseSince(values.since) ?? fail(`--since must be like 30m, 2h or an ISO time: ${values.since}`));

const chat = await readChat(values.chats ?? DEFAULT_CHATS_DIR, positionals[0] ?? "latest");
console.log(`${chat.id ?? "?"}  created ${chat.createdAt ?? "?"}  updated ${chat.updatedAt ?? "?"}`);
const lines = renderChat(chat, {
  width,
  ...(values.from ? { from: values.from } : {}),
  ...(values.grep ? { grep: values.grep } : {}),
  ...(since !== undefined ? { since } : {}),
});
for (const line of tail ? lines.slice(-tail) : lines) console.log(line);
