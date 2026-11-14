// Frontend entry: activated once per LearnHarness window while the plugin is enabled.
// Tool renderers, settings and the top-bar action arrive in build step 5; until then the
// host's default tool cards are used.
import type { PluginFrontendContext } from "learnharness-plugin-api";

export function activate(_ctx: PluginFrontendContext): void {}
