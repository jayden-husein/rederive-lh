// The settings page's save logic (main.ts), run against the stand-in DOM and a fake backend.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PluginFrontendContext, PluginSettingsRow } from "learnharness-plugin-api";
import { activate } from "../src/main.ts";
import { OPERATIONS } from "../src/names.ts";
import type { Settings } from "../src/settings.ts";
import { FakeDocument } from "./fake-dom.ts";

const SAVED: Settings = { defaultMode: "auto", defaultRepo: "", checkUpdates: true };

/** Let every promise that is ready run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Activate the frontend and open its settings page. Saves wait until the test answers them. */
async function openSettings() {
  const saves: { sent: Settings; resolve: (s: Settings) => void; reject: (e: Error) => void }[] = [];
  let rows: PluginSettingsRow[] = [];
  let mountSettings: (container: HTMLElement, signal: AbortSignal) => unknown = () => undefined;
  const widget = { update: () => undefined, dispose: () => undefined };
  const ctx = {
    signal: new AbortController().signal,
    call: (operation: string, input: unknown) => {
      if (operation === OPERATIONS.getSettings) return Promise.resolve({ ...SAVED });
      if (operation === OPERATIONS.saveSettings) {
        return new Promise<Settings>((resolve, reject) => saves.push({ sent: input as Settings, resolve, reject }));
      }
      return Promise.reject(new Error(`not faked: ${operation}`));
    },
    registerSettings: (mount: typeof mountSettings) => {
      mountSettings = mount;
    },
    ui: {
      mountSettingsRows: (_slot: unknown, props: { rows: PluginSettingsRow[] }) => {
        rows = props.rows;
        return { update: (next: { rows: PluginSettingsRow[] }) => void (rows = next.rows), dispose: () => undefined };
      },
      mountButton: () => widget,
    },
  };
  // Every other registration (cards, actions, notifications) is a no-op that returns an unregister.
  const anyCtx = new Proxy(ctx, { get: (target, key) => (key in target ? target[key as keyof typeof ctx] : () => () => undefined) });
  activate(anyCtx as unknown as PluginFrontendContext);
  mountSettings(new FakeDocument().createElement("div") as unknown as HTMLElement, new AbortController().signal);
  await settle();
  const change = (key: keyof Settings, value: unknown) => {
    const row = rows.find((r) => r.key === key) as { onChange(value: unknown): Promise<void> };
    return row.onChange(value);
  };
  const shown = () => Object.fromEntries(rows.map((r) => [r.key, (r as { value: unknown }).value]));
  const shownRow = (key: keyof Settings) => rows.find((r) => r.key === key);
  return { saves, change, shown, shownRow };
}

/** Activate the frontend in a chat whose "Rederive this repo" press hasn't reached the tutor yet. */
function restartInterceptor() {
  const cleared: unknown[] = [];
  let intercept: (input: unknown, context: unknown) => Promise<unknown> = async () => undefined;
  const ctx = {
    signal: new AbortController().signal,
    call: (operation: string, input: unknown) => {
      if (operation === OPERATIONS.pendingStart) return Promise.resolve({ repoName: "kilo", stamp: "s1" });
      if (operation === OPERATIONS.clearStart) return Promise.resolve(void cleared.push(input));
      return Promise.reject(new Error(`not faked: ${operation}`));
    },
    registerSubmissionInterceptor: (definition: { intercept: typeof intercept }) => {
      intercept = definition.intercept;
    },
  };
  const anyCtx = new Proxy(ctx, { get: (target, key) => (key in target ? target[key as keyof typeof ctx] : () => () => undefined) });
  activate(anyCtx as unknown as PluginFrontendContext);
  const send = async (input: object, channels: string[]) => {
    const accepted: (() => unknown)[] = [];
    const context = { sessionKind: "teaching", sessionId: "c1", channels, signal: new AbortController().signal, onAccepted: (fn: () => unknown) => accepted.push(fn) };
    return { out: await intercept(input, context), accepted };
  };
  return { send, cleared };
}

const NOTE = "(Rederive this repo: start fresh with kilo.)";
const empty = { text: "", images: [] };

test("the restart note goes in front of the learner's next message and is cleared once accepted", async () => {
  const { send, cleared } = restartInterceptor();
  const { out, accepted } = await send({ type: "text", content: { text: "go", images: [] } }, ["content"]);
  assert.deepEqual(out, { type: "text", content: { text: `${NOTE}\n\ngo`, images: [] } });
  await accepted[0]!();
  assert.deepEqual(cleared, [{ chatId: "c1", stamp: "s1" }]);
});

test("with a card waiting, the restart note rides on the thinking sent with the answer", async () => {
  const { send } = restartInterceptor();
  const answer = { type: "plugin-question-answer", answer: { design: "a queue" }, answerImages: [], thinking: empty, readingThinking: { text: "hmm", images: [] } };
  const design = await send(answer, ["answer", "readingThinking"]);
  assert.deepEqual(design.out, { ...answer, readingThinking: { text: `${NOTE}\n\nhmm`, images: [] } });
  assert.equal(design.accepted.length, 1);
  const pick = await send({ ...answer, readingThinking: empty }, ["answer", "thinking"]);
  assert.deepEqual(pick.out, { ...answer, readingThinking: empty, thinking: { text: NOTE, images: [] } });
  // No thinking box on the card: the answer goes out unchanged and the note waits.
  const bare = await send(answer, ["answer"]);
  assert.equal(bare.out, undefined);
  assert.equal(bare.accepted.length, 0);
});

test("the default repo field refuses a token as it is typed, and accepts the URL without it", async () => {
  const { shownRow } = await openSettings();
  const validate = (shownRow("defaultRepo") as { validate(value: string): string | undefined }).validate;
  assert.match(validate("https://me:token@example.com/x") ?? "", /password or token/);
  assert.equal(validate("https://example.com/x"), undefined);
  assert.equal(validate(""), undefined);
  assert.equal(validate("x".repeat(1001)), "Too long.");
});

test("a second settings change made before the first returns builds on it", async () => {
  const { saves, change, shown } = await openSettings();
  assert.deepEqual(shown(), SAVED);
  const first = change("defaultMode", "ask");
  const second = change("checkUpdates", false);
  assert.deepEqual(saves[1]!.sent, { defaultMode: "ask", defaultRepo: "", checkUpdates: false });
  saves[0]!.resolve(saves[0]!.sent);
  saves[1]!.resolve(saves[1]!.sent);
  await Promise.all([first, second]);
  assert.deepEqual(shown(), { defaultMode: "ask", defaultRepo: "", checkUpdates: false });
});

test("a refused save takes back only its own change", async () => {
  const { saves, change, shown } = await openSettings();
  const mode = change("defaultMode", "always");
  const repo = change("defaultRepo", "https://me:token@example.com/x");
  saves[1]!.reject(new Error("The default repo's URL holds a password or token."));
  await assert.rejects(repo, /password or token/);
  assert.deepEqual(shown(), { defaultMode: "always", defaultRepo: "", checkUpdates: true });
  saves[0]!.resolve(saves[0]!.sent);
  await mode;
  assert.deepEqual(shown(), { defaultMode: "always", defaultRepo: "", checkUpdates: true });
});
