// Per-chat state in <dataDirectory>/sessions.json: the chat's mode and which repo it
// is studying, plus the registry of known repos. Writes are serialized and atomic.
import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.ts";

export const MODES = ["rederive", "onboarding", "normal"] as const;
export type Mode = (typeof MODES)[number];

export interface RepoRecord {
  /** Stable key: hash of the normalized path or URL. Also the folder under repos/. */
  id: string;
  /** Display name (folder or URL basename). Not unique. */
  name: string;
  kind: "local" | "url";
  /** What the learner gave: a path or a URL. */
  source: string;
  /** Directory git and file reads run in: the local path, or our clone for URLs. */
  path: string;
  openedAt: string;
}

export interface ChatRecord {
  mode?: Mode;
  repoId?: string;
  updatedAt: string;
}

interface SessionsFile {
  version: 1;
  chats: Record<string, ChatRecord>;
  repos: Record<string, RepoRecord>;
}

function emptyFile(): SessionsFile {
  return { version: 1, chats: {}, repos: {} };
}

function isSessionsFile(value: unknown): value is SessionsFile {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<SessionsFile>;
  return v.version === 1 && typeof v.chats === "object" && v.chats !== null
    && typeof v.repos === "object" && v.repos !== null;
}

export interface ChatState {
  mode: Mode | null;
  repo: RepoRecord | null;
}

export class SessionStore {
  readonly file: string;
  private cache: SessionsFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly now: () => Date;

  constructor(dataDirectory: string, now: () => Date = () => new Date()) {
    this.file = join(dataDirectory, "sessions.json");
    this.now = now;
  }

  /** Run `fn` after every earlier operation finishes, so read-modify-write never interleaves. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async load(): Promise<SessionsFile> {
    if (this.cache) return this.cache;
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.cache = emptyFile();
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (!isSessionsFile(parsed)) {
      // Keep the unreadable file for inspection instead of overwriting it.
      const stamp = this.now().toISOString().replace(/[:.]/g, "-");
      await rename(this.file, `${this.file}.corrupt-${stamp}`);
      parsed = emptyFile();
    }
    this.cache = parsed as SessionsFile;
    return this.cache;
  }

  private async mutate<T>(fn: (data: SessionsFile) => T): Promise<T> {
    return this.serialize(async () => {
      const current = await this.load();
      const next = structuredClone(current);
      const result = fn(next);
      await writeFileAtomic(this.file, `${JSON.stringify(next, null, 2)}\n`);
      this.cache = next;
      return result;
    });
  }

  async getChat(chatId: string): Promise<ChatState> {
    return this.serialize(async () => {
      const data = await this.load();
      const chat = data.chats[chatId];
      const repo = chat?.repoId ? data.repos[chat.repoId] ?? null : null;
      return { mode: chat?.mode ?? null, repo: repo ? { ...repo } : null };
    });
  }

  async setMode(chatId: string, mode: Mode): Promise<void> {
    await this.mutate((data) => {
      data.chats[chatId] = { ...data.chats[chatId], mode, updatedAt: this.now().toISOString() };
    });
  }

  /** Register (or refresh) a repo and make it this chat's current repo. */
  async setRepo(chatId: string, repo: Omit<RepoRecord, "openedAt">): Promise<RepoRecord> {
    return this.mutate((data) => {
      const stamp = this.now().toISOString();
      const record: RepoRecord = { ...repo, openedAt: stamp };
      data.repos[repo.id] = record;
      data.chats[chatId] = { ...data.chats[chatId], repoId: repo.id, updatedAt: stamp };
      return { ...record };
    });
  }

  async getRepo(repoId: string): Promise<RepoRecord | null> {
    return this.serialize(async () => {
      const repo = (await this.load()).repos[repoId];
      return repo ? { ...repo } : null;
    });
  }
}
