import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramPage, diagramsIn, MERMAID_CDN_VERSION } from "../scripts/diagrams.ts";
import type { Chat } from "../scripts/transcripts.ts";

const fence = (body: string) => "```mermaid\n" + body + "\n```";

test("diagrams come from the teacher's messages and text, in order, with their time", () => {
  const chat: Chat = {
    messages: [
      { role: "user", content: fence("flowchart LR\n  U --> V"), timestamp: 1 },
      { role: "assistant", timestamp: 2, content: [{ type: "toolCall", name: "send_to_user", arguments: { message: `Look:\n\n${fence("flowchart LR\n  A --> B")}\n\nAnd ${fence("flowchart LR\n  C --> D")}` } }] },
      { role: "assistant", timestamp: 3, content: [{ type: "text", text: fence("flowchart LR\n  E --> F") }] },
      // plan_init's diagram is the host's plan map, not a teaching diagram.
      { role: "assistant", timestamp: 4, content: [{ type: "toolCall", name: "plan_init", arguments: { mermaid: "graph TD\n  a --> b" } }] },
    ],
  };
  assert.deepEqual(
    diagramsIn(chat).map((d) => [d.source, d.timestamp]),
    [
      ["flowchart LR\n  A --> B", 2],
      ["flowchart LR\n  C --> D", 2],
      ["flowchart LR\n  E --> F", 3],
    ],
  );
});

test("the page renders each diagram with a pinned Mermaid on the host's dark tokens, and shows errors in place", () => {
  const page = diagramPage([{ source: 'flowchart LR\n  A["</script>"] --> B', timestamp: 0, where: "send_to_user" }]);
  assert.match(page, new RegExp(`mermaid@${MERMAID_CDN_VERSION.replace(/\./g, "\\.")}/`));
  assert.match(page, /securityLevel: "strict"/);
  assert.match(page, /--background:/);
  // Diagram sources travel as JSON, so a "</script>" in a label can't end the script.
  assert.doesNotMatch(page, /A\["<\/script>"\]/);
  assert.match(page, /\\u003c\/script>/);
  assert.match(page, /String\(e\.message/);
});
