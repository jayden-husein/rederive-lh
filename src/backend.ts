// Backend entry: activated once per LearnHarness server while the plugin is enabled.
import type { PluginBackendContext } from "learnharness-plugin-api";
import { MapStore } from "./map-store.ts";
import { SessionStore } from "./sessions.ts";
import { createTools, type ToolDeps } from "./tools.ts";
import { createBuildMapWorker } from "./worker.ts";

export function activate(ctx: PluginBackendContext): void {
  // Host disable/restart disposes the worker service and interrupts unfinished builds.
  ctx.workers.register(createBuildMapWorker());

  const listTasks = () => ctx.workers.list();
  const deps: ToolDeps = {
    store: new SessionStore(ctx.dataDirectory),
    maps: new MapStore(ctx.dataDirectory, listTasks),
    dataDirectory: ctx.dataDirectory,
    signal: ctx.signal,
    listTasks,
    catalog: () => ctx.inference.catalog(),
    createBackgroundTool: (context, definition) => ctx.createBackgroundTool(context, definition),
  };
  ctx.registerTools({
    agents: ["prober", "teacher"],
    create: (context) => createTools(deps, context),
  });
}
