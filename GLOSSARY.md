# Rederive

Teaching a codebase by having the learner re-derive its design decisions, one problem at a time, inside LearnHarness.

## Language

**Decision map**:
The hidden, ordered list of design problems for one repo, plus the root problem they all grow from.
_Avoid_: map file, plan

**Problem**:
One design decision on the decision map, presented to the learner without its answer.
_Avoid_: decision (when talking to the learner), step, question

**Log**:
The learner's record for one repo of which problems they finished or skipped, and what they derived.
_Avoid_: progress file, history

**Course**:
A repo's decision map seen from the learner's side: every problem with its state (done, skipped or to do) and the next problem to run.
_Avoid_: progress, status, snapshot

**Parts**:
The folders and files of a group project that the learner wrote themselves; their problems come first.
_Avoid_: ownership, authorship (for the recorded list)

**Restart note**:
The visible note put in front of the learner's next message after "Rederive this repo", telling the agent to start fresh.
_Avoid_: restart signal, start flag
