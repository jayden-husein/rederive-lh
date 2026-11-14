// Backend entry: activated once per LearnHarness server while the plugin is enabled.
import type { PluginBackendContext } from "learnharness-plugin-api";
import { SessionStore } from "./sessions.ts";
import { createTools } from "./tools.ts";

export function activate(ctx: PluginBackendContext): void {
  const deps = {
    store: new SessionStore(ctx.dataDirectory),
    dataDirectory: ctx.dataDirectory,
    signal: ctx.signal,
  };
  ctx.registerTools({
    agents: ["prober", "teacher"],
    create: (context) => createTools(deps, context),
  });
}
