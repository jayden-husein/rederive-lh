# Build history (steps 1–7)

What each finished step asked for, the in-app test findings and how they were
fixed, moved out of HANDOFF.md §7. Read it when a step refers to earlier findings.
Git history has the code.

1. **Scaffold.** Copy the shape of the skill's `examples/plugins/teaching-extension`;
   TypeScript + bundler (esbuild) producing `dist\backend.cjs` and `dist\main.js`;
   manifest; SDK types in `.sdk\`; `npm run build`, `npm run typecheck`,
   `npm test`. Minimal echo tool to prove loading. **User verifies it loads.**
2. **Repo + state.** `rederive_open_repo`, `set_mode`, `status`, `sessions.json`,
   git wrapper, path confinement. Unit tests (temp dirs; a fake repo built with git).
3. **History port.** TS port of history.sh + structure.py with C support.
   Unit tests against a fixture repo; compare output shape with the originals.
4. **Map worker.** Worker + `rederive_build_map` + `next_problem` +
   `log_problem`. **User runs one map build** on a small C repo (their Tiny
   Search Engine) and reviews the decisions.
5. **Instructions + UI.** Routing and rederive rules, tool renderers, settings,
   action. **User runs a full session.**
   Also fix the worker instructions (`WORKER_INSTRUCTIONS` in `src/worker.ts`),
   from the user's review of the first real map (cs50final):
   - Constraints must state a requirement or situation that breaks the
     learner's design ("pages link back to each other", "the querier runs
     later, in a separate process"), never the design change itself. The first
     map had "...so remember every address already seen" and "Write it as
     plain text", which give the answer away.
   - `rootProblem` must use no solution terms (the first map said the work "is
     split into three programs ... through files on disk", which gives away D2).
   - Testing, build and tooling choices (e.g. "valgrind + test scripts") are
     out of scope for decisions.
   Rebuild the cs50final map afterwards and compare.
   Skipping is already decided and built: `rederive_log_problem({ skipped: true })`
   writes `## D<n>. <title>\nskipped`, and the problem comes back after the
   untouched ones. The teacher instructions should use it when the learner skips.
