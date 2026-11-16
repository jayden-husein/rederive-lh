import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { GitError, isGitWorkTree, LAZY_FETCH, runGit } from "../src/git.ts";
import {
  cloneOrPull,
  displayName,
  guessOwnership,
  parseSource,
  readmeSummary,
  repoId,
  summarizeReadme,
  withoutCredentials,
} from "../src/repo.ts";
import { makeGitRepo, removeDir, SAMPLE_README, tempDir } from "./helpers.ts";

let workspace: string;
let ownRepo: string;
let otherRepo: string;
let plainDir: string;

before(() => {
  workspace = tempDir("repo");
  ownRepo = makeGitRepo(join(workspace, "tiny-search"), [
    { files: { "README.md": SAMPLE_README, "crawler.c": "#include \"pagedir.h\"\n" }, message: "initial crawler" },
    { files: { "indexer.c": "#include \"index.h\"\n" }, message: "add indexer" },
    { files: { "querier.c": "\n" }, message: "querier", authorEmail: "friend@example.com" },
  ]);
  otherRepo = makeGitRepo(join(workspace, "someone-else"), [
    { files: { "a.c": "\n" }, message: "a", authorEmail: "them@example.com" },
    { files: { "b.c": "\n" }, message: "b", authorEmail: "them@example.com" },
  ]);
  plainDir = join(workspace, "plain");
  mkdirSync(plainDir);
  writeFileSync(join(plainDir, "notes.txt"), "no git here");
});

after(() => removeDir(workspace));

// --- parseSource -----------------------------------------------------------

test("parseSource recognizes git URLs", () => {
  assert.deepEqual(parseSource("https://github.com/user/tiny-search.git"), { kind: "url", url: "https://github.com/user/tiny-search.git" });
  assert.equal(parseSource("git@github.com:user/repo.git").kind, "url");
  assert.equal(parseSource("ssh://git@host.example/user/repo").kind, "url");
  assert.equal(parseSource("  \"https://github.com/u/r\"  ").kind, "url");
});

test("parseSource rejects unsafe or unsupported URL schemes", () => {
  assert.throws(() => parseSource("file:///C:/repo"), /Unsupported URL/);
  assert.throws(() => parseSource("ext::sh -c calc"), /relative path/);
  assert.throws(() => parseSource("http://example.com/repo"), /Unsupported URL/);
  assert.throws(() => parseSource(""), /local folder path or a git URL/);
});

test("parseSource accepts absolute Windows and UNC paths", { skip: process.platform !== "win32" }, () => {
  assert.deepEqual(parseSource("C:\\code\\tiny"), { kind: "local", path: "C:\\code\\tiny" });
  const unc = parseSource("\\\\wsl.localhost\\Ubuntu\\home\\me\\tiny");
  assert.equal(unc.kind, "local");
  assert.equal(unc.kind === "local" && unc.path, "\\\\wsl.localhost\\Ubuntu\\home\\me\\tiny");
  assert.throws(() => parseSource("/home/me/tiny"), /wsl\.localhost/);
});

test("parseSource accepts absolute POSIX paths on macOS and Linux", { skip: process.platform === "win32" }, () => {
  assert.deepEqual(parseSource("/home/me/tiny"), { kind: "local", path: "/home/me/tiny" });
  assert.deepEqual(parseSource("/Users/me/code/tiny/"), { kind: "local", path: "/Users/me/code/tiny" });
  assert.throws(() => parseSource("C:\\code\\tiny"), /relative path/);
});

test("parseSource expands ~ to the home folder", () => {
  assert.deepEqual(parseSource("~/code/tiny"), { kind: "local", path: join(homedir(), "code", "tiny") });
  assert.deepEqual(parseSource("~"), { kind: "local", path: resolve(homedir()) });
  assert.throws(() => parseSource("~other/tiny"), /relative path/);
});

test("parseSource rejects relative paths", () => {
  assert.throws(() => parseSource("tiny"), /relative path/);
  assert.throws(() => parseSource(".\\tiny"), /relative path/);
});

// --- ids and names ---------------------------------------------------------

