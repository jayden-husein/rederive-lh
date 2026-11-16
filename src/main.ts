// Frontend entry: activated once per LearnHarness window while the plugin is enabled.
// Collapsed tool cards that never show the map, the settings rows, and the
// "Rederive this repo" top-bar action.
import type { PluginActionContext, PluginFrontendContext, PluginSettingsRow, PluginWidgetHandle } from "learnharness-plugin-api";
import { cardText, RENDERED_TOOLS } from "./cards.ts";
import { registerDesignCards } from "./design-view.ts";
import { sourceFromDraft } from "./draft.ts";
import { LOG_ACTION_NAME, MAX_SOURCE_CHARS, OPERATIONS, restartNote, type LogView, type PendingStart, type StartRederiveResult } from "./names.ts";
// Type-only: settings.ts is Node code and must stay out of the browser bundle.
import type { DefaultMode, Settings } from "./settings.ts";

/** Shown until the backend answers; the backend owns the real defaults. */
const PLACEHOLDER_SETTINGS: Settings = { defaultMode: "auto", defaultRepo: "" };

const tooLong = (value: string) => (value.length > MAX_SOURCE_CHARS ? "Too long." : undefined);

const MODE_OPTIONS: { value: DefaultMode; label: string }[] = [
  { value: "auto", label: "Auto: pick from the learner's goal" },
  { value: "ask", label: "Ask: always ask work-in vs explain" },
  { value: "always", label: "Always rederive codebases" },
  { value: "never", label: "Never: only when asked" },
];

const ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="12" r="2"/><path d="M6 8v8M8 6h4a4 4 0 0 1 4 4"/></svg>';

const LOG_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/></svg>';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerCards(ctx: PluginFrontendContext): void {
  for (const toolName of RENDERED_TOOLS) {
    ctx.registerToolRenderer({
      toolName,
      backgroundPresentation: "collapsed",
      mount(container, tool) {
        const line = container.ownerDocument.createElement("span");
        line.textContent = cardText(tool);
        container.append(line);
        return () => container.replaceChildren();
      },
    });
  }
}

function registerSettingsRows(ctx: PluginFrontendContext, settings: { current: Settings }): void {
  let handle: PluginWidgetHandle<{ rows: PluginSettingsRow[] }> | null = null;

  const save = async (patch: Partial<Settings>) => {
    try {
      const saved = await ctx.call<Settings>(OPERATIONS.saveSettings, { ...settings.current, ...patch });
      settings.current = saved;
    } finally {
      // Publish the accepted value: the saved one, or the previous one if the save failed
      // (the host reports the error).
      if (!ctx.signal.aborted) handle?.update({ rows: rows(settings.current, true) });
    }
  };

  const rows = (s: Settings, loaded: boolean): PluginSettingsRow[] => [
    {
      type: "dropdown",
      key: "defaultMode",
      label: "Default mode",
      description: "How a chat about a codebase picks between rederive, onboarding and normal teaching.",
      value: s.defaultMode,
      options: MODE_OPTIONS,
      disabled: !loaded,
      onChange: (value) => save({ defaultMode: value as DefaultMode }),
    },
    {
      type: "text",
      key: "defaultRepo",
      label: "Default repo",
      description: "Folder path or git URL suggested when you don't name a repo. Leave empty for none.",
      value: s.defaultRepo,
      disabled: !loaded,
      validate: tooLong,
      onChange: (value) => save({ defaultRepo: value }),
    },
  ];

  handle = ctx.registerSettings({ rows: rows(settings.current, false) });
  const load = () =>
    ctx
      .call<Settings>(OPERATIONS.getSettings)
      .then((s) => {
        settings.current = s;
      })
      .catch(() => undefined) // Keep what we have; a failed save will surface the error.
      .finally(() => {
        if (!ctx.signal.aborted) handle?.update({ rows: rows(settings.current, true) });
      });
  void load();
  ctx.onResync(() => void load());
}

