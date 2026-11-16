// Names shared by the backend and the browser bundle. Keep this file free of imports so
// the frontend never pulls in Node-only modules.

export const TOOL_NAMES = {
  openRepo: "rederive_open_repo",
  setMode: "rederive_set_mode",
  status: "rederive_status",
  setAuthorship: "rederive_set_authorship",
  buildMap: "rederive_build_map",
  nextProblem: "rederive_next_problem",
  logProblem: "rederive_log_problem",
  skipProblem: "rederive_skip_problem",
  /** The graded design card's teach tool: a host-built question tool, not one of ours to execute. */
  askDesign: "rederive_ask_design",
  /** The graded pick card's teach tool, also host-built. */
  askPick: "rederive_ask_pick",
} as const;

/** The top-bar action that shows the log; the agent points the learner to it by name. */
export const LOG_ACTION_NAME = "Show rederive log";

/** The "Rederive this repo" button puts this, then the repo name and ".)", in front of the next message. */
export const RESTART_NOTE_PREFIX = "(Rederive this repo: start fresh with";

export function restartNote(repoName: string): string {
  return `${RESTART_NOTE_PREFIX} ${repoName}.)`;
}

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
  pendingStart: "pending-start",
  clearStart: "clear-start",
  getUpdate: "get-update",
  checkUpdate: "check-update",
  installUpdate: "install-update",
} as const;

/** Backend → frontend notification topic carrying the new UpdateState. */
export const UPDATE_TOPIC = "update-state";

/** Where releases are published; the updater reads its latest release. */
export const RELEASES_REPO = "jayden-husein/rederive-lh";

/** What the updater knows, shared by the settings section and the sidebar button. */
export interface UpdateState {
  /** The running version (the manifest's). */
  current: string;
  /**
   * "release": installed from a release zip, so the updater can replace dist/.
   * "source": a git checkout that builds dist/; it updates with git pull and a build.
   */
  install: "release" | "source";
  checking: boolean;
  installing: boolean;
  /** The latest release, only when it is newer than what is running or installed. */
  available: { version: string; notesUrl: string } | null;
  /** Version installed during this run, waiting for a LearnHarness restart. */
  installed: string | null;
  /** ISO time of the last finished check, successful or not. */
  checkedAt: string | null;
  /** The last check's or install's failure, in plain words. */
  error: string | null;
}

/** A button press whose restart note has not reached the agent yet. */
export interface PendingStart {
  repoName: string;
  /** When the button was pressed; clearing checks it so a newer press survives. */
  stamp: string;
}

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
