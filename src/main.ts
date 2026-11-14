// Frontend entry: activated once per LearnHarness window while the plugin is enabled.
// Step 1 scaffold: a transcript card for the echo tool, proving the frontend bundle loads.
import type { PluginFrontendContext, PluginToolRenderProps } from "learnharness-plugin-api";

const ECHO_TOOL_NAME = "rederive_echo";

function appendText(container: HTMLElement, tag: "strong" | "p", text: string): void {
  const element = container.ownerDocument.createElement(tag);
  element.textContent = text;
  container.append(element);
}

function echoText(tool: PluginToolRenderProps): string {
  if (tool.state === "output-error") return tool.errorText || "Tool failed.";
  if (tool.state !== "output-available") return "Waiting for result…";
  const output = tool.output as { text?: unknown } | undefined;
  return typeof output?.text === "string" ? `Echo: ${output.text}` : "No echo payload.";
}

export function activate(ctx: PluginFrontendContext): void {
  ctx.registerToolRenderer({
    toolName: ECHO_TOOL_NAME,
    mount(container, tool) {
      appendText(container, "strong", "Rederive plugin loaded");
      appendText(container, "p", echoText(tool));
      return () => container.replaceChildren();
    },
  });
}