6. **Fixes from the step 5 in-app test.** The user tested step 5 on 2026-11-14.
   Fix these five issues, then **user re-runs a full session** (both repos) and
   the button in a chat that is already in rederive mode. The evidence below comes
   from the transcript `data\chats\chat_mwg28vih_aaba154c.json` (dali-challenge,
   read-only learning data) and the plugin's own `data\`. Re-read it with a
   script rather than opening it whole.

   **6a. Startup uses too many tokens.** Measured: the host's own prompt is
   ~14k tokens on prober turns and ~27k on teacher turns. The plugin adds ~600
   (prober instructions) + ~1,350 (teacher instructions) + ~860 (tool schemas)
   on *every* turn of *every* chat, including chats with no codebase. The bigger
   waste is in the teacher's plan phase: it re-read README, an ADR and
   `schema.sql` with its own file tools (~7k chars) and wrote its own plan
   (`plan_init`) of the same decisions the map worker had already found.
   `rederive_next_problem` returns ~2.2k chars per problem. Fix ideas, measure
   before and after with the same script:
   - In rederive mode the teacher reads no repo files before the map arrives (the
     worker does that); `plan_init` gets a minimal plan: the root problem and
     one node per map problem, by title only.
   - Shorten the always-on instruction text. Move the detailed rederive rules
     to where they are needed (for example the `rederive_status` or
     `rederive_next_problem` result in rederive mode), so non-codebase chats
     carry only a short routing paragraph. Check against the skill whether
     anything per-turn can depend on the chat (tool descriptions can;
     instructions can't).
   - Trim `next_problem` output and the log tool's long parameter descriptions.

   **6b. Questions must use the host's question card.** The host already has
   `ask_user_question` (the agent used it for some questions). Some went out as
   plain prose instead, e.g. after the map arrived: "...the plan beside this
   message hasn't changed. Once you confirm it... Does the plan work for you,
   or do you want changes?" (sent with `send_to_user`, no card). Rule for both
   prober and teacher: every question to the learner, including plan
   confirmation, the routing question and each rederive question, goes through
   `ask_user_question`, one per message. Check the skill for whether the host
   has a native plan-approval step the teacher should use instead of asking.
   Also handle a dismissed card (`{"dismissed":true}`): seen in the transcript
   at the first rederive question; decide with the user what dismiss means
   (skip? pause?).

   **6c. Skipping doesn't advance, and log.md "is missing".** Found:
   - The cs50final archived log shows the agent logged a skipped D1 as a
     *finished* problem with notes "Not attempted... skipped", instead of
     `skipped: true`, so D1 counts as done and never comes back. Make skipping
     unmistakable: e.g. a separate `rederive_skip_problem({ id })` tool (or
     reject notes when they describe a skip), and have the skip/log result load
     or point straight to the next problem so the agent moves on in the same turn.
   - There is no `log.md` because rebuilding the cs50final map (07:16) moved the
     old log aside as `log.before-<stamp>.md`, as designed. It also lives in the
     plugin's `data\repos\<id>\`, not in the learner's repo, which the user didn't
     expect. Decide with the user: where the log should be visible (path in the
     status/next-problem output? an action that opens it?) and whether a rebuild
     should carry over entries whose problem titles still match.

   **6d. The top-bar button.**
   - Attach a folder with the composer's attach-files/folders control instead of
     typing a path. Check whether the session view (`context.view`, the
     unsent draft and attachments) exposes attached folder paths; if so,
     prefill the dialog (or skip it) from the attachment. Paths only, never
     file contents.
   - "Should go automatically after": the action can't post a message (no
     send API). Investigate a submission interceptor or another public hook
     that can start the session; if none exists, say so and keep "send any
     message".
   - In a chat already in rederive mode nothing happens: the saved-state line
     doesn't change, so the agent doesn't re-check status or build a map for the
     new repo. Fix: the action records a pending "start" (e.g. a `startedAt`
     stamp in `sessions.json`) that `savedStateLine` shows until the agent's next
     `rederive_status` call clears it, and the teacher instructions treat it as
     "restart with this repo: build the map if needed, open with the root problem".

   **6e. Routing question as a card.** Routing worked, but the routing
   question was prose. Covered by 6b; verify it in the re-test.

   **Done (2026-11-14).** What was built:
   - 6a: `npm run measure` prints prompt sizes. Per turn in a chat with no
     codebase: prober ~1,490 → ~970 tokens, teacher ~2,270 → ~740. The
     per-mode rules (`modeRules` in `src/instructions.ts`) ride in the teacher's
     `rederive_status` description and in `rederive_set_mode`'s result (for
     mid-turn switches). Problem tools load only for the teacher once the chat
     has a repo. Rederive: no file reads by the teacher, a two-node plan (root
     problem → "Design decisions, one at a time"; no titles, which would list
     upcoming problems), no plan go-ahead. `next_problem` drops evidence and
     sends the root problem only with D1 (status carries it too).
   - 6b: every question in a codebase chat goes through `ask_user_question`;
     a dismissed card = pause (one line, end turn, ask again next message).
     The host has no plan-approval step (presenting the plan ends the turn).
   - 6c: `rederive_skip_problem`; `log_problem` rejects skip-like notes;
     both return the next problem to open in the same turn. Rebuild carries
     over log entries whose titles match (renumbered); the old log is copied
     aside. "Show rederive log" top-bar action shows the log read-only.
   - 6d: no public API posts a message or starts a turn, so "send any
     message" stays. The action records `startPending` in `sessions.json`;
     the teacher's status description flags it and its next status call
     reports and clears it. The dialog prefills from a path in the unsent
     composer text.

   **Re-test 1 (2026-11-14) and fixes.** Prefill, skip and the question
   cards worked. Fixed, with the user's decisions:
   - A new chat reused the old map silently. Now `rederive_open_repo` reports a
     map left by an earlier chat and the prober asks once (card): continue, or
     start fresh. Fresh = `rederive_build_map({ rebuild: true })`, which now
     starts an empty log (old one kept aside); `keepProgress: true` carries
     matching titles over.
   - The button's restart was ignored (the tutor never called status). Now a
     submission interceptor puts a visible note, "(Rederive this repo: start
     fresh with <repo>.)", in front of the next message in that chat; both
     agents' instructions treat it as "rebuild fresh, open with the root
     problem". The backend's `startPending` is cleared when that message is
     accepted. Restart = start fresh.
   - Closing a card ends the tutor's turn in the host, so it can't say
     "paused". Closing now means "I'll reply in the chat box": the next
     message is the answer; "skip" skips; "go" re-asks as a card.
   - The log dialog wraps long paths.

   **Re-test 2 (2026-11-14): all passed.** Step 6 is complete.