/** Dialog: confirm the repo, then switch this chat to rederive mode. */
function openStartDialog(ctx: PluginFrontendContext, chatId: string, initialSource: string): void {
  const dialog = ctx.ui.openDialog(
    {
      title: "Rederive this repo",
      content: (container, signal) => {
        const doc = container.ownerDocument;
        const heading = doc.createElement("h2");
        heading.textContent = "Rederive this repo";
        const fieldSlot = doc.createElement("div");
        const status = doc.createElement("p");
        status.setAttribute("role", "status");
        const buttons = doc.createElement("div");
        buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
        const cancelSlot = doc.createElement("div");
        const startSlot = doc.createElement("div");
        buttons.append(cancelSlot, startSlot);
        container.append(heading, fieldSlot, status, buttons);

        let source = initialSource;
        let busy = false;
        let done = false;
        const fieldRow = (disabled: boolean): PluginSettingsRow => ({
          type: "text",
          key: "source",
          label: "Repo",
          description: "Full folder path or git URL. This chat switches to rederive mode.",
          value: source,
          disabled,
          validate: tooLong,
          onChange: (value) => {
            source = value;
            field.update({ rows: [fieldRow(busy || done)] });
          },
        });
        const field = ctx.ui.mountSettingsRows(fieldSlot, { rows: [fieldRow(false)] }, { signal });

        const cancel = ctx.ui.mountButton(cancelSlot, { label: "Cancel", variant: "ghost", onClick: () => dialog.dispose() }, { signal });
        const start = ctx.ui.mountButton(
          startSlot,
          {
            label: "Start",
            onClick: async () => {
              if (done) {
                dialog.dispose();
                return;
              }
              const trimmed = source.trim();
              if (!trimmed) {
                status.textContent = "Enter a folder path or git URL.";
                return;
              }
              busy = true;
              start.update({ disabled: true });
              field.update({ rows: [fieldRow(true)] });
              status.textContent = "Opening the repo…";
              try {
                const result = await ctx.call<StartRederiveResult>(OPERATIONS.startRederive, { chatId, source: trimmed });
                if (signal.aborted) return;
                done = true;
                // There is no public API to post a chat message, so the learner sends one.
                status.textContent =
                  `Rederive mode is on for "${result.repoName}". Send any message to start fresh: a note is added in front of it, and the tutor builds a new decision map.` +
                  (result.warning ? ` (${result.warning})` : "");
                start.update({ label: "Close", disabled: false });
                cancel.dispose();
              } catch (error) {
                if (signal.aborted) return;
                status.textContent = errorMessage(error);
                start.update({ disabled: false });
                field.update({ rows: [fieldRow(false)] });
              } finally {
                busy = false;
              }
            },
          },
          { signal },
        );
        return () => container.replaceChildren();
      },
    },
    { signal: ctx.signal },
  );
}

function registerStartAction(ctx: PluginFrontendContext, settings: { current: Settings }): void {
  ctx.registerAction({
    id: "rederive-repo",
    name: "Rederive this repo",
    icon: ICON,
    shortcut: { scope: { sessions: ["teaching"] }, defaultBinding: "mod+shift+r" },
    disabled: (context: PluginActionContext) => !("kind" in context) || context.kind !== "teaching",
    run: async (context) => {
      if (!("kind" in context) || context.surface !== "session" || context.kind !== "teaching") return;
      // A folder attached in the composer (path only) wins over the default repo.
      const attached = sourceFromDraft(context.view.composer.text);
      // Prefer fresh settings, but open the dialog even if the backend call fails.
      const latest = await ctx.call<Settings>(OPERATIONS.getSettings).catch(() => settings.current);
      settings.current = latest;
      openStartDialog(ctx, context.sessionId, attached ?? latest.defaultRepo);
    },
  });
  ctx.placeAction({ id: "rederive-repo-top-bar", actionId: "rederive-repo", location: "top-bar", sessions: ["teaching"] });
}

