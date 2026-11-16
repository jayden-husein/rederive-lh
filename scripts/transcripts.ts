// Reading LearnHarness chat transcripts (read-only), shared by the dev scripts:
// transcript.ts prints one, routing-report.ts scores the routing eval, leak-check.ts
// looks for design answers shown too early. Chats live in <learning data>/chats.
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** This project's root folder (the installed plugin folder). */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** <learning data>/chats: two levels above <plugins>/rederive-lh. */
export const DEFAULT_CHATS_DIR = resolve(PROJECT_ROOT, "..", "..", "chats");

// Transcript shapes, as far as the scripts read them (LearnHarness chat JSON, version 2).
export interface Part {
  type?: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
}
export interface Message {
  role?: string;
  content?: string | Part[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  /** Milliseconds since the epoch. */
  timestamp?: number;
}
export interface Chat {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  messages?: Message[];
}

export function textOf(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

/** The learner's opening message, or "" when the chat has none. */
export function firstUserText(chat: Chat): string {
  const first = (chat.messages ?? []).find((m) => m.role === "user");
  return first ? textOf(first.content) : "";
}

/** Every chat in the folder, skipping files that aren't (yet) valid JSON. */
export async function readChats(chatsDir: string): Promise<Chat[]> {
  const chats: Chat[] = [];
  for (const name of await readdir(chatsDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      chats.push(JSON.parse(await readFile(join(chatsDir, name), "utf8")) as Chat);
    } catch {
      // A chat mid-write or not a transcript.
    }
  }
  return chats;
}

/** One chat by id, or the most recently updated one for "latest" (a test often continues an old chat). */
export async function readChat(chatsDir: string, idOrLatest: string): Promise<Chat> {
  if (idOrLatest !== "latest") {
    const id = idOrLatest.replace(/\.json$/, "");
    return JSON.parse(await readFile(join(chatsDir, `${id}.json`), "utf8")) as Chat;
  }
  const chats = await readChats(chatsDir);
  const at = (c: Chat) => Date.parse(c.updatedAt ?? c.createdAt ?? "") || 0;
  const latest = chats.sort((a, b) => at(b) - at(a))[0];
  if (!latest) throw new Error(`No chats in ${chatsDir}`);
  return latest;
}

/** "30m", "2h", or an ISO time, as milliseconds since the epoch; null when unparseable. */
export function parseSince(value: string): number | null {
  const ago = /^(\d+)([mh])$/.exec(value);
  if (ago) return Date.now() - Number(ago[1]) * (ago[2] === "h" ? 3_600_000 : 60_000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
}

/** Every string inside a tool's arguments, in order (card options, nested assessments, ...). */
export function stringsIn(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsIn);
  return [];
}

export interface RenderOptions {
  /** Start at the first call of this tool (e.g. "probe_done"). */
  from?: string;
  /** Cut each line to this many characters; 0 = no limit. */
  width: number;
  /** Only lines containing this text (case-insensitive), printed in full. */
  grep?: string;
  /** Only messages at or after this time (ms); messages without a timestamp are kept. */
  since?: number;
}

/** A compact, one-line-per-event view of a chat: learner, agent text, tool calls, results. */
export function renderChat(chat: Chat, options: RenderOptions): string[] {
  const out: string[] = [];
  const needle = options.grep?.toLowerCase();
  const push = (s: string) => {
    const flat = s.replace(/\r?\n/g, " | ");
    // With grep: only the matching lines, in full.
    if (needle) {
      if (flat.toLowerCase().includes(needle)) out.push(flat);
      return;
    }
    out.push(options.width > 0 && flat.length > options.width ? `${flat.slice(0, options.width)}…` : flat);
  };
  let started = !options.from;
  for (const m of chat.messages ?? []) {
    if (!started && m.role === "assistant" && typeof m.content !== "string") {
      started = (m.content ?? []).some((p) => p.type === "toolCall" && p.name === options.from);
    }
    if (!started) continue;
    if (options.since !== undefined && m.timestamp !== undefined && m.timestamp < options.since) continue;
    if (m.role === "user") push(`USER  ${textOf(m.content)}`);
    else if (m.role === "toolResult") push(`  ->  ${m.toolName ?? "?"}${m.isError ? " [error]" : ""}: ${textOf(m.content)}`);
    else if (m.role === "assistant" && typeof m.content !== "string") {
      for (const p of m.content ?? []) {
        if (p.type === "text" && p.text) push(`TEXT  ${p.text}`);
        if (p.type === "toolCall") push(`CALL  ${p.name ?? "?"} ${JSON.stringify(p.arguments ?? {})}`);
      }
    }
  }
  return out;
}
