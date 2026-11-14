// Names shared by the backend and the browser bundle. Keep this file free of imports so
// the frontend never pulls in Node-only modules.

export const TOOL_NAMES = {
  openRepo: "rederive_open_repo",
  setMode: "rederive_set_mode",
  status: "rederive_status",
  buildMap: "rederive_build_map",
  nextProblem: "rederive_next_problem",
  logProblem: "rederive_log_problem",
} as const;

/** Longest repo path or URL accepted from settings or the top-bar action. */
export const MAX_SOURCE_CHARS = 1000;

/** What the start-rederive operation returns to the action's dialog. */
export interface StartRederiveResult {
  repoName: string;
  warning: string | null;
}

/** Frontend → backend operation names (ctx.handle / ctx.call). */
export const OPERATIONS = {
  getSettings: "get-settings",
  saveSettings: "save-settings",
  startRederive: "start-rederive",
} as const;
