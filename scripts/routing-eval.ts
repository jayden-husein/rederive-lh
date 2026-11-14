// Scoring for the routing eval (tests/routing-prompts.md): parse the prompt table,
// read one chat transcript and say which mode the prober picked. Pure functions;
// routing-report.ts does the file reading.
import { TOOL_NAMES } from "../src/names.ts";
import type { Chat } from "./transcripts.ts";

const EXPECTED = ["rederive", "onboarding", "normal"] as const;
export type Expected = (typeof EXPECTED)[number];
const isExpected = (value: unknown): value is Expected => (EXPECTED as readonly unknown[]).includes(value);

export interface RoutingPrompt {
  id: string;
  expected: Expected;
  askOk: boolean;
  prompt: string;
}

export interface Outcome {
  /** First mode set by a successful rederive_set_mode call; "normal" when there was none. */
  mode: Expected;
  /** The prober asked the routing question (as a card or in prose) before setting a mode. */
  asked: boolean;
  /** Every card question asked before the mode was set, so a paraphrased routing question can be spotted by eye. */
  questions: string[];
}

/** Rows of the "## Prompts" table. Throws on a malformed row so a typo can't drop a prompt. */
export function parsePrompts(markdown: string): RoutingPrompt[] {
  const prompts: RoutingPrompt[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (!/^\|\s*[RON]\d+\s*\|/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    const [id, expected, askOk, prompt] = cells;
    if (cells.length !== 6 || !id || !prompt || !isExpected(expected) || (askOk !== "yes" && askOk !== "no")) {
      throw new Error(`Malformed prompt row: ${line}`);
    }
    prompts.push({ id, expected, askOk: askOk === "yes", prompt });
  }
  return prompts;
}

/** Compare prompts by words only: copying from rendered markdown drops the backticks. */
export function normalize(text: string): string {
  return text.replace(/`/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

// The routing question from src/instructions.ts; tests check the two stay in step.
export const ROUTING_QUESTION = /work in (this|the) code/i;

export function classifyChat(chat: Chat): Outcome {
  const messages = chat.messages ?? [];
  const failed = new Set(messages.filter((m) => m.role === "toolResult" && m.isError).map((m) => m.toolCallId));
  let asked = false;
  const questions: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content ?? []) {
      if (part.type === "text" && ROUTING_QUESTION.test(part.text ?? "")) asked = true;
      if (part.type !== "toolCall") continue;
      const args = part.arguments ?? {};
      if (part.name === TOOL_NAMES.setMode && !failed.has(part.id)) {
        if (isExpected(args.mode)) return { mode: args.mode, asked, questions };
      }
      if (part.name === "ask_user_question" && typeof args.question === "string") questions.push(args.question);
      // A card (question) or prose sent through send_to_user (message).
      if (ROUTING_QUESTION.test(String(args.question ?? "")) || ROUTING_QUESTION.test(String(args.message ?? ""))) {
        asked = true;
      }
    }
  }
  return { mode: "normal", asked, questions };
}

export function passes(prompt: RoutingPrompt, outcome: Outcome): boolean {
  return outcome.mode === prompt.expected && (!outcome.asked || prompt.askOk);
}