7. **Routing eval.** `tests\routing-prompts.md`: ~15 prompts tagged with the
   expected mode (5 rederive, 5 onboarding, 5 normal), including tricky ones.
   User runs them in fresh sessions; tune instruction examples from failures.

   **Built (2026-11-14).** `tests\routing-prompts.md` holds the 15 prompts
   (R1–R5, O1–O5, N1–N5) with the reply to give if the routing question comes,
   an "Ask ok" flag for the one prompt whose goal is open to both readings
   (O5), and why each is tricky. `npm run routing-report` scores the runs
   from the chat transcripts (read-only): newest chat per prompt, matched by
   its first message; mode = first successful `rederive_set_mode` (none =
   normal); asking the routing question before it fails a row unless "Ask ok".
   Logic in `scripts\routing-eval.ts`, tested in `tests\routing-eval.test.ts`.
   Next: the user runs the 15 prompts; then tune the examples in `MODES` /
   `routing()` in `src\instructions.ts` from the failures and re-run those.

   **Run 1 (2026-11-14): 15/15 pass** (R5 run separately, also passed). No routing question
   was asked on any row. No mode carried over from earlier chats: every
   chat's `rederive_status` said "Mode: not set", and the same repos got
   rederive in R rows and onboarding in O rows. Not routing, but seen: the
   own-repo guess said cs50final is "likely someone else's" (few commits
   with the learner's git email) although R2 says "my CS50 final project"
   and O4 "I wrote it". Fixed with the user: the teacher uses the learner's
   words or the git guess when only one says anything or both agree; when
   they disagree it picks neither and asks once with a card.
   R2 re-run (chat_mwg61rwy): no card. The rule was only in the teacher's
   rules, but the prober opens the repo and decided alone ("don't assume he
   wrote it"). It also named a design decision while handing off ("start
   from its first problem: why the search engine is split into a crawler,
   an indexer and a querier"), which it can't know and which gives D-level
   answers away. Fixed: the ownership check is now in the prober's repo step
   (answer goes in probe_done; the teacher uses it), and prober step 6 names
   no design problems or decisions. Prober instructions grew ~90 tokens.
   R2 re-run 2 (chat_mwg65rqn): the ownership card came right after the
   repo opened, before the mode was set. The chat stopped at the
   continue-or-fresh card, so the handoff (no design problem named) and the
   teacher's opening are still unchecked. Seen: after "group project, I
   wrote some", the prober promised "we'll keep track of which parts you
   wrote", which nothing in the plugin does.
   Continued (same chat): the handoff named no design problem, and the
   teacher made the two-node plan and posed the root problem with no
   solution terms. Left: the prober's closing line still named the
   components ("decisions in the crawler, indexer and querier"), which
   hints at the split, and it repeated the mode message twice.

   **Step 7 is done (2026-11-14):** 15/15, no instruction tuning needed.

## Skills used per step

| Step | Skills | What for |
|---|---|---|
| 4. Map worker | `mattpocock-skills:tdd` | Test-first for the logic with clear inputs and outputs: validating map results against `resultSchema`, `next_problem` picking the next unlogged decision, `log_problem` writing rederive's `log.md` format. |
| | `mattpocock-skills:prototype` | Before wiring the worker, try the worker prompt on the cs50final summary (`npm run summary`) to check the decisions it picks look right. |
| 5. Instructions + UI | `mattpocock-skills:grilling` | First, before writing anything: settle routing/teaching behavior and the §9 open questions with the user. |
| | `mattpocock-skills:writing-for-agents` | Writing the prober/teacher instruction text and the worker instructions. |
| 6. Test fixes | `mattpocock-skills:grilling` | First: settle the open product questions in 6b (dismissed card), 6c (log location, carry-over on rebuild) and 6d (auto-start) with the user. |
| | `mattpocock-skills:diagnosing-bugs` | Each issue: reproduce from the transcript or a test before fixing. |
| | `mattpocock-skills:writing-for-agents` | Shortening and relocating the instruction text (6a, 6b). |
| 7. Routing eval | `mattpocock-skills:writing-for-agents` | Tuning instruction examples from routing failures. |
