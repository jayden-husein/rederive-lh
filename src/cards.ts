// One-line transcript cards for the plugin's tools. The default cards would show tool
// results, and some of those carry the hidden decision map, so these cards are built
// only from fixed text and enum-like detail fields, never from result text.
// No DOM here, so tests can check every card.
import type { PluginToolRenderProps } from "learnharness-plugin-api";
import { TOOL_NAMES } from "./names.ts";

export const RENDERED_TOOLS = [
  TOOL_NAMES.setMode,
  TOOL_NAMES.status,
  TOOL_NAMES.buildMap,
  TOOL_NAMES.nextProblem,
  TOOL_NAMES.logProblem,
  TOOL_NAMES.skipProblem,
] as const;

type CardInput = Pick<PluginToolRenderProps, "toolName" | "state" | "output" | "background">;

const MODE_LABELS: Record<string, string> = { rederive: "Rederive", onboarding: "Onboarding", normal: "Normal teaching" };

function field(output: unknown, key: string): unknown {
  return typeof output === "object" && output !== null ? (output as Record<string, unknown>)[key] : undefined;
}

/** The card's text for one render state. */
export function cardText(tool: CardInput): string {
  if (tool.state === "input-streaming" || tool.state === "input-available") {
    return tool.toolName === TOOL_NAMES.buildMap ? "Starting the decision map…" : "Rederive…";
  }
  const failed = tool.state === "output-error";
  const out = tool.output;
  switch (tool.toolName) {
    case TOOL_NAMES.setMode: {
      if (failed) return "Couldn't change the mode";
      const mode = field(out, "mode");
      return `Mode: ${typeof mode === "string" ? MODE_LABELS[mode] ?? mode : "updated"}`;
    }
    case TOOL_NAMES.status:
      return failed ? "Couldn't check rederive progress" : "Checked rederive progress";
    case TOOL_NAMES.buildMap: {
      if (!tool.background) return failed ? "Couldn't start the decision map" : "Building the decision map in the background…";
      if (failed) return "Decision map failed";
      const status = field(out, "status");
      if (typeof status === "string") return `Decision map ${status}`;
      return "Decision map ready";
    }
    case TOOL_NAMES.nextProblem: {
      if (failed) return "Couldn't load a problem";
      switch (field(out, "state")) {
        case "loaded":
          return field(out, "revisit") === true ? "Back to a skipped problem" : "Problem loaded";
        case "building":
          return "Decision map still building";
        case "no-map":
          return "No decision map yet";
        case "all-done":
          return "Every problem done";
        default:
          return "Problem loaded";
      }
    }
    case TOOL_NAMES.logProblem:
      if (failed) return "Couldn't log progress";
      // Before rederive_skip_problem existed, skips were logged here with skipped: true.
      return field(out, "skipped") === true ? "Problem skipped for now" : "Progress logged";
    case TOOL_NAMES.skipProblem:
      return failed ? "Couldn't skip the problem" : "Problem skipped for now";
    default:
      return "Rederive";
  }
}
