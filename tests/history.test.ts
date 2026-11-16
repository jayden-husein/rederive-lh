import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { summarizeRepo } from "../src/history.ts";
import { makeGitRepo, removeDir, SAMPLE_README, tempDir } from "./helpers.ts";

/** Section headings in the order rederive's history.sh prints them. */
const HISTORY_SECTIONS = [
  "## Repo",
  "## First 15 commits",
  "## Commits whose message names a design change (newest 40)",
  "## Largest commits by files touched, ignoring tests and generated files (top 15)",
  "## Most changed files (top 20)",
  "## Design docs present",
  "## Top-level layout",
  "# Code structure",
];
/** Section headings in the order structure.py prints them. */
const STRUCTURE_SECTIONS = [
  "## Code size",
  "## Entry points",
  "## Most imported internal files (top 15): the shared core",
  "## Files that import the most internal files (top 10): the orchestrators",
  "## Largest source files (top 10)",
  "## Edges among the central files (who imports whom)",
  "## External packages used most (top 15)",
];

let workspace: string;
let repo: string;
let cached: Promise<string> | undefined;
const fullSummary = (): Promise<string> => (cached ??= summarizeRepo(repo));

/** A small C search engine, shaped like the learner's real test repos. */
function makeTinySearch(dir: string): string {
  return makeGitRepo(dir, [
    {
      message: "initial crawler",
      files: {
        "README.md": SAMPLE_README,
        Makefile: "all:\n\tmake -C crawler\n",
        "common/pagedir.h": "void pagedir_save(void);\n",
        "common/pagedir.c": '#include <stdio.h>\n#include "pagedir.h"\nvoid pagedir_save(void) {}\n',
        "crawler/crawler.c": '#include <stdlib.h>\n#include "../common/pagedir.h"\nint main(int argc, char **argv) { return 0; }\n',
      },
    },
    {
      message: "add indexer",
      files: {
        "common/index.h": "typedef struct index index_t;\n",
        "common/index.c": '#include "index.h"\n#include "pagedir.h"\n',
        "indexer/indexer.c": '#include "common/index.h"\n#include "pagedir.h"\n#include <string.h>\nint main(void) { return 0; }\n',
        "package-lock.json": "{}\n",
      },
    },
    {
      message: "Refactor: extract word normalization into common",
      files: {
        "common/word.h": "char *normalize(char *);\n",
        "common/word.c": '#include "word.h"\n#include <ctype.h>\n',
        "common/index.c": '#include "index.h"\n#include "pagedir.h"\n#include "word.h"\n',
        "indexer/indexer.c": '#include "common/index.h"\n#include "pagedir.h"\n#include "word.h"\nint main(void) { return 0; }\n',
        "tests/test_index.c": '#include "index.h"\n#include "word.h"\nint main(void) { return 0; }\n',
      },
    },
    {
      message: "switched to a hashtable for the index",
      files: {
        "common/hashtable.h": "void *ht_new(int);\n",
        "common/hashtable.c": '#include "hashtable.h"\n#include <stdlib.h>\n',
        "common/index.c": '#include "index.h"\n#include "pagedir.h"\n#include "word.h"\n#include "hashtable.h"\n',
        "docs/DESIGN.md": "# Design\n",
      },
    },
    {
      message: "add querier",
      files: {
        "querier/querier.c": '#include "../common/index.h"\n#include "../common/word.h"\n#include <stdio.h>\nint main(void) { return 0; }\n',
      },
    },
    {
      // A course library and a build that should never have been committed.
      message: "use libcs50 mem helpers",
      files: {
        "libcs50/mem.h": "void *mem_malloc(size_t);\n",
        "libcs50/mem.c": '#include "mem.h"\n#include <stdlib.h>\n',
        "libcs50/Makefile": "all:\n",
        // Like the real course library: ships a prebuilt archive, which marks it as bundled.
        "libcs50/libcs50-given.a": "!<arch>\n",
        "crawler/crawler.c": '#include <stdlib.h>\n#include "../common/pagedir.h"\n#include "../libcs50/mem.h"\nint main(int argc, char **argv) { return 0; }\n',
        "crawler/crawler": "\x7fELF\0\x01\x02",
        "crawler/core.4242": "\0\0core",
      },
    },
  ]);
}

