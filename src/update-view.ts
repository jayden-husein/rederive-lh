// Frontend for self-updates: the Updates panel (in Rederive's settings and in the update
// dialog) and an "Update Rederive" sidebar button placed only while an update waits.
// The backend owns the state and pushes every change on UPDATE_TOPIC.
import type { PluginFrontendContext } from "learnharness-plugin-api";
import { OPERATIONS, UPDATE_TOPIC, type UpdateState } from "./names.ts";

const UPDATE_ICON =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>';

const MUTED = "color:var(--muted-foreground);font-size:0.875rem";

/** The panel's one status line. */
export function updateStatusText(s: UpdateState | null): string {
  if (!s) return "Loading…";
  if (s.installing) return `Downloading and installing ${s.available?.version ?? "the update"}…`;
  if (s.installed) return `Updated to ${s.installed}. Restart LearnHarness to finish.`;
  if (s.checking) return "Checking for updates…";
  if (s.error) return s.error;
  if (s.available) {
    const line = `Version ${s.available.version} is available. You have ${s.current}.`;
    return s.install === "source" ? `${line} This copy is a git checkout: update it with git pull, then npm run build.` : line;
  }
  if (s.checkedAt) return `Rederive ${s.current} is up to date.`;
  return `Rederive ${s.current}. Not checked yet.`;
}

/** A release copy has a newer version waiting to install (the sidebar button's condition). */
export function updateWaiting(s: UpdateState | null): boolean {
  return !!s && s.install === "release" && !!s.available && !s.installed;
}

/** Whether the Update button works right now: an update waits and nothing is running. */
export function canInstall(s: UpdateState | null): boolean {
  return updateWaiting(s) && !s!.installing && !s!.checking;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface UpdatesUi {
  /** Mount the settings page's Updates section; it follows the state until `signal` aborts. */
  mountSection(container: HTMLElement, signal: AbortSignal): void;
}

export function registerUpdates(ctx: PluginFrontendContext): UpdatesUi {
  let state: UpdateState | null = null;
  const listeners = new Set<(s: UpdateState | null) => void>();
  const publish = (next: UpdateState | null) => {
    state = next;
    syncSidebar();
    for (const listener of listeners) listener(state);
  };

  const load = async (): Promise<void> => {
    try {
      const s = await ctx.call<UpdateState>(OPERATIONS.getUpdate);
      if (!ctx.signal.aborted) publish(s);
    } catch {
      // Keep what we have; the next push or resync refreshes it.
    }
  };
  // Resolves when the operation is done, so the host shows the button busy until then.
  const run = async (operation: string): Promise<void> => {
    try {
      const s = await ctx.call<UpdateState>(operation);
      if (!ctx.signal.aborted) publish(s);
    } catch (error) {
      // Clicked before the first load answered: load now, so the error has a state to sit in.
      if (!state) await load();
      if (!ctx.signal.aborted && state) publish({ ...state, error: errorMessage(error) });
    }
  };

  // Sidebar button, placed only while a one-click update waits.
  ctx.registerAction({
    id: "rederive-update",
    name: "Update Rederive",
    icon: UPDATE_ICON,
    run: () => openUpdateDialog(),
  });
  let unplace: (() => void) | null = null;
  function syncSidebar() {
    if (ctx.signal.aborted) return;
    const want = updateWaiting(state);
    if (want && !unplace) unplace = ctx.placeAction({ id: "rederive-update-sidebar", actionId: "rederive-update", location: "sidebar" });
    if (!want && unplace) {
      unplace();
      unplace = null;
    }
  }

  function mountPanel(container: HTMLElement, signal: AbortSignal) {
    const doc = container.ownerDocument;
    const status = doc.createElement("p");
    status.style.cssText = `${MUTED};margin:4px 0 8px`;
    status.setAttribute("aria-live", "polite");
    const notes = doc.createElement("a");
    notes.textContent = "Release notes";
    notes.target = "_blank";
    notes.rel = "noopener noreferrer";
    notes.style.cssText = "font-size:0.875rem;text-decoration:underline";
    const buttons = doc.createElement("div");
    buttons.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:8px";
    const installSlot = doc.createElement("div");
    const checkSlot = doc.createElement("div");
    buttons.append(installSlot, checkSlot);
    container.append(status, notes, buttons);

    const install = ctx.ui.mountButton(installSlot, { label: "Update", onClick: () => run(OPERATIONS.installUpdate) }, { signal });
    const check = ctx.ui.mountButton(
      checkSlot,
      { label: "Check now", variant: "outline", onClick: () => run(OPERATIONS.checkUpdate) },
      { signal },
    );

    const render = (s: UpdateState | null) => {
      status.textContent = updateStatusText(s);
      const notesUrl = s?.available?.notesUrl;
      notes.hidden = !notesUrl;
      if (notesUrl) notes.href = notesUrl;
      installSlot.hidden = !canInstall(s) && !s?.installing;
      install.update({ label: s?.available ? `Update to ${s.available.version}` : "Update", disabled: !canInstall(s) });
      check.update({ disabled: !s || s.checking || s.installing });
    };
    render(state);
    listeners.add(render);
    signal.addEventListener("abort", () => listeners.delete(render), { once: true });
  }

  /** The panel under an "Updates" heading, set apart from the settings rows above. */
  function mountSection(container: HTMLElement, signal: AbortSignal) {
    const doc = container.ownerDocument;
    const section = doc.createElement("section");
    section.style.cssText = "margin-top:20px;padding-top:16px;border-top:1px solid var(--border)";
    const heading = doc.createElement("h3");
    heading.textContent = "Updates";
    heading.style.cssText = "font-size:1rem;font-weight:600;margin:0";
    const panel = doc.createElement("div");
    section.append(heading, panel);
    container.append(section);
    mountPanel(panel, signal);
  }

  function openUpdateDialog() {
    const dialog = ctx.ui.openDialog(
      {
        title: "Update Rederive",
        content: (container, signal) => {
          const doc = container.ownerDocument;
          const heading = doc.createElement("h2");
          heading.textContent = "Update Rederive";
          const panel = doc.createElement("div");
          const closeRow = doc.createElement("div");
          closeRow.style.cssText = "display:flex;justify-content:flex-end;margin-top:12px";
          container.append(heading, panel, closeRow);
          mountPanel(panel, signal);
          ctx.ui.mountButton(closeRow, { label: "Close", variant: "ghost", onClick: () => dialog.dispose() }, { signal });
          return () => container.replaceChildren();
        },
      },
      { signal: ctx.signal },
    );
  }

  ctx.onNotification((event) => {
    if (event.topic === UPDATE_TOPIC && event.data) publish(event.data as UpdateState);
  });
  ctx.onResync(() => void load());
  void load();

  return { mountSection };
}
