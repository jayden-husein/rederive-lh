// Backend entry: activated once per LearnHarness server while the plugin is enabled.
import type { PluginBackendContext } from "learnharness-plugin-api";
import { proberInstructions, teacherInstructions } from "./instructions.ts";
import { MapStore } from "./map-store.ts";
import { MAX_SOURCE_CHARS, OPERATIONS, UPDATE_TOPIC, type LogView, type PendingStart, type StartRederiveResult } from "./names.ts";
import { createDesignQuestionType, createPickQuestionType } from "./grading.ts";
import { SessionStore } from "./sessions.ts";
import { SettingsStore, type Settings } from "./settings.ts";
import { createTools, openRepoForChat, type ToolDeps } from "./tools.ts";
import { removeLeftoverStages, Updater } from "./updates.ts";
import { createBuildMapWorker } from "./worker.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface StartRederiveInput {
  chatId: string;
  source: string;
}

export function parseStartRederive(value: unknown): StartRederiveInput {
  const v = asRecord(value);
  const chatId = parseChatId(value);
  if (typeof v.source !== "string" || !v.source.trim()) throw new Error("Enter a folder path or git URL.");
  if (v.source.length > MAX_SOURCE_CHARS) throw new Error("The path or URL is too long.");
  return { chatId, source: v.source.trim() };
}

function asRecord(value: unknown): Record<string, unknown> {
  return (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
}

function parseChatId(value: unknown): string {
  const v = asRecord(value);
  if (typeof v.chatId !== "string" || !v.chatId || v.chatId.length > 200) throw new Error("A chat id is required.");
  return v.chatId;
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
  const maps = new MapStore(ctx.dataDirectory, listTasks);
  const deps: ToolDeps = {
    store,
    maps,
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

  // The graded cards (teacher only): free-text design and option pick. Grading reads the
  // map through the chat id.
  const graderDeps = {
    store,
    maps,
    catalog: () => ctx.inference.catalog(),
    complete: (request: Parameters<typeof ctx.inference.complete>[0]) => ctx.inference.complete(request),
  };
  ctx.registerQuestionType(createDesignQuestionType(graderDeps));
  ctx.registerQuestionType(createPickQuestionType(graderDeps));

  // Updates: check at startup and once a day while the setting is on; install only on a click.
  void removeLeftoverStages(ctx.directory);
  const updater = new Updater({
    manifest: ctx.manifest,
    directory: ctx.directory,
    // Global fetch; a parameter so tests can fake GitHub.
    fetch: (url, init) => fetch(url, init),
    signal: ctx.signal,
    onChange: (state) => ctx.events.emit(UPDATE_TOPIC, state),
  });
  let checkUpdates = settings.checkUpdates;
  const autoCheck = () => {
    if (checkUpdates && !ctx.signal.aborted) void updater.check();
  };
  autoCheck();
  const timer = setInterval(autoCheck, DAY_MS);
  timer.unref();
  ctx.cleanup(() => clearInterval(timer));
  ctx.handle(OPERATIONS.getUpdate, () => updater.state());
  ctx.handle(OPERATIONS.checkUpdate, () => updater.check());
  ctx.handle(OPERATIONS.installUpdate, () => updater.install());

  ctx.handle(OPERATIONS.getSettings, () => settingsStore.get());
  ctx.handle(OPERATIONS.saveSettings, async (input) => {
    const saved = await settingsStore.save(input);
    if (ctx.signal.aborted) return saved;
    applyInstructions(saved);
    // Turning checks on checks right away when nothing has been checked this run.
    const turnedOn = saved.checkUpdates && !checkUpdates;
    checkUpdates = saved.checkUpdates;
    if (turnedOn && updater.state().checkedAt === null) autoCheck();
    return saved;
  });

  // Top-bar action: open the repo, switch this chat to rederive and flag a restart. The
  // frontend puts a note in front of the next message; rederive_status also reports it.
  // Closing the dialog while the repo opens cancels it, a running clone included.
  const opening = new Map<string, AbortController>();
  ctx.handle(OPERATIONS.startRederive, async (input): Promise<StartRederiveResult> => {
    const { chatId, source } = parseStartRederive(input);
    opening.get(chatId)?.abort();
    const cancel = new AbortController();
    opening.set(chatId, cancel);
    try {
      const signal = AbortSignal.any([ctx.signal, cancel.signal]);
      const opened = await openRepoForChat(deps, chatId, source, signal);
      // Cancelled after the repo was recorded: at least leave the mode and the restart alone.
      if (signal.aborted) throw new Error("Cancelled.");
      await store.requestStart(chatId);
      return { repoName: opened.details.repo.name, warning: opened.details.warning ?? null };
    } finally {
      if (opening.get(chatId) === cancel) opening.delete(chatId);
    }
  });
  ctx.handle(OPERATIONS.cancelStart, (input) => {
    opening.get(parseChatId(input))?.abort();
    return null;
  });

  // The restart note: the frontend asks before each message in a teaching chat and
  // clears the start once the message carrying the note is accepted.
  ctx.handle(OPERATIONS.pendingStart, async (input): Promise<PendingStart | null> => store.pendingStart(parseChatId(input)));
  ctx.handle(OPERATIONS.clearStart, async (input) => {
    const stamp = asRecord(input).stamp;
    if (typeof stamp !== "string") throw new Error("A stamp is required.");
    await store.clearStart(parseChatId(input), stamp);
    return null;
  });

  // "Show rederive log": this chat's log, read-only. Adopting a finished map first means
  // a rebuild's carried-over log shows up even before the agent asks for a problem.
  ctx.handle(OPERATIONS.getLog, async (input): Promise<LogView> => {
    const { repo } = await store.getChat(parseChatId(input));
    if (!repo) return { repoName: null, path: null, text: "", archived: [] };
    return { repoName: repo.name, ...(await maps.logView(repo.id)) };
  });
}
