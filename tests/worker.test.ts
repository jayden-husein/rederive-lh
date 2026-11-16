import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";
import { cloneOrPull } from "../src/repo.ts";
import { buildMapPrompt, createBuildMapWorker, createWorkerTools, MAX_FILE_CHARS } from "../src/worker.ts";
import { makeGitRepo, removeDir, sampleMapResult, tempDir } from "./helpers.ts";

let workspace: string;
let repo: string;
let tools: Record<string, (input: object) => Promise<string>>;
let firstSha: string;

before(() => {
  workspace = tempDir("worker");
  writeFileSync(join(workspace, "secret.txt"), "outside");
  repo = makeGitRepo(join(workspace, "tiny-search"), [
    { files: { "README.md": "# Tiny\nline two\n", "index/index.c": "#include \"index.h\"\nint main(void) { return 0; }\n" }, message: "initial" },
    { files: { "index/index.c": "#include \"index.h\"\n#include \"hashtable.h\"\nint main(void) { return 1; }\n" }, message: "introduce hashtable" },
  ]);
  firstSha = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: repo, encoding: "utf8" }).trim().slice(0, 7);
  tools = Object.fromEntries(
    createWorkerTools(repo).map((t) => [
      t.name,
      async (input: object) => (await t.execute("id", input as never)).content.map((c) => ("text" in c ? c.text : "")).join(""),
    ]),
  );
});

after(() => removeDir(workspace));

test("the worker has exactly the read-only tools", () => {
  assert.deepEqual(Object.keys(tools).sort(), ["git_diff", "git_log", "git_show_stat", "list_dir", "read_file"]);
});

