// Checks one chat for design answers shown before the learner reached them (read-only).
// Usage: npm run leak-check -- [chatId|latest] [--map <map.json>] [--chats <folder>]
// The map defaults to the one for the chat's repo in this plugin's data/. A rebuilt map
// may differ from the one the chat used; pass --map to check against another.
// LEAK: two or more technique words of one decision in one piece of output (exit code 1).
// HINT: one technique word or a code location, to judge by hand: an ordinary word
// ("sort out"), or folders the learner's own repo may name fine.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { StoredMap } from "../src/map.ts";
import { findLeaks } from "./leaks.ts";
import { DEFAULT_CHATS_DIR, PROJECT_ROOT, readChat } from "./transcripts.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { map: { type: "string" }, chats: { type: "string" } },
});
const chat = await readChat(values.chats ?? DEFAULT_CHATS_DIR, positionals[0] ?? "latest");

let mapFile = values.map;
if (!mapFile) {
  const sessions = JSON.parse(await readFile(join(PROJECT_ROOT, "data", "sessions.json"), "utf8")) as {
    chats?: Record<string, { repoId?: string }>;
  };
  const repoId = sessions.chats?.[chat.id ?? ""]?.repoId;
  if (!repoId) {
    console.error(`Chat ${chat.id} has no repo in data/sessions.json; pass --map <map.json>.`);
    process.exit(2);
  }
  mapFile = join(PROJECT_ROOT, "data", "repos", repoId, "map.json");
}
const map = JSON.parse(await readFile(mapFile, "utf8")) as StoredMap;

const findings = findLeaks(chat, map);
console.log(`${chat.id}  against ${map.repoName} map built ${map.builtAt}`);
for (const f of findings) {
  console.log(`${f.severity === "leak" ? "LEAK" : "HINT"}  "${f.term}" (${f.decisions.join(", ")}) in ${f.source}: …${f.excerpt}…`);
}
const leaks = findings.filter((f) => f.severity === "leak").length;
console.log(`\n${leaks} leak(s), ${findings.length - leaks} hint(s) to check by hand.`);
process.exit(leaks ? 1 : 0);
