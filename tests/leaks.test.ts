import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { findLeaks, leakTerms } from "../scripts/leaks.ts";
import { type Chat, readChat, renderChat } from "../scripts/transcripts.ts";
import { removeDir, tempDir } from "./helpers.ts";
import type { DecisionMapResult } from "../src/map.ts";

const decision = (id: string, technique: string, inThisCode: string, problem: string) => ({
  id,
  title: `Problem ${id}`,
  problem,
  given: "pages on disk",
  constraints: [{ text: "pages link back to each other", breaks: "naive loop" }],
  decision: { technique, definition: "def", inThisCode },
  options: [
    { approach: "a", tradeoff: "x" },
    { approach: "b", tradeoff: "y" },
  ],
  evidence: "code only",
});

const map: DecisionMapResult = {
  rootProblem: "Search the pages reachable from one start page.",
  decisions: [
    decision("D1", "Breadth-first crawl with a visited set", "crawler/crawler.c keeps a bag and common/pagedir.c writes pages", "Gather the pages reachable from a start page."),
    decision("D2", "Inverted index", "indexer/indexer.c builds the index", "Find pages by word quickly."),
  ],
};

const say = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] });

test("terms come from the technique and the code paths, minus words the problem itself uses", () => {
  const terms = leakTerms(map);
  for (const t of ["breadth-first", "crawl", "visited", "crawler", "crawler.c", "pagedir", "inverted", "index", "indexer"]) assert.ok(terms.has(t), t);
  // "pages" is in the problem text; "common" says nothing; "with" is a stop word.
  for (const t of ["pages", "common", "with"]) assert.ok(!terms.has(t), t);
  assert.equal(terms.get("crawler")?.kind, "component");
  assert.equal(terms.get("visited")?.kind, "technique");
});

test("two technique words of one decision are a leak; one word or a folder is a hint", () => {
  const chat: Chat = {
    messages: [
      { role: "user", content: "help" },
      say("We'll start with the crawler."),
      call("s", "send_to_user", { message: "Use a breadth-first crawl." }),
      say("Sort the index out later."),
    ],
  };
  const findings = findLeaks(chat, map).map((f) => `${f.severity}:${f.term}:${f.source}`);
  assert.deepEqual(findings, ["hint:crawler:text", "leak:breadth-first:send_to_user", "leak:crawl:send_to_user", "hint:index:text"]);
});

test("nothing is flagged once the decision is logged, or after the learner said it", () => {
  const chat: Chat = {
    messages: [
      { role: "user", content: "maybe keep a visited list?" },
      call("l", "rederive_log_problem", { id: "D1" }),
      { role: "toolResult", toolCallId: "l", isError: false },
      say("Yes, a breadth-first crawl with a visited set."),
      say("Visited, exactly."),
    ],
  };
  assert.deepEqual(findLeaks(chat, map), []);
  // A failed log call doesn't count as reached.
  const failed: Chat = { messages: [call("l", "rederive_log_problem", { id: "D1" }), { role: "toolResult", toolCallId: "l", isError: true }, say("A breadth-first crawl.")] };
  assert.equal(findLeaks(failed, map).filter((f) => f.severity === "leak").length, 2);
});

test("naming the technique right before logging it is the reveal, not a leak; before a skip or an earlier answer it is", () => {
  // The learner answers a card, the teacher names the design, then logs it: rule 4.
  const answer = { role: "toolResult", toolCallId: "q", toolName: "ask_user_question", isError: false, content: [{ type: "text", text: "a queue and a list of seen pages" }] };
  const reveal: Chat = {
    messages: [
      answer,
      call("s", "send_to_user", { message: "That's a breadth-first crawl with a visited set." }),
      call("l", "rederive_log_problem", { id: "D1" }),
      { role: "toolResult", toolCallId: "l", isError: false },
    ],
  };
  assert.deepEqual(findLeaks(reveal, map), []);
  // Named, then skipped: still a leak.
  const skipped: Chat = { messages: [answer, call("s", "send_to_user", { message: "It's a breadth-first crawl." }), call("k", "rederive_skip_problem", { id: "D1" })] };
  assert.equal(findLeaks(skipped, map).filter((f) => f.severity === "leak").length, 2);
  // Named before the learner's next answer, logged only after it: a leak.
  const early: Chat = {
    messages: [
      answer,
      call("s", "send_to_user", { message: "Think breadth-first crawl." }),
      { ...answer, toolCallId: "q2" },
      call("l", "rederive_log_problem", { id: "D1" }),
    ],
  };
  assert.equal(findLeaks(early, map).filter((f) => f.severity === "leak").length, 2);
});

