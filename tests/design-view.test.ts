// The graded cards' browser logic (design-view.ts), run against the stand-in DOM.
import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  PluginFrontendContext,
  PluginQuestionAnswerState,
  PluginQuestionEditorHandle,
  PluginQuestionEditorProps,
  PluginQuestionRenderer,
} from "learnharness-plugin-api";
import { DESIGN_QUESTION, MAX_DESIGN_CHARS, PICK_QUESTION } from "../src/design-card.ts";
import { registerDesignCards } from "../src/design-view.ts";
import { FakeDocument, type FakeElement } from "./fake-dom.ts";

const OPTIONS = [
  { letter: "A", text: "one big table" },
  { letter: "B", text: "a table per word" },
];

/** Both card renderers, with host widgets that only record what they were given. */
function cards() {
  const renderers = new Map<string, PluginQuestionRenderer>();
  const markdown: string[] = [];
  const badges: { text: string; color?: string }[] = [];
  const widget = { update: () => undefined, dispose: () => undefined };
  registerDesignCards({
    registerQuestionRenderer: (r: PluginQuestionRenderer) => renderers.set(r.id, r),
    ui: {
      mountMarkdown: (_slot: unknown, props: { text: string }) => (markdown.push(props.text), widget),
      mountBadge: (_slot: unknown, props: { text: string; color?: string }) => (badges.push(props), widget),
    },
  } as unknown as PluginFrontendContext);
  return { renderers, markdown, badges };
}

/** Mount a card's answer editor: the design card's, or with `options` the pick card's. */
function mountEditor(contractVersion: number, options?: typeof OPTIONS) {
  const renderer = cards().renderers.get(options ? PICK_QUESTION.typeId : DESIGN_QUESTION.typeId)!;
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  const states: PluginQuestionAnswerState[] = [];
  const props = {
    questionId: "q1",
    contractVersion,
    active: true,
    answer: { status: "empty" },
    input: { payload: { problemId: "D1", constraintsGiven: 0, ...(options ? { options } : {}) } },
    signal: new AbortController().signal,
    onChange: (state: PluginQuestionAnswerState) => states.push(state),
  } as unknown as PluginQuestionEditorProps;
  const handle = renderer.mountAnswerEditor(container as unknown as HTMLElement, props) as PluginQuestionEditorHandle;
  const box = container.findAll("textarea")[0];
  const radios = container.findAll("input").filter((i) => i.type === "radio");
  const type = (text: string) => {
    box!.value = text;
    box!.fire("input");
  };
  const pick = (index: number) => {
    radios.forEach((radio, i) => (radio.checked = i === index));
    radios[index]!.fire("change");
  };
  const press = (key: string, target: FakeElement = box ?? radios[0]!) => doc.press(key, target);
  return { doc, box: box!, radios, states, handle, type, pick, press };
}

test("typing publishes ready, unready and empty, with the slider's resting 50%", () => {
  const { states, type } = mountEditor(2);
  type("a queue of pages");
  assert.deepEqual(states.at(-1), { status: "ready", value: { design: "a queue of pages", confidence: 50 } });
  type("   ");
  assert.deepEqual(states.at(-1), { status: "unready", value: { design: "   ", confidence: 50 } });
  type("");
  assert.deepEqual(states.at(-1), { status: "empty" });
});

test("← and → move the confidence one stop, only for keys pressed inside the card", () => {
  const { doc, states, type, press } = mountEditor(2);
  type("a queue");
  assert.equal(press("ArrowLeft"), true);
  assert.deepEqual(states.at(-1), { status: "ready", value: { design: "a queue", confidence: 30 } });
  press("ArrowRight");
  press("ArrowRight");
  assert.deepEqual(states.at(-1), { status: "ready", value: { design: "a queue", confidence: 70 } });
  assert.equal(press("ArrowUp"), false);
  assert.equal(press("ArrowLeft", doc.createElement("textarea")), false);
  assert.deepEqual(states.at(-1), { status: "ready", value: { design: "a queue", confidence: 70 } });
});

