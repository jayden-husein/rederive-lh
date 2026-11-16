import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { createZip } from "../scripts/zip.ts";
import type { UpdateState } from "../src/names.ts";
import { checkPackage, isNewer, parseRelease, removeLeftoverStages, replaceDist, Updater, type Fetch } from "../src/updates.ts";
import { readZip } from "../src/unzip.ts";
import { canInstall, updateStatusText } from "../src/update-view.ts";
import { removeDir, tempDir } from "./helpers.ts";

const dirs: string[] = [];
after(() => dirs.forEach(removeDir));

const ID = "rederive-lh";
const ASSET_URL = "https://github.com/jayden-husein/rederive-lh/releases/download/v0.3.0/rederive-lh-0.3.0.zip";

/** The running plugin's manifest identity. */
const RUNNING = { id: ID, version: "0.2.0", minAppVersion: "0.6.1" };
/** What checkPackage expects for a 0.3.0 release. */
const EXPECT_030 = { ...RUNNING, version: "0.3.0" };

function manifest(version: string, minAppVersion = "0.6.1") {
  return { apiVersion: 1, id: ID, name: "Rederive", version, minAppVersion, main: "main.js", backend: "backend.cjs", styles: "styles.css" };
}

function packageZip(version: string, extra: { name: string; data: Buffer }[] = [], minAppVersion = "0.6.1"): Buffer {
  return createZip([
    { name: "manifest.json", data: Buffer.from(JSON.stringify(manifest(version, minAppVersion))) },
    { name: "backend.cjs", data: Buffer.from(`// backend ${version}`) },
    { name: "main.js", data: Buffer.from(`// main ${version}`) },
    { name: "styles.css", data: Buffer.from("") },
    ...extra,
  ]);
}

