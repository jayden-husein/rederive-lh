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
  return { saves, change, shown };
}

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
