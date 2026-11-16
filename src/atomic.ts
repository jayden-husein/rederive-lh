// Atomic file writes for plugin-owned state: write a sibling temp file, then rename it
// over the target. Windows can briefly refuse the rename (antivirus, indexer), so retry.
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Error codes Windows gives while another program briefly holds a file. */
export const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, contents, "utf8");
  try {
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/**
 * rename, retried with doubling waits while Windows briefly holds a file. The default 5
 * retries wait about 0.6 s in all; 10 wait about 20 s.
 */
export async function renameWithRetry(from: string, to: string, retries = 5): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!RETRYABLE.has(code) || attempt >= retries) throw error;
      await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
    }
  }
}
