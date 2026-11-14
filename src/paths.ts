// Path confinement for reading inside a learner's repo. Every path the map worker
// touches goes through `resolveInsideRoot`, which rejects `..`, absolute paths and
// symlinks/junctions that resolve outside the repo root.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathEscapeError";
  }
}

/** Case-insensitive comparison for Windows drive paths; UNC paths into WSL keep case. */
function comparable(path: string): string {
  return process.platform === "win32" && !path.startsWith("\\\\") ? path.toLowerCase() : path;
}

/** True when `child` is `root` or lies beneath it. Both must already be absolute. */
export function isWithin(root: string, child: string): boolean {
  const rel = relative(comparable(root), comparable(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Resolve a repo-relative path to a real absolute path inside `root`.
 * `root` must itself be a real path (pass the result of `realpath`).
 * Rejects absolute input, `..` segments, and links escaping the root.
 * A missing target rejects with the underlying ENOENT error.
 */
export async function resolveInsideRoot(root: string, relativePath: string): Promise<string> {
  const input = relativePath.trim() === "" ? "." : relativePath;
  if (isAbsolute(input) || win32.isAbsolute(input) || /^[a-zA-Z]:/.test(input)) {
    throw new PathEscapeError(`Path must be relative to the repo root: ${relativePath}`);
  }
  if (input.split(/[\\/]+/).includes("..")) {
    throw new PathEscapeError(`Path may not contain "..": ${relativePath}`);
  }
  const candidate = resolve(root, input);
  if (!isWithin(root, candidate)) throw new PathEscapeError(`Path is outside the repo: ${relativePath}`);
  const real = await realpath(candidate);
  if (!isWithin(root, real)) {
    throw new PathEscapeError(`Path links outside the repo: ${relativePath}`);
  }
  return real;
}

/** Display form of a path relative to the root, always with forward slashes. */
export function displayRelative(root: string, absolute: string): string {
  const rel = relative(root, absolute);
  return rel === "" ? "." : rel.split(sep).join("/");
}
