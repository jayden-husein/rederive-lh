import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { classifyChat, normalize, parsePrompts, passes, ROUTING_QUESTION } from "../scripts/routing-eval.ts";
import { type Chat, firstUserText } from "../scripts/transcripts.ts";
import { proberInstructions } from "../src/instructions.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";

test("the eval recognizes the prober's own routing question", () => {
  assert.match(proberInstructions(DEFAULT_SETTINGS), ROUTING_QUESTION);
});

const markdown = readFileSync(new URL("./routing-prompts.md", import.meta.url), "utf8");

test("the prompt set has 5 prompts per mode with unique ids and texts", () => {
  const prompts = parsePrompts(markdown);
  assert.equal(prompts.length, 15);
  for (const mode of ["rederive", "onboarding", "normal"]) {
    assert.equal(prompts.filter((p) => p.expected === mode).length, 5, mode);
  }
  assert.equal(new Set(prompts.map((p) => p.id)).size, 15);
  assert.equal(new Set(prompts.map((p) => normalize(p.prompt))).size, 15);
});

test("a malformed row is an error, not a dropped prompt", () => {
  assert.throws(() => parsePrompts("| R9 | rederiv | no | hi | x | y |"), /Malformed/);
});

test("prompts match whether or not the backticks were copied", () => {
  assert.equal(normalize("Open `C:\\repo`  now"), normalize("open C:\\repo now"));
});

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "toolCall", id, name, arguments: args }],
});
const result = (id: string, isError = false) => ({ role: "toolResult", toolCallId: id, isError });
const opening = { role: "user", content: "help me" };

test("the first successful set_mode call decides the mode", () => {
  const chat: Chat = {
    messages: [
      opening,
      call("a", "rederive_set_mode", { mode: "bogus" }),
      result("a", true),
      call("b", "rederive_set_mode", { mode: "onboarding" }),
      result("b"),
      call("c", "rederive_set_mode", { mode: "rederive" }),
      result("c"),
    ],
  };
  assert.deepEqual(classifyChat(chat), { mode: "onboarding", asked: false, questions: [] });
});

test("no set_mode call means normal", () => {
  assert.deepEqual(classifyChat({ messages: [opening, call("a", "rederive_status", {})] }), { mode: "normal", asked: false, questions: [] });
});

test("the routing question counts as a card, as send_to_user prose, or as text", () => {
  const q = "Do you want to be able to work in this code, or to explain why it's designed this way?";
  for (const message of [
    call("q", "ask_user_question", { question: q }),
    call("q", "send_to_user", { message: q }),
    { role: "assistant", content: [{ type: "text", text: q }] },
  ]) {
    const chat: Chat = { messages: [opening, message, call("m", "rederive_set_mode", { mode: "rederive" })] };
    assert.deepEqual({ ...classifyChat(chat), questions: [] }, { mode: "rederive", asked: true, questions: [] });
  }
  // A later question (after the mode is set) doesn't count.
  const later: Chat = { messages: [opening, call("m", "rederive_set_mode", { mode: "rederive" }), call("q", "ask_user_question", { question: q })] };
  assert.equal(classifyChat(later).asked, false);
  assert.deepEqual(classifyChat(later).questions, []);
  // Any card before the mode is listed, so a paraphrase can be checked by eye.
  const paraphrase: Chat = { messages: [opening, call("q", "ask_user_question", { question: "Change it, or defend it?" })] };
  assert.deepEqual(classifyChat(paraphrase), { mode: "normal", asked: false, questions: ["Change it, or defend it?"] });
});

test("asking fails a row unless the row allows it", () => {
  const strict = { id: "R1", expected: "rederive" as const, askOk: false, prompt: "" };
  assert.equal(passes(strict, { mode: "rederive", asked: false, questions: [] }), true);
  assert.equal(passes(strict, { mode: "rederive", asked: true, questions: [] }), false);
  assert.equal(passes({ ...strict, askOk: true }, { mode: "rederive", asked: true, questions: [] }), true);
  assert.equal(passes(strict, { mode: "onboarding", asked: false, questions: [] }), false);
});

test("the opening message is read from text parts too", () => {
  assert.equal(firstUserText({ messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] }), "ab");
});