test("repoId is stable across spellings of the same location", () => {
  const a = repoId({ kind: "url", url: "https://GitHub.com/user/tiny-search.git" });
  const b = repoId({ kind: "url", url: "https://github.com/user/tiny-search/" });
  assert.equal(a, b);
  assert.match(a, /^tiny-search-[0-9a-f]{12}$/);
  if (process.platform === "win32") {
    assert.equal(repoId({ kind: "local", path: "C:\\Code\\Tiny" }), repoId({ kind: "local", path: "c:\\code\\tiny\\" }));
    // WSL paths are case-sensitive, so these differ.
    assert.notEqual(
      repoId({ kind: "local", path: "\\\\wsl.localhost\\U\\home\\Tiny" }),
      repoId({ kind: "local", path: "\\\\wsl.localhost\\U\\home\\tiny" }),
    );
  }
  assert.notEqual(repoId({ kind: "local", path: join(workspace, "x", "tiny") }), repoId({ kind: "local", path: join(workspace, "y", "tiny") }));
});

test("displayName takes the last path or URL segment", () => {
  assert.equal(displayName({ kind: "url", url: "git@github.com:user/tiny.git" }), "tiny");
  assert.equal(displayName({ kind: "url", url: "https://github.com/user/tiny/" }), "tiny");
  assert.equal(displayName({ kind: "local", path: join(workspace, "tiny-search") }), "tiny-search");
});

// --- README ----------------------------------------------------------------

test("summarizeReadme keeps title and prose, drops badges and code", () => {
  const summary = summarizeReadme(SAMPLE_README);
  assert.ok(summary);
  assert.match(summary, /^Tiny Search: A tiny search engine in C/);
  assert.doesNotMatch(summary, /shields|make &&|badge/);
});

test("summarizeReadme truncates long text", () => {
  const long = `# T\n\n${"word ".repeat(400)}`;
  const summary = summarizeReadme(long, 100)!;
  assert.ok(summary.length <= 100);
  assert.ok(summary.endsWith("…"));
});

test("readmeSummary reads the repo README, or returns null without one", async () => {
  assert.match((await readmeSummary(ownRepo))!, /inverted index/);
  assert.equal(await readmeSummary(plainDir), null);
});

// --- git wrapper -----------------------------------------------------------

test("git wrapper detects work trees and reads history", async () => {
  assert.equal(await isGitWorkTree(ownRepo), true);
  assert.equal(await isGitWorkTree(plainDir), false);
  const log = await runGit(["log", "--format=%s"], { cwd: ownRepo });
  assert.deepEqual(log.trim().split(/\r?\n/), ["querier", "add indexer", "initial crawler"]);
});

test("git wrapper reports failures and cancellation as GitError", async () => {
  await assert.rejects(runGit(["not-a-command"], { cwd: ownRepo }), (e) => e instanceof GitError && e.code === "failed");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runGit(["log"], { cwd: ownRepo, signal: controller.signal }), (e) => e instanceof GitError && e.code === "aborted");
});

// Elsewhere git gets SIGTERM and stops its own helpers; Windows ends only the one process.
test("cancelling stops the processes git started, not only git", { skip: process.platform !== "win32" }, async () => {
  const marker = join(workspace, "helper-finished").replace(/\\/g, "/");
  const controller = new AbortController();
  // git runs the alias in a shell: a stand-in for clone's download helpers.
  const hanging = runGit(["-c", `alias.hang=!sleep 2 && touch '${marker}'`, "hang"], { cwd: ownRepo, signal: controller.signal });
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(hanging, (e) => e instanceof GitError && e.code === "aborted");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(existsSync(marker), false, "the shell git started kept running");
});

test("a git command past its time limit is stopped and reported as a timeout", async () => {
  await assert.rejects(
    runGit(["-c", "alias.hang=!sleep 2", "hang"], { cwd: ownRepo, timeoutMs: 300 }),
    (e) => e instanceof GitError && e.code === "timeout" && /git hang timed out/.test(e.message),
  );
});

test("git errors name the subcommand, and a missing folder isn't blamed on git", async () => {
  await assert.rejects(runGit(["-c", "core.quotePath=false", "rev-parse", "--verify", "no-such-ref"], { cwd: ownRepo }), /git rev-parse failed/);
  await assert.rejects(
    runGit(["status"], { cwd: join(workspace, "gone") }),
    (e) => e instanceof GitError && e.code === "failed" && /Folder not found/.test(e.message),
  );
});

