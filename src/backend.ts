// Backend entry: activated once per LearnHarness server while the plugin is enabled.
import type { PluginBackendContext } from "learnharness-plugin-api";
import { proberInstructions, teacherInstructions } from "./instructions.ts";
import { MapStore } from "./map-store.ts";
import { MAX_SOURCE_CHARS, OPERATIONS, type StartRederiveResult } from "./names.ts";
import { SessionStore } from "./sessions.ts";
import { SettingsStore, type Settings } from "./settings.ts";
import { createTools, openRepoForChat, type ToolDeps } from "./tools.ts";
import { createBuildMapWorker } from "./worker.ts";

export interface StartRederiveInput {
  chatId: string;
  source: string;
}

export function parseStartRederive(value: unknown): StartRederiveInput {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.chatId !== "string" || !v.chatId || v.chatId.length > 200) throw new Error("A chat id is required.");
  if (typeof v.source !== "string" || !v.source.trim()) throw new Error("Enter a folder path or git URL.");
  if (v.source.length > MAX_SOURCE_CHARS) throw new Error("The path or URL is too long.");
  return { chatId: v.chatId, source: v.source.trim() };
}

export async function activate(ctx: PluginBackendContext): Promise<void> {
  // Read files first, so a failed read leaves nothing half-registered.
  const store = new SessionStore(ctx.dataDirectory);
  const settingsStore = new SettingsStore(ctx.dataDirectory);
  // Load chat state now so each turn's tool factory can read it synchronously.
  await store.warm();
  const settings = await settingsStore.get();
  if (ctx.signal.aborted) return;

  // Host disable/restart disposes the worker service and interrupts unfinished builds.
  ctx.workers.register(createBuildMapWorker());

  // Instructions are fixed text, so a settings change swaps the registration.
  let unregisterInstructions: (() => void)[] = [];
  const applyInstructions = (s: Settings) => {
    for (const off of unregisterInstructions) off();
    unregisterInstructions = [
      ctx.registerInstructions({ agents: ["prober"], text: proberInstructions(s) }),
      ctx.registerInstructions({ agents: ["teacher"], text: teacherInstructions(s) }),
    ];
  };
  applyInstructions(settings);

  const listTasks = () => ctx.workers.list();
  const deps: ToolDeps = {
    store,
    maps: new MapStore(ctx.dataDirectory, listTasks),
    dataDirectory: ctx.dataDirectory,
    signal: ctx.signal,
    listTasks,
    catalog: () => ctx.inference.catalog(),
    createBackgroundTool: (context, definition) => ctx.createBackgroundTool(context, definition),
  };
  ctx.registerTools({
    agents: ["prober", "teacher"],
    create: (context) => createTools(deps, context),
  });

  ctx.handle(OPERATIONS.getSettings, () => settingsStore.get());
  ctx.handle(OPERATIONS.saveSettings, async (input) => {
    const saved = await settingsStore.save(input);
    if (!ctx.signal.aborted) applyInstructions(saved);
    return saved;
  });

  // Top-bar action: open the repo and switch this chat to rederive. It posts no message;
  // the agent sees the new state in rederive_status's description on the next turn and
  // starts the map build itself.
  ctx.handle(OPERATIONS.startRederive, async (input): Promise<StartRederiveResult> => {
    const { chatId, source } = parseStartRederive(input);
    const opened = await openRepoForChat(deps, chatId, source, ctx.signal);
    await store.setMode(chatId, "rederive");
    return { repoName: opened.details.repo.name, warning: opened.details.warning ?? null };
  });
}
