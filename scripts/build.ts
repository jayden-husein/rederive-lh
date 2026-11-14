// Builds the runtime package into dist/ (the folder LearnHarness loads):
//   dist/manifest.json, dist/backend.cjs (Node CommonJS), dist/main.js (browser ESM).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { cleanDist } from "./clean-dist.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

cleanDist(dist);
mkdirSync(dist);

await Promise.all([
  build({
    entryPoints: [join(root, "src", "backend.ts")],
    outfile: join(dist, "backend.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    packages: "bundle",
    logLevel: "warning",
  }),
  build({
    entryPoints: [join(root, "src", "main.ts")],
    outfile: join(dist, "main.js"),
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "warning",
  }),
]);

copyFileSync(join(root, "src", "manifest.json"), join(dist, "manifest.json"));
console.log(`Built ${dist}`);