test("a repo's own config can't turn on signature checks, which would run its gpg.program", async () => {
  const repo = makeGitRepo(join(workspace, "signed"), [{ files: { "a.c": "\n" }, message: "initial" }]);
  await runGit(["config", "log.showSignature", "true"], { cwd: repo });
  assert.equal((await runGit(["config", "--get", "log.showSignature"], { cwd: repo })).trim(), "false");
});

test("a folder posing as a partial clone can't make git run its fetch command", async () => {
  const repo = makeGitRepo(join(workspace, "lazy"), [{ files: { "a.c": "\n" }, message: "initial" }]);
  const marker = join(workspace, "ran").replace(/\\/g, "/");
  const head = (await runGit(["rev-parse", "HEAD"], { cwd: repo })).trim();
  const config = {
    "core.repositoryformatversion": "1",
    "extensions.partialClone": "origin",
    "remote.origin.url": join(workspace, "no-remote"),
    "remote.origin.promisor": "true",
    "remote.origin.uploadpack": `touch '${marker}' #`,
  };
  for (const [key, value] of Object.entries(config)) await runGit(["config", key, value], { cwd: repo });
  // A missing object is what makes git fetch.
  rmSync(join(repo, ".git", "objects", head.slice(0, 2), head.slice(2)), { force: true });
  await assert.rejects(runGit(["log", "--format=%ae"], { cwd: repo }));
  assert.equal(existsSync(marker), false);
  // With lazy fetch allowed the same call runs the command, so the check above is a real one.
  await assert.rejects(runGit(["log", "--format=%ae"], { cwd: repo, env: LAZY_FETCH }));
  assert.equal(existsSync(marker), true);
});

test("a token in an https URL stays out of the repo id and of what is stored and shown", () => {
  const withToken = "https://me:ghp_token@github.com/user/tiny-search.git";
  assert.equal(withoutCredentials(withToken), "https://github.com/user/tiny-search.git");
  assert.equal(withoutCredentials("https://me:to@ken@github.com/user/x"), "https://github.com/user/x", "no part of the token is left");
  assert.equal(repoId({ kind: "url", url: withToken }), repoId({ kind: "url", url: "https://github.com/user/tiny-search" }));
  assert.equal(displayName({ kind: "url", url: withToken }), "tiny-search");
  // The ssh user is a login name, not a secret.
  assert.equal(withoutCredentials("git@github.com:user/tiny-search.git"), "git@github.com:user/tiny-search.git");
});

// --- ownership -------------------------------------------------------------

test("guessOwnership compares commit authors with the git user", async () => {
  assert.deepEqual(await guessOwnership(ownRepo), { guess: "own", share: 0.67 });
  assert.deepEqual(await guessOwnership(otherRepo), { guess: "other", share: 0 });
  assert.deepEqual(await guessOwnership(plainDir), { guess: "unknown", share: null });
});

// --- clone / pull ----------------------------------------------------------

test("cloneOrPull clones, then pulls new commits", async () => {
  const upstream = makeGitRepo(join(workspace, "upstream"), [{ files: { "a.c": "1\n" }, message: "one" }]);
  const url = pathToFileURL(upstream).href;
  const repoDir = join(workspace, "data", "repos", "upstream-1");
  const testing = { allowFileTransport: true };

  const first = await cloneOrPull(url, repoDir, undefined, testing);
  assert.equal(first.action, "cloned");
  assert.equal(first.path, join(repoDir, "checkout"));
  assert.ok(existsSync(join(first.path, "a.c")));
  assert.deepEqual(readdirSync(repoDir), ["checkout"]);

  makeGitRepo(upstream, [{ files: { "b.c": "2\n" }, message: "two" }]);
  const second = await cloneOrPull(url, repoDir, undefined, testing);
  assert.equal(second.action, "pulled");
  assert.ok(existsSync(join(second.path, "b.c")));
});

test("cloneOrPull refuses file:// outside tests and leaves no partial clone", async () => {
  const upstream = join(workspace, "tiny-search");
  const repoDir = join(workspace, "data", "repos", "blocked");
  await assert.rejects(cloneOrPull(pathToFileURL(upstream).href, repoDir), GitError);
  assert.deepEqual(readdirSync(repoDir), []);
});