before(() => {
  workspace = tempDir("history");
  repo = makeTinySearch(join(workspace, "tiny-search"));
});

after(() => removeDir(workspace));

function sectionOrder(text: string): string[] {
  return text.split("\n").filter((l) => /^#{1,2} /.test(l));
}

function section(text: string, heading: string): string[] {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  assert.notEqual(start, -1, `missing section ${heading}`);
  const end = lines.findIndex((l, i) => i > start && /^#{1,2} /.test(l));
  return lines.slice(start + 1, end === -1 ? undefined : end).filter(Boolean);
}

test("summary has the same sections, in the same order, as history.sh + structure.py", async () => {
  const text = await fullSummary();
  assert.deepEqual(sectionOrder(text), [...HISTORY_SECTIONS, ...STRUCTURE_SECTIONS]);
});

test("repo line counts commits, authors and dates", async () => {
  const [line] = section(await fullSummary(), "## Repo");
  assert.match(line!, /^commits: 6 \| first: \d{4}-\d\d-\d\d \| last: \d{4}-\d\d-\d\d \| authors: 1 \| HEAD: [0-9a-f]{7,}$/);
});

test("first commits are oldest first; design-change grep matches history.sh", async () => {
  const text = await fullSummary();
  const first = section(text, "## First 15 commits");
  assert.equal(first.length, 6);
  assert.match(first[0]!, /initial crawler$/);
  assert.match(first[4]!, /add querier$/);
  const design = section(text, "## Commits whose message names a design change (newest 40)");
  assert.equal(design.length, 2);
  assert.match(design[0]!, /switched to a hashtable/);
  assert.match(design[1]!, /Refactor: extract/);
});

test("file stats ignore lockfiles and tests", async () => {
  const text = await fullSummary();
  const largest = section(text, "## Largest commits by files touched, ignoring tests and generated files (top 15)");
  // "Refactor" touched 5 files, one of them a test, so it counts 4.
  assert.match(largest[0]!, /^5\t[0-9a-f]+ \S+ initial crawler$/);
  assert.ok(largest.some((l) => /^4\t.*Refactor/.test(l)), largest.join("\n"));
  const changed = section(text, "## Most changed files (top 20)");
  assert.match(changed[0]!, /^\s+3  common\/index\.c$/);
  assert.ok(!changed.some((l) => l.includes("package-lock.json")));
  assert.deepEqual(section(text, "## Design docs present"), ["README.md", "docs/DESIGN.md"]);
  const layout = section(text, "## Top-level layout");
  assert.match(layout[0]!, /^\s+8  common\/$/);
  assert.ok(!layout.some((l) => l.includes("package-lock")));
});

test("bundled libraries and committed build output are left out", async () => {
  const text = await fullSummary();
  const largest = section(text, "## Largest commits by files touched, ignoring tests and generated files (top 15)");
  // The libcs50 commit touched 7 files; only crawler.c is the learner's own source.
  assert.ok(largest.some((l) => /^1\t.*use libcs50/.test(l)), largest.join("\n"));
  const changed = section(text, "## Most changed files (top 20)");
  assert.ok(!changed.some((l) => /libcs50|crawler\/crawler$|core\./.test(l)), changed.join("\n"));
  const layout = section(text, "## Top-level layout");
  assert.ok(!layout.some((l) => l.includes("libcs50")));
  assert.ok(layout.some((l) => /^\s+1  crawler\/$/.test(l)), layout.join("\n"));
  const size = section(text, "## Code size");
  assert.ok(size.includes("bundled libraries, left out of every section and listed under external packages: libcs50/ (4 files)"));
  assert.ok(!section(text, "## Entry points").some((e) => e.includes("libcs50")));
  assert.ok(!section(text, "## Most imported internal files (top 15): the shared core").some((l) => l.includes("libcs50")));
  assert.match(section(text, "## External packages used most (top 15)")[0]!, /libcs50\/ \(1\)/);
});

test("C includes build the import graph", async () => {
  const text = await fullSummary();
  const imported = section(text, "## Most imported internal files (top 15): the shared core");
  // pagedir.h: same folder, ../ path, plain name found by suffix. Ties sort by path.
  assert.match(imported[0]!, /^\s+4  common\/pagedir\.h \(1 lines\)$/);
  // index.h: index.c, indexer.c (via the root), querier.c. The test file is left out.
  assert.match(imported.join("\n"), /\s3  common\/index\.h/);
  const entries = section(text, "## Entry points");
  assert.ok(entries.includes("build file: Makefile"));
  for (const main of ["crawler/crawler.c", "indexer/indexer.c", "querier/querier.c"]) {
    assert.ok(entries.some((e) => e.startsWith(`${main} (`)), `${main} not an entry point`);
  }
  // index.* is a JS entry-point name, not a C one, and headers never are.
  assert.ok(!entries.some((e) => e.startsWith("common/index.")), entries.join("\n"));
  const edges = section(text, "## Edges among the central files (who imports whom)");
  assert.ok(edges.includes("indexer/indexer.c -> common/index.h, common/pagedir.h, common/word.h"), edges.join("\n"));
  const external = section(text, "## External packages used most (top 15)");
  assert.match(external[0]!, /<stdio\.h> \(2\)/);
  const size = section(text, "## Code size");
  assert.match(size[0]!, /^source files: 12 \(1 tests, left out of the graph\)/);
});

test("a subfolder of a repo reads only that folder's history", async () => {
  const text = await summarizeRepo(join(repo, "common"));
  assert.match(text, /^commits: 4 /m);
  assert.match(text, /note: this folder is common\/ inside a larger repo/);
  const changed = section(text, "## Most changed files (top 20)");
  assert.match(changed[0]!, /^\s+3  index\.c$/);
});

test("a folder without git falls back to structure only", async () => {
  const plain = join(workspace, "plain");
  mkdirSync(join(plain, "src"), { recursive: true });
  writeFileSync(join(plain, "src", "main.c"), '#include "util.h"\nint main(void) { return 0; }\n');
  writeFileSync(join(plain, "src", "util.h"), "int util(void);\n");
  const text = await summarizeRepo(plain);
  assert.match(text, /^NOT_A_GIT_REPO: no history to read\./);
  assert.deepEqual(sectionOrder(text), STRUCTURE_SECTIONS);
  assert.match(text, /1  src\/util\.h/);
});

test("an empty git repo counts as having no history", async () => {
  const empty = makeGitRepo(join(workspace, "empty"), []);
  writeFileSync(join(empty, "a.c"), "int main(void) { return 0; }\n");
  const text = await summarizeRepo(empty);
  assert.match(text, /^NOT_A_GIT_REPO/);
});

test("a commit list that can't be read costs only the sections that need it", async () => {
  const broken = makeGitRepo(join(workspace, "broken"), [
    { files: { "a.c": "int main(void) { return 0; }\n" }, message: "first" },
    { files: { "b.c": "\n" }, message: "second" },
  ]);
  // Stands in for a log too long for the output cap: git log fails, HEAD still resolves.
  const first = execFileSync("git", ["rev-list", "--max-parents=0", "HEAD"], { cwd: broken, encoding: "utf8" }).trim();
  rmSync(join(broken, ".git", "objects", first.slice(0, 2), first.slice(2)), { force: true });
  const text = await summarizeRepo(broken);
  assert.match(text, /^commits: unknown \(the full commit list couldn't be read: git log failed/m);
  assert.match(section(text, "## First 15 commits")[0]!, /^\(unavailable: /);
  assert.match(text, /^# Code structure$/m);
  assert.match(text, /a\.c \(1 lines, imported by 0\)/);
});

test("output is capped", async () => {
  const text = await summarizeRepo(repo, { maxChars: 500 });
  assert.ok(text.length < 600);
  assert.match(text, /\[truncated: summary capped at 500 characters\]$/);
});

test("cancellation stops the summary", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(summarizeRepo(repo, { signal: controller.signal }));
});
