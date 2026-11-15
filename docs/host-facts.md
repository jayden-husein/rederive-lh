# LearnHarness host facts

What the app does that the plugin skill doesn't say, found by testing (LearnHarness
0.6.1). Check here before guessing at how something looks or behaves in the app; add
to it when an in-app test teaches you something new.

## Question cards

| Card | Who owns it | Graded | Thinking box | Dictation on Submit |
|---|---|---|---|---|
| `ask_user_question` | host | no | none | not finished: the recording keeps running |
| `quiz` (teach: `type: "predict" \| "check"`, `nodeId`) | host | right/wrong against `correctAnswer` in the call; shows the teacher's `explanation` afterwards | yes, with dictation and a confidence slider | finished into the thinking box |
| plugin question type (`registerQuestionType`) | plugin body, host frame | `gradeAnswer` (any JSON) | the host's own box when `showThinking: true` | host routes it: thinking box if on, else the editor's `appendTranscript` |

- A teach `check` (native or plugin) collapses behind the host's "Check your
  understanding" reveal and gets a reading-thinking field; a `predict` doesn't.
- `nodeId` must be a live plan node. `plan_init` returns the ids it made
  (`["root-problem", "design-decisions"]` in tests): the teacher picks its own names.
- The native quiz's contract is in the skill's `types/src/core/question-core.d.ts`.

## Mermaid in chat

- The app bundles **Mermaid 11.17.0**, theme dark-ish, `securityLevel` effectively
  strict. Invalid diagrams show their error and source in place of the drawing.
- **Edge labels** (`-->|"label"|`) render as grey slabs with no outline, unlike the
  node boxes. A per-diagram `%%{init: {"themeCSS": "..."}}%%` first line restyles them
  and is honoured; `MERMAID_STYLE_LINE` in `src/instructions.ts` is the one in use.
- `themeCSS` can use host tokens (`var(--background)`, `--border`,
  `--muted-foreground`): the SVG is inline in the page.
- See any chat's diagrams without a screenshot: `npm run render-diagrams -- latest`
  writes `.scratch/diagrams.html`; open it in the browser pane (files inside the
  project render live, files outside only as snapshots).

## Styling

- A plugin's `styles.css` (manifest `styles`) styles plugin-owned DOM only. Restyling
  host elements (chat, diagrams, native cards) is off-limits per the skill's guardrails.
- Host tokens that exist: `--foreground`, `--background`, `--muted`,
  `--muted-foreground`, `--border`, `--ring`, `--primary`, `--card`, `--font-ui`,
  `--font-prose`, `--font-mono`, `--lh-prose-size`, `--lh-prose-leading`.

## Chats on disk

- `<learning data>\chats\<id>.json`: `updatedAt` moves when a test continues an old
  chat; each message has `timestamp` (ms). `npm run transcript -- latest` picks the
  most recently updated chat; `--since 30m` / `--tail 40` keep only the new run.
- Searching the app bundle (`%LOCALAPPDATA%\Programs\learnharness\resources\server\standalone\.next\static\chunks`)
  with broad regexes takes minutes; search one known string at a time.