test("a version 1 card has no slider: the arrow keys stay with the text box and the answer has no confidence", () => {
  const { states, type, press } = mountEditor(1);
  type("a queue");
  assert.equal(press("ArrowLeft"), false);
  assert.equal(press("ArrowRight"), false);
  assert.deepEqual(states.at(-1), { status: "ready", value: { design: "a queue" } });
});

test("dictation is appended with a space and stops at the answer's length cap", () => {
  const { box, states, handle, type } = mountEditor(2);
  type("first");
  void handle.appendTranscript!("second");
  assert.equal(box.value, "first second");
  void handle.appendTranscript!("x".repeat(MAX_DESIGN_CHARS + 500));
  assert.equal(box.value.length, MAX_DESIGN_CHARS);
  const last = states.at(-1) as { status: string; value: { design: string } };
  assert.equal(last.status, "ready");
  assert.equal(last.value.design.length, MAX_DESIGN_CHARS);
});

test("a disposed editor stops listening for keys and publishes nothing more", () => {
  const { doc, states, handle, type, press } = mountEditor(2);
  type("a queue");
  const before = states.length;
  handle.dispose();
  assert.equal(doc.keydown.length, 0);
  assert.equal(press("ArrowLeft"), false);
  type("more");
  assert.equal(states.length, before);
});

test("the pick card publishes the letter; a slider moved before the pick is kept for it", () => {
  const { radios, states, pick, press } = mountEditor(2, OPTIONS);
  assert.equal(radios.length, 2);
  assert.equal(press("ArrowRight"), true);
  assert.equal(states.length, 0, "nothing to publish before a pick");
  pick(1);
  assert.deepEqual(states.at(-1), { status: "ready", value: { choice: "B", confidence: 70 } });
  press("ArrowLeft");
  assert.deepEqual(states.at(-1), { status: "ready", value: { choice: "B", confidence: 50 } });
});

test("the pick card shows a saved answer, and locks once it is no longer active", () => {
  const { radios, states, handle, pick } = mountEditor(2, OPTIONS);
  handle.update({ answer: { status: "ready", value: { choice: "A", confidence: 90 } }, active: false });
  assert.deepEqual(radios.map((r) => [r.checked, r.disabled]), [[true, true], [false, true]]);
  pick(1);
  assert.equal(states.length, 0);
});

test("an answered card shows the answer, the verdict with the confidence, and the constraint it fails", () => {
  const { renderers, markdown, badges } = cards();
  const doc = new FakeDocument();
  const container = doc.createElement("div");
  const header = doc.createElement("div");
  const cleanup = renderers.get(DESIGN_QUESTION.typeId)!.mountAnswered!(container as unknown as HTMLElement, {
    signal: new AbortController().signal,
    input: { payload: { problemId: "D1", constraintsGiven: 1 } },
    answer: { design: "keep a list of pages", confidence: 90 },
    grading: { result: { verdict: "breaks", failedAt: 1, constraint: "pages link back to each other", gradedBy: "model" } },
    headerContainer: header as unknown as HTMLElement,
  } as never) as () => void;
  assert.deepEqual(markdown, ["keep a list of pages"]);
  assert.equal(badges[0]!.text, "Breaks · 90% sure");
  assert.ok(badges[0]!.color);
  assert.equal(header.children.length, 1, "the badge sits in the host's header");
  assert.deepEqual(container.findAll("p").map((p) => p.textContent), ["Breaks on: pages link back to each other"]);
  cleanup();
  assert.equal(container.children.length + header.children.length, 0);
});

test("an answered card whose grading failed reads Not graded", () => {
  const { renderers, badges } = cards();
  const container = new FakeDocument().createElement("div");
  void renderers.get(PICK_QUESTION.typeId)!.mountAnswered!(container as unknown as HTMLElement, {
    signal: new AbortController().signal,
    input: { payload: { problemId: "D1", constraintsGiven: 0, options: OPTIONS } },
    answer: { choice: "B" },
    grading: { error: "No cheap model is configured." },
  } as never);
  assert.deepEqual(badges, [{ text: "Not graded" }]);
});
