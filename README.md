# Rederive for LearnHarness

A [LearnHarness](https://github.com/amosblomqvist/learnharness) plugin that teaches
a codebase by having you re-derive its design decisions. You get the problem the
system had to solve, propose a design, and the tutor adds constraints one at a time
until your design either holds up or breaks. It never tells you the answer.

It brings the method of [rederive](https://github.com/EricJujianZou/rederive), a
Claude Code skill by Eric Zou, into LearnHarness, and routes between it and
LearnHarness's normal teaching depending on what you want from the code.

<!-- Screenshots: add images under docs/screenshots/ and link them here.
     Suggested: a design card graded "Partly", a pick card with the thinking box,
     a constraint sketch diagram, the "Rederive this repo" dialog. -->
_Screenshots coming soon._

## What it does

- **Builds a hidden decision map.** A background worker reads the repo (README,
  design docs, entry points, the import graph, turning-point commits) and picks
  5–10 design problems in the order the system would have been built. The map
  stays out of the chat; the tutor sees one problem at a time.
- **Teaches Socratically.** One question per message. The tutor poses the bare
  problem, you answer, it adds the next constraint. A better idea than the
  original counts as a win. When you get there, it names the general technique
  ("middleware chain"), not the repo's identifiers.
- **Grades your design answers.** Design questions come on a card: free text, or
  the problem's lettered options with LearnHarness's thinking box. Each answer is
  marked *Holds up*, *Partly* or *Breaks*, with the constraint it fails. Option
  picks are graded from the map without a model call; free text is graded by your
  cheap model slot. The answer key stays in the plugin's backend.
- **Teaches missing concepts normally.** If you're stuck because you don't know
  what a mutex or an index is, the tutor teaches that concept, checks it with a
  quiz, then returns to the same problem. If you're stuck on the design idea
  itself, it narrows the options or draws a sketch of the parts and where the
  constraint breaks, never the missing piece.
- **Handles group projects.** Tell it which folders you wrote and your own parts
  come first ("how does your code handle this, and why?"); your partners' parts
  are re-derived cold.
- **Logs progress.** Each problem is logged in rederive's `log.md` format: what
  you struggled with, what you found alone, any better idea. The "Show rederive
  log" button shows where it is.
- **Feeds your knowledge graph.** Derived decisions end up in the tutor's prose,
  which LearnHarness extracts into your knowledge graph like any other lesson.

## Modes

The plugin only steps in when you want to understand a specific codebase.

| Mode | When | What happens |
|---|---|---|
| **Rederive** | You want to explain or defend the design: "I built this with AI and can't explain it", interview prep, "why is it built like this?" | Problem by problem re-derivation, as above. |
| **Onboarding** | You'll work in the code: "I'm starting on this repo", "I need to add a feature" | A working map first (components, data flow, where things live, how to run and test), then an offer to re-derive the two or three decisions everything else depends on. Later "why is it like this?" moments get the same offer for that one decision. |
| **Normal** | A single file, function or error, or a concept with no repo | Plain LearnHarness teaching. The plugin stays out of the way. |

If your goal is unclear, you're asked once: do you want to work in this code, or
explain why it's designed this way? You can say "switch modes", "rederive this" or
"just explain it" at any time, and that always wins.

Repos can be a full local path or a git URL, which is cloned into the plugin's
data folder. On Windows, repos inside WSL work through their
`\\wsl.localhost\<distro>\...` path.

## Install

Requirements: LearnHarness 0.6.1 or later, and `git` on `PATH` (the plugin reads
repo history with it and clones repos given as URLs). On Windows, install
[Git for Windows](https://git-scm.com/download/win); on macOS, Git comes with the
Xcode command line tools (`xcode-select --install`); on Linux, use your package
manager.

Tested in the app on Windows. The tests also run on macOS and Linux in CI, but
nobody has tried the plugin in LearnHarness there yet: issues welcome.

1. Download `rederive-lh-<version>.zip` from the
   [latest release](../../releases/latest).
2. In LearnHarness, open **Settings → Community plugins** to see where the
   plugins directory is. Create a folder `rederive-lh/dist` inside it and extract
   the zip there, so you end up with
   `<plugins directory>/rederive-lh/dist/manifest.json`.
3. Back in **Settings → Community plugins**, click **Refresh**, then **Enable**
   Rederive.
4. Make sure a cheap model slot is set in LearnHarness. The map worker and the
   free-text grader use it.

To update, replace the files in `rederive-lh/dist` with the new zip's and restart
LearnHarness. The plugin keeps its maps, logs and settings in
`rederive-lh/data`, which updates don't touch.

### Build from source

Needs Node 22.18 or later and npm as well.

1. Clone this repo into the plugins directory as `rederive-lh`.
2. In `rederive-lh`, install and build (in Windows PowerShell, use `npm.cmd` if
   script execution is disabled):

   ```bash
   npm install
   ```

   ```bash
   npm run build
   ```

3. Refresh and Enable as above. After changing the code, rebuild and restart
   LearnHarness; there is no hot reload.

## Usage

Start a teaching session and talk about a repo: "I built this search engine with
AI and can't explain it, it's at `~/code/tse`." The
prober picks the mode, opens the repo, starts the map build and hands over to the
tutor.

Or click **Rederive this repo** in the top bar of a teaching session
(`Ctrl+Shift+R`, or `Cmd+Shift+R` on macOS), enter a path or URL and start fresh.

**Settings** (Settings → Community plugins → Rederive):

- **Default mode**: *Auto* picks from your goal (the default); *Ask* always asks
  the work-in-or-explain question; *Always* starts every codebase chat in rederive
  mode; *Never* waits until you ask for it.
- **Default repo**: suggested when you don't name one. It's opened only after you
  confirm.

## Safety

Repo contents are treated as data, never as instructions. If a file in the repo
tries to get the tutor to run commands, change files or fetch URLs, it won't, and
it tells you. The plugin never runs the repo's code, scripts, install steps or
tests, and never writes to the repo. Its git commands are read-only. Everything it
writes (maps, logs, clones, settings) goes in its own data folder.

## Development

```bash
npm.cmd run check
```

runs the typechecker and the tests (also run by the pre-commit hook). Other
scripts:

| Script | What it does |
|---|---|
| `build` | Bundles `src\` into `dist\` (the installed runtime package). |
| `package` | Builds, then zips `dist\` into `release\rederive-lh-<version>.zip` for a GitHub release. |
| `summary -- <repo>` | Prints the history and structure summary the map worker starts from. |
| `routing-report` | Scores the routing eval in `tests\routing-prompts.md`. |
| `transcript -- latest` | Prints a LearnHarness chat compactly (`--since 30m`, `--tail 40`, `--grep`). |
| `leak-check -- latest` | Flags map techniques shown before the learner reached them. |
| `render-diagrams -- latest` | Renders a chat's Mermaid diagrams to check them in a browser. |

Layout: `src\backend.ts` registers the instructions, tools, map worker and
grader; `src\main.ts` registers the settings, top-bar actions, tool renderers and
the design cards. The scripts that read chats (`transcript`, `leak-check`,
`render-diagrams`, `routing-report`) only read LearnHarness's learning data.

## Credits and license

The teaching method, decision-map approach, log format, and the git-history and
structure analysis (ported here from shell and Python to TypeScript, with added C
support) come from [rederive](https://github.com/EricJujianZou/rederive) by Eric
Zou, under the MIT license. See [THIRD_PARTY.md](THIRD_PARTY.md).

Built on the [LearnHarness](https://github.com/amosblomqvist/learnharness) plugin
API.

This plugin is licensed under the GNU Affero General Public License v3.0, matching
LearnHarness. See [LICENSE](LICENSE).
