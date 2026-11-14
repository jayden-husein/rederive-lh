// Backend entry: activated once per LearnHarness server while the plugin is enabled.
// Step 1 scaffold: a single echo tool that proves the backend bundle loads.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { PluginAgentKind, PluginBackendContext, PluginToolContext } from "learnharness-plugin-api";
import { Type } from "typebox";

export const ECHO_TOOL_NAME = "rederive_echo";

const EchoParameters = Type.Object(
  { text: Type.String({ maxLength: 500 }) },
  { additionalProperties: false },
);

export interface EchoDetails {
  text: string;
  chatId: string;
  agent: PluginAgentKind;
}

function createEchoTool(
  ctx: PluginBackendContext,
  context: PluginToolContext,
): AgentTool<typeof EchoParameters, EchoDetails> {
  return {
    name: ECHO_TOOL_NAME,
    label: "Rederive echo",
    description:
      "Diagnostic for the Rederive plugin. Only call when the learner explicitly asks to test the rederive echo tool. Echoes the given text.",
    parameters: EchoParameters,
    execute: async (_toolCallId, input, signal) => {
      if (signal?.aborted || ctx.signal.aborted) throw new Error("Rederive tool cancelled");
      return {
        content: [{ type: "text", text: `Rederive echo: ${input.text}` }],
        details: { text: input.text, chatId: context.chatId, agent: context.agent },
      };
    },
  };
}

export function activate(ctx: PluginBackendContext): void {
  ctx.registerTools({
    agents: ["prober", "teacher"],
    create: (context) => [createEchoTool(ctx, context)],
  });
}
