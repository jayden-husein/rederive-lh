// Safe removal of the generated dist/ directory.
// The sibling data/ directory belongs to LearnHarness at runtime and must never be touched,
// so this refuses anything that looks like data could be reached through dist/.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { basename } from "node:path";

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Delete `distDir` if it is a real directory with no `data` entry. Missing is fine. */
export function cleanDist(distDir: string): void {
  if (basename(distDir) !== "dist") {
    throw new Error(`Refusing to clean ${distDir}: not a dist directory.`);
  }
  const stat = lstatOrNull(distDir);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing to clean ${distDir}: it is a symlink or junction.`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Refusing to clean ${distDir}: not a directory.`);
  }
  const misplacedData = readdirSync(distDir).find((entry) => entry.toLowerCase() === "data");
  if (misplacedData !== undefined) {
    throw new Error(
      `Refusing to clean ${distDir}: it contains "${misplacedData}". ` +
        "Plugin data belongs in the sibling data/ directory; move it there first.",
    );
  }
  rmSync(distDir, { recursive: true });
}
