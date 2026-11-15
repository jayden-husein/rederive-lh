// The teacher's Mermaid diagrams from a chat, and a page that renders them the way
// LearnHarness does (dark host tokens, strict security), so an agent can look at them in
// the browser pane instead of asking for a screenshot. Pure functions; render-diagrams.ts
// does the file reading and writing.
import { type Chat, stringsIn } from "./transcripts.ts";

/**
 * LearnHarness 0.6.1 bundles Mermaid 11.17.0. The page loads 11.12.0 from the CDN (the
 * newest version checked to load there); bump it to match the app when a newer one does.
 */
export const MERMAID_CDN_VERSION = "11.12.0";

export interface Diagram {
  source: string;
  /** When the message was sent (ms), or 0 when the chat has no time for it. */
  timestamp: number;
  /** "text" or the tool that showed it. */
  where: string;
}

const FENCE = /```mermaid[ \t]*\r?\n([\s\S]*?)```/g;

function fencesIn(text: string): string[] {
  return [...text.matchAll(FENCE)].map((m) => m[1]!.replace(/\s+$/, ""));
}

/** Every ```mermaid fence the teacher showed, in order. plan_init's plan map is left out. */
export function diagramsIn(chat: Chat): Diagram[] {
  const out: Diagram[] = [];
  for (const m of chat.messages ?? []) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    const timestamp = m.timestamp ?? 0;
    for (const p of m.content ?? []) {
      if (p.type === "text" && p.text) for (const source of fencesIn(p.text)) out.push({ source, timestamp, where: "text" });
      if (p.type === "toolCall" && p.name && p.name !== "plan_init") {
        for (const source of fencesIn(stringsIn(p.arguments).join("\n"))) out.push({ source, timestamp, where: p.name });
      }
    }
  }
  return out;
}

/** JSON that is safe inside a <script> element. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

// Close to the app's dark theme; the diagrams' own init lines may use these tokens.
const TOKENS = "--background: #1e1f2b; --foreground: #e6e6e6; --muted-foreground: #a3a3b2; --border: #6b6b78;";

/** A standalone page that renders `diagrams`, one section each, with any Mermaid error shown in place. */
export function diagramPage(diagrams: Diagram[]): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Rederive diagrams</title>
<style>
:root { ${TOKENS} }
body { font-family: sans-serif; background: var(--background); color: var(--foreground); padding: 16px; }
section { margin: 16px 0; border-top: 1px solid var(--border); padding-top: 8px; }
h3 { margin: 4px 0; font-size: 13px; color: var(--muted-foreground); font-weight: normal; }
pre.err { color: #f88; white-space: pre-wrap; }
</style></head><body>
<p>${diagrams.length} diagram(s), Mermaid ${MERMAID_CDN_VERSION}, securityLevel strict.</p>
<div id="out"></div>
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_CDN_VERSION}/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
const diagrams = ${scriptJson(diagrams)};
const out = document.getElementById("out");
for (const [i, d] of diagrams.entries()) {
  const s = document.createElement("section");
  const h = document.createElement("h3");
  h.textContent = (i + 1) + ". " + d.where + (d.timestamp ? ", " + new Date(d.timestamp).toLocaleTimeString() : "");
  s.append(h);
  out.append(s);
  try {
    const { svg } = await mermaid.render("d" + i, d.source);
    s.insertAdjacentHTML("beforeend", svg);
  } catch (e) {
    const p = document.createElement("pre");
    p.className = "err";
    p.textContent = String(e.message || e) + "\\n\\n" + d.source;
    s.append(p);
  }
}
</script></body></html>
`;
}