/** Read-only dialog with this chat's log: its path, a copy button and the text. */
function openLogDialog(ctx: PluginFrontendContext, chatId: string): void {
  const dialog = ctx.ui.openDialog(
    {
      title: LOG_ACTION_NAME,
      content: (container, signal) => {
        const doc = container.ownerDocument;
        const heading = doc.createElement("h2");
        heading.textContent = "Rederive log";
        const where = doc.createElement("p");
        // Long Windows paths have no spaces to break at. Small and muted, like a native caption.
        where.style.cssText = "overflow-wrap:anywhere;font-size:0.875rem;color:var(--muted-foreground)";
        const body = doc.createElement("pre");
        // The dialog inherits the UI font (JetBrains Mono), which read as bold for a page of notes
        // (in-app test, 2026-11-15): the log uses the prose font the chat's text uses.
        // In its own box, set apart from the path above and the buttons below.
        body.style.cssText =
          "white-space:pre-wrap;overflow-wrap:anywhere;max-height:55vh;overflow:auto;margin:12px 0;font-weight:400;" +
          "font-family:var(--font-prose);font-size:var(--lh-prose-size);line-height:var(--lh-prose-leading);" +
          "padding:12px 14px;border:1px solid var(--border);border-radius:8px;background:var(--background)";
        const buttons = doc.createElement("div");
        buttons.style.cssText = "display:flex;gap:8px;justify-content:flex-end;margin-top:12px";
        const copySlot = doc.createElement("div");
        const closeSlot = doc.createElement("div");
        buttons.append(copySlot, closeSlot);
        container.append(heading, where, body, buttons);
        where.textContent = "Loading…";
        ctx.ui.mountButton(closeSlot, { label: "Close", onClick: () => dialog.dispose() }, { signal });

        void ctx
          .call<LogView>(OPERATIONS.getLog, { chatId })
          .then((log) => {
            if (signal.aborted) return;
            if (!log.path) {
              where.textContent = "No repo is open in this chat. Use “Rederive this repo” first.";
              return;
            }
            // textContent only: the log holds model-written notes, never rendered as HTML.
            where.textContent = `${log.repoName}: ${log.path}`;
            body.textContent = log.text.trim() || "Nothing logged yet.";
            if (log.archived.length) {
              const note = doc.createElement("p");
              note.style.cssText = where.style.cssText;
              note.textContent = `Logs from before a map rebuild sit in the same folder: ${log.archived.join(", ")}.`;
              container.insertBefore(note, buttons);
            }
            const path = log.path;
            const copy = ctx.ui.mountButton(
              copySlot,
              {
                label: "Copy path",
                variant: "ghost",
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(path);
                    copy.update({ label: "Copied" });
                  } catch {
                    copy.update({ label: "Couldn't copy" });
                  }
                },
              },
              { signal },
            );
          })
          .catch((error: unknown) => {
            if (!signal.aborted) where.textContent = errorMessage(error);
          });
        return () => container.replaceChildren();
      },
    },
    { signal: ctx.signal },
  );
}

function registerLogAction(ctx: PluginFrontendContext): void {
  ctx.registerAction({
    id: "rederive-log",
    name: LOG_ACTION_NAME,
    icon: LOG_ICON,
    disabled: (context: PluginActionContext) => !("kind" in context) || context.kind !== "teaching",
    run: (context) => {
      if (!("kind" in context) || context.surface !== "session" || context.kind !== "teaching") return;
      openLogDialog(ctx, context.sessionId);
    },
  });
  ctx.placeAction({ id: "rederive-log-top-bar", actionId: "rederive-log", location: "top-bar", sessions: ["teaching"] });
}

/**
 * After "Rederive this repo", put a short visible note in front of the learner's next
 * message in that chat, so the agent can't miss the restart (a note in a tool description
 * was ignored in testing). The backend holds the pending start, so it survives a reload;
 * it is cleared only once the message is accepted.
 */
function registerRestartNote(ctx: PluginFrontendContext): void {
  ctx.registerSubmissionInterceptor({
    id: "rederive-restart-note",
    async intercept(input, context) {
      if (input.type !== "text" || context.sessionKind !== "teaching") return undefined;
      const chatId = context.sessionId;
      // A failed lookup must never block the learner's message: send it unchanged.
      const pending = await ctx.call<PendingStart | null>(OPERATIONS.pendingStart, { chatId }).catch(() => null);
      if (!pending || context.signal.aborted) return undefined;
      context.onAccepted(() => ctx.call(OPERATIONS.clearStart, { chatId, stamp: pending.stamp }).then(() => undefined));
      const text = input.content.text.trim() ? `${restartNote(pending.repoName)}\n\n${input.content.text}` : restartNote(pending.repoName);
      return { type: "text", content: { ...input.content, text } };
    },
  });
}

export function activate(ctx: PluginFrontendContext): void {
  const settings = { current: { ...PLACEHOLDER_SETTINGS } };
  registerCards(ctx);
  registerDesignCards(ctx);
  registerSettingsRows(ctx, settings);
  registerStartAction(ctx, settings);
  registerLogAction(ctx);
  registerRestartNote(ctx);
}