function releaseJson(version: string, zip: Buffer, digest = `sha256:${createHash("sha256").update(zip).digest("hex")}`) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/jayden-husein/rederive-lh/releases/tag/v${version}`,
    assets: [{ name: `${ID}-${version}.zip`, browser_download_url: ASSET_URL, size: zip.length, digest }],
  };
}

/** An installed plugin folder: dist/ with old files and a data/ sibling. */
function installed(): { plugin: string; dist: string } {
  const plugin = join(tempDir("update"), ID);
  dirs.push(plugin);
  const dist = join(plugin, "dist");
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, "manifest.json"), JSON.stringify(manifest("0.2.0")));
  writeFileSync(join(dist, "backend.cjs"), "// backend 0.2.0");
  writeFileSync(join(dist, "stale.js"), "// only in the old version");
  mkdirSync(join(plugin, "data", "repos"), { recursive: true });
  writeFileSync(join(plugin, "data", "settings.json"), '{"defaultMode":"never"}');
  return { plugin, dist };
}

function fakeGitHub(release: object | number, zip: Buffer): { fetch: Fetch; urls: string[] } {
  const urls: string[] = [];
  const fetch: Fetch = async (url) => {
    urls.push(url);
    if (url.startsWith("https://api.github.com/")) {
      return typeof release === "number" ? new Response("", { status: release }) : Response.json(release);
    }
    return new Response(new Uint8Array(zip));
  };
  return { fetch, urls };
}

function updater(dist: string, fetch: Fetch, states: UpdateState[] = []) {
  return new Updater({ manifest: RUNNING, directory: dist, fetch, signal: new AbortController().signal, onChange: (s) => states.push(s) });
}

test("versions compare by number, and anything unparseable is never newer", () => {
  assert.equal(isNewer("0.10.0", "0.9.9"), true);
  assert.equal(isNewer("v1.0.0", "0.99.0"), true);
  assert.equal(isNewer("0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.1.9", "0.2.0"), false);
  assert.equal(isNewer("0.3.0-beta", "0.2.0"), false);
  assert.equal(isNewer("latest", "0.2.0"), false);
});

test("the zip reader reads what the release packager writes, and checks CRCs", () => {
  const zip = packageZip("0.3.0");
  const entries = readZip(zip, { maxTotalBytes: 1_000_000 });
  assert.deepEqual(entries.map((e) => e.name), ["manifest.json", "backend.cjs", "main.js", "styles.css"]);
  assert.equal(entries[1]!.data.toString(), "// backend 0.3.0");

  const damaged = Buffer.from(zip);
  damaged[60] = damaged[60]! ^ 0xff; // inside the first entry's compressed data
  assert.throws(() => readZip(damaged, { maxTotalBytes: 1_000_000 }));
  assert.throws(() => readZip(zip, { maxTotalBytes: 10 }), /unpacks to more than expected/);
  assert.throws(() => readZip(Buffer.from("not a zip at all, honestly"), { maxTotalBytes: 100 }), /Not a zip file/);
});

test("a release needs <id>-<version>.zip with a sha256 digest", () => {
  const zip = packageZip("0.3.0");
  const release = parseRelease(releaseJson("0.3.0", zip), ID);
  assert.equal(release.version, "0.3.0");
  assert.equal(release.asset.size, zip.length);
  assert.throws(() => parseRelease(releaseJson("0.3.0", zip, ""), ID), /no SHA-256/);
  assert.throws(() => parseRelease({ ...releaseJson("0.3.0", zip), assets: [] }, ID), /has no rederive-lh-0.3.0.zip/);
  assert.throws(() => parseRelease({ tag_name: "nightly" }, ID), /not a version/);
});

test("a package must be flat, for this plugin, at the expected version, with its entry files", () => {
  assert.deepEqual([...checkPackage(packageZip("0.3.0"), EXPECT_030).keys()].sort(), [
    "backend.cjs",
    "main.js",
    "manifest.json",
    "styles.css",
  ]);
  assert.throws(() => checkPackage(packageZip("0.3.0"), { ...RUNNING, version: "0.4.0" }), /holds version 0.3.0, not 0.4.0/);
  assert.throws(() => checkPackage(packageZip("0.3.0"), { ...EXPECT_030, id: "other" }), /another plugin/);
  const nested = packageZip("0.3.0", [{ name: "sub/x.js", data: Buffer.from("") }]);
  assert.throws(() => checkPackage(nested, EXPECT_030), /unexpected entry: sub\/x.js/);
  const twice = packageZip("0.3.0", [{ name: "MAIN.js", data: Buffer.from("") }]);
  assert.throws(() => checkPackage(twice, EXPECT_030), /twice/);
  const noBackend = createZip([{ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest("0.3.0"))) }]);
  assert.throws(() => checkPackage(noBackend, EXPECT_030), /names main.js, which the zip lacks/);
});

test("a release that raises minAppVersion is refused, since the app's version can't be read", () => {
  assert.throws(
    () => checkPackage(packageZip("0.3.0", [], "0.7.0"), EXPECT_030),
    /needs LearnHarness 0.7.0 or later\. Update LearnHarness first, then install this release by hand/,
  );
  assert.throws(() => checkPackage(packageZip("0.3.0", [], "soon"), EXPECT_030), /no valid minAppVersion/);
  // Lowering or keeping it is fine.
  assert.ok(checkPackage(packageZip("0.3.0", [], "0.6.0"), EXPECT_030).has("manifest.json"));
});

test("leftover staging folders beside dist are removed at startup, nothing else", async () => {
  const { plugin, dist } = installed();
  mkdirSync(join(plugin, ".update-abc123", "previous"), { recursive: true });
  writeFileSync(join(plugin, ".update-keep.txt"), "a file, not a staging folder");
  await removeLeftoverStages(dist);
  assert.deepEqual(readdirSync(plugin).sort(), [".update-keep.txt", "data", "dist"]);
});

test("replacing dist swaps in the new files, drops stale ones and leaves data alone", async () => {
  const { plugin, dist } = installed();
  await replaceDist(dist, checkPackage(packageZip("0.3.0"), EXPECT_030));
  assert.deepEqual(readdirSync(dist).sort(), ["backend.cjs", "main.js", "manifest.json", "styles.css"]);
  assert.equal(readFileSync(join(dist, "backend.cjs"), "utf8"), "// backend 0.3.0");
  assert.equal(readFileSync(join(plugin, "data", "settings.json"), "utf8"), '{"defaultMode":"never"}');
  assert.deepEqual(readdirSync(plugin).sort(), ["data", "dist"], "no staging folder left behind");
});

test("a failure before the swap leaves the old dist in place", async () => {
  const { plugin, dist } = installed();
  const files = new Map([["bad\0name", Buffer.from("")]]);
  await assert.rejects(replaceDist(dist, files));
  assert.equal(readFileSync(join(dist, "backend.cjs"), "utf8"), "// backend 0.2.0");
  assert.deepEqual(readdirSync(plugin).sort(), ["data", "dist"]);
});

test("replacing refuses anything but a dist folder, and a dist holding data", async () => {
  const { plugin, dist } = installed();
  await assert.rejects(replaceDist(join(plugin, "data"), new Map()), /not a dist directory/);
  mkdirSync(join(dist, "data"));
  await assert.rejects(replaceDist(dist, new Map()), /holds a data folder/);
});

test("check finds a newer release, install puts it in dist and waits for a restart", async () => {
  const { dist } = installed();
  const zip = packageZip("0.3.0");
  const github = fakeGitHub(releaseJson("0.3.0", zip), zip);
  const states: UpdateState[] = [];
  const u = updater(dist, github.fetch, states);
  assert.equal(u.state().install, "release");
  await assert.rejects(u.install(), /Check for updates first/);

  const checked = await u.check();
  assert.deepEqual(checked.available, { version: "0.3.0", notesUrl: "https://github.com/jayden-husein/rederive-lh/releases/tag/v0.3.0" });
  assert.equal(checked.error, null);
  assert.ok(checked.checkedAt);
  assert.equal(states[0]!.checking, true, "windows hear that a check started");
  assert.equal(canInstall(checked), true);
  assert.equal(updateStatusText(checked), "Version 0.3.0 is available. You have 0.2.0.");

  const done = await u.install();
  assert.equal(done.installed, "0.3.0");
  assert.equal(done.available, null);
  assert.equal(done.error, null);
  assert.equal(JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")).version, "0.3.0");
  assert.deepEqual(github.urls.at(-1), ASSET_URL);
  assert.equal(updateStatusText(done), "Updated to 0.3.0. Restart LearnHarness to finish.");
  assert.equal(canInstall(done), false);

  // A later check compares with what is now on disk, so the same release is not offered again.
  assert.equal((await u.check()).available, null);
});

test("a download that doesn't match GitHub's digest is not installed", async () => {
  const { dist } = installed();
  const zip = packageZip("0.3.0");
  const tampered = packageZip("0.3.0", [{ name: "extra.js", data: Buffer.from("// injected") }]);
  const u = updater(dist, fakeGitHub(releaseJson("0.3.0", zip), tampered).fetch);
  await u.check();
  const result = await u.install();
  assert.match(result.error!, /^Couldn't update: The download (was incomplete|doesn't match the release's SHA-256)\.$/);
  assert.equal(result.installed, null);
  assert.equal(readFileSync(join(dist, "backend.cjs"), "utf8"), "// backend 0.2.0");
});

test("an up-to-date install, a missing release and an unreachable GitHub read plainly", async () => {
  const { dist } = installed();
  const zip = packageZip("0.2.0");
  const current = await updater(dist, fakeGitHub(releaseJson("0.2.0", zip), zip).fetch).check();
  assert.equal(current.available, null);
  assert.equal(updateStatusText(current), "Rederive 0.2.0 is up to date.");

  const none = await updater(dist, fakeGitHub(404, zip).fetch).check();
  assert.equal(none.error, "No release is published yet.");

  const offline: Fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const unreachable = await updater(dist, offline).check();
  assert.equal(unreachable.error, "Couldn't reach GitHub. Check the internet connection.");
  assert.equal(updateStatusText(unreachable), unreachable.error);
});

test("a git checkout is told about new releases but never overwritten", async () => {
  const { plugin, dist } = installed();
  mkdirSync(join(plugin, ".git"));
  const zip = packageZip("0.3.0");
  const u = updater(dist, fakeGitHub(releaseJson("0.3.0", zip), zip).fetch);
  const checked = await u.check();
  assert.equal(checked.install, "source");
  assert.equal(canInstall(checked), false);
  assert.match(updateStatusText(checked), /git checkout: update it with git pull, then npm run build/);
  await assert.rejects(u.install(), /git checkout/);
  assert.ok(existsSync(join(dist, "stale.js")));
});
