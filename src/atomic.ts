// Atomic file writes for plugin-owned state: write a sibling temp file, then rename it
// over the target. Windows can briefly refuse the rename (antivirus, indexer), so retry.
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, contents, "utf8");
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temp, path);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? "";
        if (!RETRYABLE.has(code) || attempt >= 5) throw error;
        await new Promise((r) => setTimeout(r, 20 * 2 ** attempt));
      }
    }
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