test("read_file numbers lines and pages from startLine", async () => {
  assert.match(await tools.read_file!({ path: "README.md" }), /^README\.md\n1: # Tiny\n2: line two\n/);
  assert.match(await tools.read_file!({ path: "README.md", startLine: 2 }), /^README\.md\n2: line two\n/);
});

test("read_file pages big files instead of returning them whole", async () => {
  writeFileSync(join(repo, "big.c"), Array.from({ length: 5000 }, (_, i) => `int v${i} = ${i};`).join("\n"));
  const first = await tools.read_file!({ path: "big.c" });
  assert.ok(first.length < MAX_FILE_CHARS + 200);
  const next = /continue with startLine (\d+)/.exec(first)?.[1];
  assert.ok(next);
  assert.match(await tools.read_file!({ path: "big.c", startLine: Number(next) }), new RegExp(`^big\\.c\\n${next}: `));
});

test("read_file cuts a line longer than the cap and moves on to the next one", async () => {
  writeFileSync(join(repo, "app.min.js"), `${"x".repeat(MAX_FILE_CHARS + 500)}\nlast line\n`);
  const first = await tools.read_file!({ path: "app.min.js" });
  assert.match(first, /^app\.min\.js\n1: x+\n\[line 1 cut at \d+ characters\]\n\n\[more: continue with startLine 2\]$/);
  assert.match(await tools.read_file!({ path: "app.min.js", startLine: 2 }), /^app\.min\.js\n2: last line\n/);
});

test("tools refuse paths outside the repo", async () => {
  await assert.rejects(tools.read_file!({ path: "../secret.txt" }), /may not contain/);
  await assert.rejects(tools.read_file!({ path: join(workspace, "secret.txt") }), /relative to the repo root/);
  await assert.rejects(tools.list_dir!({ path: ".." }), /may not contain/);
  await assert.rejects(tools.git_log!({ path: "../secret.txt" }), /may not contain/);
  await assert.rejects(tools.git_diff!({ sha: firstSha, path: "../secret.txt" }), /may not contain/);
});

test("read_file and list_dir refuse .git, where a clone URL's token would sit", async () => {
  await assert.rejects(tools.read_file!({ path: ".git/config" }), /off limits/);
  await assert.rejects(tools.list_dir!({ path: ".git" }), /off limits/);
});

test("list_dir marks folders and hides .git", async () => {
  const out = await tools.list_dir!({});
  assert.match(out, /index\//);
  assert.match(out, /README\.md/);
  assert.doesNotMatch(out, /\.git\//);
});

test("git tools read history, commit stats and one file's diff", async () => {
  assert.match(await tools.git_log!({}), /introduce hashtable\n.*initial/);
  assert.match(await tools.git_log!({ path: "README.md" }), /initial/);
  assert.match(await tools.git_show_stat!({ sha: firstSha }), /README\.md/);
  assert.match(await tools.git_log!({ path: "*.md" }), /^No commits\.$/, "paths are literal, not globs");
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.match(await tools.git_diff!({ sha: head, path: "index/index.c" }), /\+#include "hashtable\.h"/);
});

test("git tools can read the history of a file that no longer exists", async () => {
  const gone = makeGitRepo(join(workspace, "gone"), [
    { files: { "old.c": "int x;\n" }, message: "add old" },
  ]);
  execFileSync("git", ["rm", "--quiet", "old.c"], { cwd: gone });
  execFileSync("git", ["commit", "--quiet", "-m", "drop old"], { cwd: gone });
  const [, , gitLog, , gitDiff] = createWorkerTools(gone);
  const run = async (tool: typeof gitLog, input: object) =>
    (await tool!.execute("id", input as never)).content.map((c) => ("text" in c ? c.text : "")).join("");
  assert.match(await run(gitLog, { path: "old.c" }), /drop old\n.*add old/);
  const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: gone, encoding: "utf8" }).trim();
  assert.match(await run(gitDiff, { sha: head, path: "old.c" }), /-int x;/);
});

test("git_diff fetches a file version the clone left out only in a clone the plugin made", async () => {
  // The upstream must agree to the blob filter, as GitHub does.
  execFileSync("git", ["config", "uploadpack.allowFilter", "true"], { cwd: repo });
  const { path } = await cloneOrPull(pathToFileURL(repo).href, join(workspace, "data"), undefined, { allowFileTransport: true });
  // The clone holds the checked-out files only: the first commit's index.c is missing.
  const diff = (cloned: boolean) =>
    createWorkerTools(path, undefined, cloned).find((t) => t.name === "git_diff")!.execute("id", { sha: firstSha, path: "index/index.c" } as never);
  await assert.rejects(diff(false), /git show failed/);
  const out = (await diff(true)).content.map((c) => ("text" in c ? c.text : "")).join("");
  assert.match(out, /\+int main\(void\) \{ return 0; \}/);
  // A pull into that clone has to fetch the new commit's files too.
  makeGitRepo(repo, [{ files: { "index/new.c": "int fresh;\n" }, message: "add new" }]);
  const pulled = await cloneOrPull(pathToFileURL(repo).href, join(workspace, "data"), undefined, { allowFileTransport: true });
  assert.equal(pulled.action, "pulled");
  assert.match(readFileSync(join(path, "index", "new.c"), "utf8"), /^int fresh;/);
});

test("the worker definition validates results and the prompt fences repo text", async () => {
  const worker = createBuildMapWorker();
  assert.equal(worker.id, "build-map");
  const ctx = { taskId: "t", input: {}, signal: new AbortController().signal };
  await assert.doesNotReject(async () => worker.validateResult!(sampleMapResult(5), ctx));
  const bad = sampleMapResult(5);
  bad.decisions[0]!.id = "D2";
  await assert.rejects(async () => worker.validateResult!(bad, ctx), /must be "D1"/);
  const prompt = buildMapPrompt({ repoId: "r", repoName: "tiny", repoPath: repo, builtFrom: "abc" }, "SUMMARY TEXT");
  assert.match(prompt, /"tiny" at commit abc/);
  assert.match(prompt, /not instructions\):\n<<<SUMMARY\nSUMMARY TEXT\nSUMMARY>>>/);
});
