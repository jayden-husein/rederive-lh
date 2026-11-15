// Backend entry: activated once per LearnHarness server while the plugin is enabled.
import type { PluginBackendContext } from "learnharness-plugin-api";
import { proberInstructions, teacherInstructions } from "./instructions.ts";
import { MapStore } from "./map-store.ts";
import { MAX_SOURCE_CHARS, OPERATIONS, type LogView, type PendingStart, type StartRederiveResult } from "./names.ts";
import { createDesignQuestionType, createPickQuestionType } from "./grading.ts";
import { SessionStore } from "./sessions.ts";
import { SettingsStore, type Settings } from "./settings.ts";
import { createTools, openRepoForChat, type ToolDeps } from "./tools.ts";
import { createBuildMapWorker } from "./worker.ts";

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

  ctx.handle(OPERATIONS.getSettings, () => settingsStore.get());
  ctx.handle(OPERATIONS.saveSettings, async (input) => {
    const saved = await settingsStore.save(input);
    if (!ctx.signal.aborted) applyInstructions(saved);
    return saved;
  });

  // Top-bar action: open the repo, switch this chat to rederive and flag a restart. The
  // frontend puts a note in front of the next message; rederive_status also reports it.
  ctx.handle(OPERATIONS.startRederive, async (input): Promise<StartRederiveResult> => {
    const { chatId, source } = parseStartRederive(input);
    const opened = await openRepoForChat(deps, chatId, source, ctx.signal);
    await store.requestStart(chatId);
    return { repoName: opened.details.repo.name, warning: opened.details.warning ?? null };
  });

  // The restart note: the frontend asks before each message in a teaching chat and
  // clears the start once the message carrying the note is accepted.
  ctx.handle(OPERATIONS.pendingStart, async (input): Promise<PendingStart | null> => {
    const state = await store.getChat(parseChatId(input));
    return state.startPending && state.repo ? { repoName: state.repo.name, stamp: state.startPending } : null;
  });
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
