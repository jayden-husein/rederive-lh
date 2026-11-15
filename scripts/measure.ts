// Prints what the plugin adds to an agent's prompt, in characters and rough tokens
// (chars / 4): the instruction texts, the tool schemas for a chat with no codebase and
// for chats in rederive and onboarding mode, and rederive_next_problem results from a map.
// Usage: npm run measure -- [path to a map.json]   (problem sizes only with a map)
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { StoredMap } from "../src/map.ts";
import { proberInstructions, teacherInstructions } from "../src/instructions.ts";
import { MapStore } from "../src/map-store.ts";
import { SessionStore } from "../src/sessions.ts";
import { DEFAULT_SETTINGS } from "../src/settings.ts";
import { createTools, formatProblemForAgent, type ToolDeps } from "../src/tools.ts";

const row = (label: string, text: string) =>
  console.log(`${label.padEnd(44)} ${String(text.length).padStart(6)} chars  ~${String(Math.round(text.length / 4)).padStart(5)} tokens`);

const schemaText = (tools: AgentTool<any>[]) =>
  tools.map((t) => `${t.name}\n${t.description}\n${JSON.stringify(t.parameters)}`).join("\n");

const data = mkdtempSync(join(tmpdir(), "rederive-measure-"));
try {
  const store = new SessionStore(data);
  await store.warm();
  const deps: ToolDeps = {
    store,
    maps: new MapStore(data, () => []),
    dataDirectory: data,
    signal: new AbortController().signal,
    listTasks: () => [],
    catalog: async () => ({ slots: {} }) as never,
    createBackgroundTool: (_c, d) => ({ ...d, execute: async () => ({ content: [], details: {} }) }) as AgentTool<any>,
  };

  row("prober instructions", proberInstructions(DEFAULT_SETTINGS));
  row("teacher instructions", teacherInstructions(DEFAULT_SETTINGS));
  row("prober tools, no codebase", schemaText(createTools(deps, { chatId: "plain", agent: "prober" })));
  row("teacher tools, no codebase", schemaText(createTools(deps, { chatId: "plain", agent: "teacher" })));
  await store.setRepo("r", { id: "x", name: "repo", kind: "local", source: "C:\\repo", path: "C:\\repo" });
  await store.setMode("r", "rederive");
  row("teacher tools, rederive chat", schemaText(createTools(deps, { chatId: "r", agent: "teacher" })));
  await store.setRepo("o", { id: "x", name: "repo", kind: "local", source: "C:\\repo", path: "C:\\repo" });
  await store.setMode("o", "onboarding");
  row("teacher tools, onboarding chat", schemaText(createTools(deps, { chatId: "o", agent: "teacher" })));

  const mapPath = process.argv[2];
  if (mapPath) {
    const map = JSON.parse(readFileSync(mapPath, "utf8")) as StoredMap;
    const sizes = map.decisions.map((d) => formatProblemForAgent(map, { decision: d, tag: null, state: "todo" }).length);
    row(`next_problem, first (${map.decisions[0]!.id})`, formatProblemForAgent(map, { decision: map.decisions[0]!, tag: null, state: "todo" }));
    console.log(`next_problem, mean over ${sizes.length} problems: ${Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length)} chars`);
  }
} finally {
  rmSync(data, { recursive: true, force: true });
}
