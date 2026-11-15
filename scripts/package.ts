// Zips the built dist/ into release/rederive-lh-<version>.zip for a GitHub release.
// Users extract it into <plugins directory>\rederive-lh\dist\. Run `npm run package`,
// which builds first. Refuses a dirty working tree, so the zip always matches a commit.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createZip } from "./zip.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const dirty = git("status", "--porcelain");
if (dirty) {
  console.error(`Commit or stash these changes first, so the zip matches a commit:\n${dirty}`);
  process.exit(1);
}
const commit = git("rev-parse", "--short", "HEAD");
// `npm run package` runs this first with --check, so a dirty tree stops it before the build.
if (process.argv.includes("--check")) process.exit(0);
const dist = join(root, "dist");
const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as { id: string; version: string };

const files = readdirSync(dist, { withFileTypes: true });
const dirs = files.filter((f) => !f.isFile()).map((f) => f.name);
if (dirs.length > 0) throw new Error(`dist/ should hold only files; found ${dirs.join(", ")}`);

const entries = files.map((f) => ({ name: f.name, data: readFileSync(join(dist, f.name)) }));
const out = join(root, "release", `${manifest.id}-${manifest.version}.zip`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, createZip(entries));
console.log(`Wrote ${out} from commit ${commit} (${entries.map((e) => e.name).join(", ")})`);
