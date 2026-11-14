// Names shared by the backend and the browser bundle. Keep this file free of imports so
// the frontend never pulls in Node-only modules.

export const TOOL_NAMES = {
  openRepo: "rederive_open_repo",
  setMode: "rederive_set_mode",
  status: "rederive_status",
  buildMap: "rederive_build_map",
  nextProblem: "rederive_next_problem",
  logProblem: "rederive_log_problem",
  skipProblem: "rederive_skip_problem",
} as const;

/** The top-bar action that shows the log; the agent points the learner to it by name. */
export const LOG_ACTION_NAME = "Show rederive log";

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
  getLog: "get-log",
} as const;

/** What the get-log operation returns to the "Show rederive log" dialog. */
export interface LogView {
  /** Null when this chat has no repo open. */
  repoName: string | null;
  /** Full path of log.md, which may not exist yet. */
  path: string | null;
  /** The log text; "" when nothing is logged yet. */
  text: string;
  /** Logs set aside by earlier map rebuilds, newest first (file names only). */
  archived: string[];
}
