// Builds the runtime package into dist/ (the folder LearnHarness loads):
//   dist/manifest.json, dist/backend.cjs (Node CommonJS), dist/main.js (browser ESM),
//   dist/styles.css, and the license texts a release zip must carry.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { cleanDist } from "./clean-dist.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

// Bundle in memory first: a build that fails must leave the installed dist/ as it was.
const bundles = await Promise.all([
  build({
    entryPoints: [join(root, "src", "backend.ts")],
    outfile: join(dist, "backend.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "bundle",
    logLevel: "warning",
    write: false,
  }),
  build({
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(dist, "main.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "warning",
    write: false,
  }),
]);

cleanDist(dist);
mkdirSync(dist);
for (const file of bundles.flatMap((b) => b.outputFiles)) writeFileSync(file.path, file.contents);
copyFileSync(join(root, "src", "manifest.json"), join(dist, "manifest.json"));
copyFileSync(join(root, "src", "styles.css"), join(dist, "styles.css"));
// The zip is a copy of this plugin and of the TypeBox code bundled into backend.cjs.
for (const notice of ["LICENSE", "THIRD_PARTY.md"]) copyFileSync(join(root, notice), join(dist, notice));
console.log(`Built ${dist}`);
