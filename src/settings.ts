// Plugin settings in <dataDirectory>/settings.json. The host renders the settings rows
// but does not persist them, so the frontend loads and saves through these handlers.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";
import { MAX_SOURCE_CHARS } from "./names.ts";
import { withoutCredentials } from "./repo.ts";

/**
 * How the prober routes a chat about a codebase.
 * - auto: pick the mode from the learner's words; ask once only when the goal is unclear.
 * - ask: always ask the one routing question when a codebase comes up.
 * - always: every codebase chat starts in rederive mode.
 * - never: stay out of the way unless the learner explicitly asks for rederive.
 */
export const DEFAULT_MODES = ["auto", "ask", "always", "never"] as const;
export type DefaultMode = (typeof DEFAULT_MODES)[number];

export interface Settings {
  defaultMode: DefaultMode;
  /** Repo path or URL to suggest when the learner names no repo; "" for none. */
  defaultRepo: string;
  /** Check GitHub for a newer release at startup and once a day. */
  checkUpdates: boolean;
}

export const DEFAULT_SETTINGS: Settings = { defaultMode: "auto", defaultRepo: "", checkUpdates: true };


/** Validate untrusted input (frontend call or file contents). Throws with a readable message. */
export function parseSettings(value: unknown): Settings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Settings must be an object.");
  const v = value as Record<string, unknown>;
  const defaultMode = v.defaultMode ?? DEFAULT_SETTINGS.defaultMode;
  if (typeof defaultMode !== "string" || !(DEFAULT_MODES as readonly string[]).includes(defaultMode)) {
    throw new Error(`defaultMode must be one of ${DEFAULT_MODES.join(", ")}.`);
  }
  const defaultRepo = v.defaultRepo ?? DEFAULT_SETTINGS.defaultRepo;
  if (typeof defaultRepo !== "string") throw new Error("defaultRepo must be a string.");
  if (defaultRepo.length > MAX_SOURCE_CHARS) throw new Error(`defaultRepo is longer than ${MAX_SOURCE_CHARS} characters.`);
  const checkUpdates = v.checkUpdates ?? DEFAULT_SETTINGS.checkUpdates;
  if (typeof checkUpdates !== "boolean") throw new Error("checkUpdates must be true or false.");
  return { defaultMode: defaultMode as DefaultMode, defaultRepo: defaultRepo.trim(), checkUpdates };
}

function hasCredentials(source: string): boolean {
  return withoutCredentials(source) !== source;
}

export class SettingsStore {
  readonly file: string;
  private cache: Settings | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.file = join(dataDirectory, "settings.json");
  }

  /** Saved settings, or the defaults when the file is missing or its contents are invalid; other read errors throw. */
  async get(): Promise<Settings> {
    if (this.cache) return { ...this.cache };
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { ...DEFAULT_SETTINGS };
    }
    try {
      this.cache = parseSettings(JSON.parse(text));
      // Saved before save() refused these: the default repo goes into the prober's instructions.
      if (hasCredentials(this.cache.defaultRepo)) this.cache.defaultRepo = "";
    } catch {
      // A hand-edited or damaged file falls back to defaults; the next save replaces it.
      this.cache = { ...DEFAULT_SETTINGS };
    }
    return { ...this.cache };
  }

  async save(value: unknown): Promise<Settings> {
    const next = parseSettings(value);
    if (hasCredentials(next.defaultRepo)) {
      throw new Error("The default repo's URL holds a password or token. Remove it: the default repo is shown to the model on every turn.");
    }
    const run = this.queue.then(async () => {
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.cache = next;
      return { ...next };
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
