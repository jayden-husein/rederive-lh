# Routing eval

Fifteen opening messages, each tagged with the mode the prober should pick:
5 rederive, 5 onboarding, 5 normal. The tricky ones are written to pull
toward the wrong mode; the notes say how. Target: at least 13/15.

## Setup

- Settings → Community plugins → Rederive: default mode **auto**, default repo
  **empty**. (A default repo makes the prober offer it, which changes the flow.)
- cs50final and dali-challenge already have maps: opening one makes the prober
  ask "continue or start fresh?" after it sets the mode. Stop there; the mode is
  already decided. `ref\rederive` has no map yet, so whichever of R4/O3 runs
  first starts one map build (one worker run on the cheap slot); the other then
  gets the continue-or-fresh question.

The repo paths in the prompts are examples (two of your own repos under WSL
and a local clone of rederive). Before a run, change them in this file to real
repos on your machine: the report matches chats against the prompts as written
here.

## Running

For each row: open a **new** teaching chat and paste the prompt exactly as
written (the report matches chats by their first message).

- If the prober asks the routing question ("work in this code, or explain why
  it's designed this way?"), answer with the row's **If asked** reply.
- Stop the chat once the prober has called `rederive_set_mode`, or, for normal
  prompts, once it has replied or handed off without calling it.

Then score every run at once:

```bash
npm run routing-report
```

It reads the chat transcripts (read-only), finds the newest chat for each
prompt and prints the mode picked, whether the routing question was asked, and
the score. Pass `-- --since 2026-11-15T09:00` to ignore older runs.

## Scoring

A row passes when the first mode set by `rederive_set_mode` (no call = normal)
equals **Expected**, and the routing question was not asked. Rows marked
**Ask ok** also pass when the prober asks first and the reply leads to the
expected mode: their goal is genuinely open to both readings.

The report spots the routing question by its wording ("work in this code").
It also lists every card asked before the mode was set: if one is a reworded
routing question on a row without Ask ok, count that row as a fail by hand.

## Prompts

| Id | Expected | Ask ok | Prompt | If asked | Why it's here |
|----|----------|--------|--------|----------|---------------|
| R1 | rederive | no | I built `\\wsl.localhost\Ubuntu\home\me\dali-challenge` mostly with Copilot and couldn't explain half of it if someone asked me. Help me actually understand it. | Explain why it's designed this way | The plain case: built with AI, can't explain it. |
| R2 | rederive | no | I have a technical interview on Thursday and they're going to ask me about my CS50 final project at `\\wsl.localhost\Ubuntu\home\me\cs50final`. Help me get ready. | Explain why it's designed this way | Interview prep; "get ready" can read as getting up to speed (onboarding). |
| R3 | rederive | no | Why is `\\wsl.localhost\Ubuntu\home\me\cs50final` split into a crawler, an indexer and a querier that only talk through files? It seems like a weird way to build a search engine. | Explain why it's designed this way | One specific question, which can pull toward normal; but it asks why the design is the way it is. |
| R4 | rederive | no | I want to get better at designing systems. Can we go through `C:\code\rederive` and work out why it's built the way it is? | Explain why it's designed this way | Studying someone else's project to improve at design. |
| R5 | rederive | no | Help me understand `\\wsl.localhost\Ubuntu\home\me\dali-challenge`. I have to present its architecture to the judges next week and they'll grill me on the choices. | Explain why it's designed this way | Opens with the vague "help me understand"; the goal (defend the choices) comes second. |
| O1 | onboarding | no | I'm joining the team that maintains `\\wsl.localhost\Ubuntu\home\me\dali-challenge` next week. Get me up to speed on the codebase. | Work in the code | The plain case. |
| O2 | onboarding | no | I need to add search by date to `\\wsl.localhost\Ubuntu\home\me\cs50final`. Where do I even start? | Work in the code | A single task can look like normal mode, but they will work in the whole repo. |
| O3 | onboarding | no | There's an open issue on `C:\code\rederive` I'd like to fix as my first open-source contribution. Walk me through the code first. | Work in the code | Someone else's well-known project, which can pull toward rederive (studying a known project). |
| O4 | onboarding | no | I wrote `\\wsl.localhost\Ubuntu\home\me\cs50final` last year and have forgotten all of it. Now I have to extend it for a new assignment. | Work in the code | Their own forgotten code, which can pull toward rederive ("I built this and can't explain it"); the goal is to extend it. |
| O5 | onboarding | yes | Teach me `\\wsl.localhost\Ubuntu\home\me\dali-challenge` well enough that I can review my teammates' pull requests on it. | Work in the code | Reviewing needs both working knowledge and judging design; working in it comes first. |
| N1 | normal | no | What's the difference between a mutex and a semaphore? | — | A concept with no repo. |
| N2 | normal | no | I get a segfault in `\\wsl.localhost\Ubuntu\home\me\cs50final\crawler\crawler.c` when the crawler frees its bag of pages. What's going on? | — | A real repo path, but one file and one error. |
| N3 | normal | no | What does this C line do: `while ((c = *str++)) hash = ((hash << 5) + hash) + c;` | — | Code, but a snippet with no repo. |
| N4 | normal | no | Why do so many Java codebases use dependency injection? I keep seeing it everywhere. | — | "Why" plus "codebases", which can pull toward rederive, but no specific repo. |
| N5 | normal | no | How is a git repository organized on disk? What's actually inside the .git folder? | — | Says "repository" but asks about a concept. |