test("card text and handoffs count as shown; the plugin's own and file tools don't", () => {
  const chat: Chat = {
    messages: [
      call("q", "ask_user_question", { question: "Ready?", options: [{ label: "Go to the indexer" }] }),
      call("p", "probe_done", { assessment: { summary: "Tiny engine: crawler, indexer" } }),
      call("r", "read", { path: "crawler/crawler.c" }),
      call("n", "rederive_next_problem", { id: "D2" }),
    ],
  };
  assert.deepEqual(
    findLeaks(chat, map).map((f) => `${f.term}:${f.source}`),
    ["indexer:ask_user_question", "crawler:probe_done", "indexer:probe_done"],
  );
});

test("everyday words stay hints even in pairs; naming a technique with 'you rederived it' is a leak", () => {
  // Step 9 tests: "read" and "write" (one decision's technique) flagged a LEAK in plain
  // teaching, while the real reveal ("...you rederived it") was buried among them.
  const everyday: DecisionMapResult = {
    rootProblem: "Volunteers manage the people at their shelter.",
    decisions: [decision("D5", "Read write split with shared query cache", "server/cache.ts", "Keep the app fast.")],
  };
  const plain: Chat = { messages: [say("Every volunteer read and write must stay inside their shelter.")] };
  assert.deepEqual(findLeaks(plain, everyday).map((f) => `${f.severity}:${f.term}`), ["hint:read", "hint:write"]);
  // One distinctive word plus a claim they derived it: the reveal.
  const reveal: Chat = { messages: [say("That's a breadth-first walk, and you rederived it!")] };
  assert.deepEqual(findLeaks(reveal, map).map((f) => `${f.severity}:${f.term}`), ["leak:breadth-first"]);
});

test("the transcript view is one line per event, cut to width, optionally from a tool", () => {
  const chat: Chat = {
    messages: [
      { role: "user", content: "hi\nthere" },
      call("a", "probe_done", { x: 1 }),
      { role: "toolResult", toolName: "probe_done", content: [{ type: "text", text: "ok" }], isError: true },
      say("a long message"),
    ],
  };
  assert.deepEqual(renderChat(chat, { width: 0 }), ["USER  hi | there", 'CALL  probe_done {"x":1}', "  ->  probe_done [error]: ok", "TEXT  a long message"]);
  assert.deepEqual(renderChat(chat, { width: 10, from: "probe_done" }), ["CALL  prob…", "  ->  prob…", "TEXT  a lo…"]);
  // grep keeps only matching lines, uncut, whatever the width.
  assert.deepEqual(renderChat(chat, { width: 10, grep: "LONG" }), ["TEXT  a long message"]);
});

test("since keeps only messages at or after a time, so a continued chat shows just the new run", () => {
  const chat: Chat = {
    messages: [
      { ...say("old run"), timestamp: 1000 },
      { role: "user", content: "new run", timestamp: 2000 },
      { ...say("reply"), timestamp: 3000 },
    ],
  };
  assert.deepEqual(renderChat(chat, { width: 0, since: 2000 }), ["USER  new run", "TEXT  reply"]);
});

test("latest is the most recently updated chat, so a continued test chat wins over a newer idle one", async () => {
  const dir = tempDir("chats");
  try {
    writeFileSync(join(dir, "a.json"), JSON.stringify({ id: "a", createdAt: "2026-11-15T19:00:00Z", updatedAt: "2026-11-15T21:00:00Z" }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ id: "b", createdAt: "2026-11-15T20:00:00Z", updatedAt: "2026-11-15T20:05:00Z" }));
    assert.equal((await readChat(dir, "latest")).id, "a");
  } finally {
    removeDir(dir);
  }
});
