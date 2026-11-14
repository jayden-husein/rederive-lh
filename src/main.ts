// Frontend entry: activated once per LearnHarness window while the plugin is enabled.
// Collapsed tool cards that never show the map, the settings rows, and the
// "Rederive this repo" top-bar action.
import type { PluginActionContext, PluginFrontendContext, PluginSettingsRow, PluginWidgetHandle } from "learnharness-plugin-api";
import { cardText, RENDERED_TOOLS } from "./cards.ts";
import { MAX_SOURCE_CHARS, OPERATIONS, type StartRederiveResult } from "./names.ts";
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
          description: "Folder path (Windows or \\\\wsl.localhost\\…) or git URL. This chat switches to rederive mode.",
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
                status.textContent =
                  `Rederive mode is on for "${result.repoName}". Send a message to begin; the tutor builds the decision map first.` +
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
      // Prefer fresh settings, but open the dialog even if the backend call fails.
      const latest = await ctx.call<Settings>(OPERATIONS.getSettings).catch(() => settings.current);
      settings.current = latest;
      openStartDialog(ctx, context.sessionId, latest.defaultRepo);
    },
  });
  ctx.placeAction({ id: "rederive-repo-top-bar", actionId: "rederive-repo", location: "top-bar", sessions: ["teaching"] });
}

export function activate(ctx: PluginFrontendContext): void {
  const settings = { current: { ...PLACEHOLDER_SETTINGS } };
  registerCards(ctx);
  registerSettingsRows(ctx, settings);
  registerStartAction(ctx, settings);
}
