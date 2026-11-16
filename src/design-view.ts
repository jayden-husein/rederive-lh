// The graded cards in the browser: the design card (one text box; no host thinking box,
// so dictation comes into the box) and the pick card (option rows; the host thinking
// box takes the reasoning and dictation). Both share the answered view: the answer, the
// verdict badge (with how sure they were) and the constraint it fails. Version 2 cards
// add a confidence slider under the answer. Option texts and saved answers go through
// the host Markdown pipeline; styles.css uses host theme tokens.
import type {
  PluginFrontendContext,
  PluginQuestionAnswerState,
  PluginQuestionEditorHandle,
  PluginQuestionEditorProps,
  PluginQuestionRenderer,
} from "learnharness-plugin-api";
import {
  answerText,
  CARD_CONTRACT_VERSION,
  CONFIDENCE_COLORS,
  CONFIDENCE_STOPS,
  confidenceRailStyle,
  DEFAULT_CONFIDENCE,
  stepConfidence,
  DESIGN_QUESTION,
  gradeView,
  MAX_DESIGN_CHARS,
  PICK_QUESTION,
  readConfidence,
  SHOWN_CONTRACT_VERSIONS,
  snapConfidence,
  type Confidence,
  type DesignAnswer,
  type DesignPayload,
  type GradeView,
} from "./design-card.ts";

type Ui = PluginFrontendContext["ui"];

let mountCount = 0;

const TONE_COLORS: Record<GradeView["tone"], string | undefined> = {
  good: "var(--color-green-500, #22c55e)",
  mid: "var(--color-amber-500, #f59e0b)",
  bad: "var(--color-red-500, #ef4444)",
  none: undefined,
};

/** A draft: any part of either answer shape, as the host hands it back. */
type Draft = Partial<{ choice: string; design: string; confidence: Confidence }>;

interface ConfidenceSlider {
  /** Null on a version 1 card, which has no slider: its saved schema has no confidence. */
  value(): Confidence | null;
  apply(value: Confidence | null, active: boolean): void;
  /** ← / →: one stop down or up. True when it moved, so the caller can claim the key. */
  step(delta: number): boolean;
  /** Move focus to the slider; false on a version 1 card, which has none. */
  focus(): boolean;
  /** True when `target` is the slider itself. */
  owns(target: EventTarget | null): boolean;
}

/**
 * Plain ← / → anywhere in the card (the text box, the options, the slider) move the
 * confidence one stop: design answers are mostly dictated, so the text box doesn't need
 * them for the caret (decided with the user, 2026-11-15). The listener is on the window in
 * the capture phase, so it sees the key before the host's own handlers can claim it.
 */
function listenForArrows(root: HTMLElement, slider: ConfidenceSlider, signal: AbortSignal): () => void {
  const view = root.ownerDocument.defaultView;
  if (!view) return () => undefined;
  const onKey = (event: KeyboardEvent) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    // A version 1 card has no slider: the keys stay with the text box.
    if (slider.value() === null) return;
    if (!(event.target instanceof Node) || !root.contains(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    slider.step(event.key === "ArrowRight" ? 1 : -1);
  };
  view.addEventListener("keydown", onKey, { capture: true, signal });
  return () => view.removeEventListener("keydown", onKey, { capture: true });
}

/** Tab from the answer moves to the slider (the host's Tab chain doesn't know it); Tab from the slider goes on. */
function tabToSlider(slider: ConfidenceSlider, root: HTMLElement): "handled" | "pass" {
  const focused = root.ownerDocument.activeElement;
  if (slider.owns(focused) || !root.contains(focused)) return "pass";
  return slider.focus() ? "handled" : "pass";
}

/**
 * A copy of the native quiz's confidence row: "CONFIDENCE", a rail filled in the stop's
 * colour with ticks at the inner stops, a thumb in that colour, and the percent. Drags snap
 * to the stops; ←/→ move one stop. Rests at 50%. `onChange` runs when it moves.
 */
function mountConfidence(root: HTMLElement, props: PluginQuestionEditorProps, onChange: () => void): ConfidenceSlider {
  if (props.contractVersion < CARD_CONTRACT_VERSION) {
    return { value: () => null, apply: () => undefined, step: () => false, focus: () => false, owns: () => false };
  }
  const doc = root.ownerDocument;
  const row = doc.createElement("div");
  row.className = "rederive-confidence";
  const caption = doc.createElement("span");
  caption.className = "rederive-confidence-label";
  caption.textContent = "Confidence";
  const track = doc.createElement("div");
  track.className = "rederive-confidence-track";
  const rail = doc.createElement("div");
  rail.className = "rederive-confidence-rail";
  rail.setAttribute("aria-hidden", "true");
  const input = doc.createElement("input");
  input.type = "range";
  input.min = "0";
  input.max = "100";
  input.step = "1";
  input.setAttribute("aria-label", "Confidence — the probability your answer holds up");
  input.title = "The probability your answer holds up — 50% is a coin flip. Adjust with ←/→.";
  track.append(rail, input);
  const shown = doc.createElement("span");
  shown.className = "rederive-confidence-value";
  row.append(caption, track, shown);
  root.append(row);
  let current: Confidence = DEFAULT_CONFIDENCE;
  let active = props.active;
  const show = () => {
    input.value = String(current);
    input.style.color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(current)] ?? "";
    Object.assign(rail.style, confidenceRailStyle(current));
    shown.textContent = `${current}%`;
    input.setAttribute("aria-valuetext", `${current} percent`);
  };
  const set = (next: Confidence) => {
    const moved = next !== current;
    current = next;
    show();
    if (moved) onChange();
    return moved;
  };
  // Arrow keys come through listenForArrows: a step-1 range would move 50 → 51 and snap back.
  input.addEventListener("input", () => set(snapConfidence(Number(input.value))));
  show();
  return {
    value: () => current,
    apply: (value, nextActive) => {
      active = nextActive;
      current = value ?? current;
      input.disabled = !nextActive;
      show();
    },
    step: (delta) => active && set(stepConfidence(current, delta)),
    focus: () => {
      if (input.disabled) return false;
      input.focus();
      return true;
    },
    owns: (target) => target === input,
  };
}

function readAnswer(state: PluginQuestionAnswerState): Draft {
  if (state.status === "empty" || typeof state.value !== "object" || state.value === null) return {};
  return state.value as Draft;
}

/** A text box styled like a native answer field. */
function textBox(doc: Document, label: string, placeholder: string): HTMLTextAreaElement {
  const box = doc.createElement("textarea");
  box.className = "rederive-input";
  box.placeholder = placeholder;
  box.setAttribute("aria-label", label);
  return box;
}

/** Append dictated text, with a space when the box doesn't end in one. */
function appendSpeech(box: HTMLTextAreaElement, text: string): void {
  box.value = box.value && !/\s$/.test(box.value) ? `${box.value} ${text}` : `${box.value}${text}`;
}

/** Set a box from controlled state without echoing, so the caret stays put while typing. */
function setBox(box: HTMLTextAreaElement, value: string, active: boolean): void {
  if (box.value !== value) box.value = value;
  box.readOnly = !active;
}

function cardRoot(container: HTMLElement): HTMLElement {
  const root = container.ownerDocument.createElement("div");
  root.className = "rederive-card";
  container.append(root);
  return root;
}

function mountMarkdown(ui: Ui, parent: HTMLElement, text: string, signal: AbortSignal) {
  const slot = parent.ownerDocument.createElement("div");
  slot.className = "rederive-markdown";
  parent.append(slot);
  return ui.mountMarkdown(slot, { text }, { signal });
}

function mountChoiceEditor(ui: Ui, container: HTMLElement, payload: DesignPayload, props: PluginQuestionEditorProps): PluginQuestionEditorHandle {
  const doc = container.ownerDocument;
  const root = cardRoot(container);
  // Per mount, so an old and a new mount of the same question never share one radio group.
  const group = `rederive-${props.questionId}-${++mountCount}`;
  let active = props.active;
  let disposed = false;
  const widgets: { dispose(): void }[] = [];
  const publish = (choice: string) => {
    if (disposed || !active) return;
    const confidence = slider.value();
    props.onChange({ status: "ready", value: confidence === null ? { choice } : { choice, confidence } });
  };
  const inputs = (payload.options ?? []).map((option) => {
    const row = doc.createElement("label");
    row.className = "rederive-option";
    const input = doc.createElement("input");
    input.type = "radio";
    input.name = group;
    input.value = option.letter;
    const letter = doc.createElement("span");
    letter.className = "rederive-letter";
    letter.textContent = `${option.letter}.`;
    row.append(input, letter);
    root.append(row);
    widgets.push(mountMarkdown(ui, row, option.text, props.signal));
    input.addEventListener("change", () => {
      if (input.checked) publish(option.letter);
    });
    return input;
  });
  // Moving the slider before picking keeps the value for the pick.
  const slider = mountConfidence(root, props, () => {
    const picked = inputs.find((i) => i.checked);
    if (picked) publish(picked.value);
  });
  // As in the native quiz, ← / → move the confidence; ↑ / ↓ still pick.
  const stopArrows = listenForArrows(root, slider, props.signal);
  // The reasoning goes in the host thinking box (showThinking on the pick card), which
  // also takes dictation, so this editor has no box of its own.
  const apply = (state: PluginQuestionAnswerState, nextActive: boolean) => {
    active = nextActive;
    const draft = readAnswer(state);
    for (const input of inputs) {
      input.checked = input.value === draft.choice;
      input.disabled = !nextActive;
    }
    slider.apply(draft.confidence ?? null, nextActive);
  };
  apply(props.answer, props.active);
  return {
    update: ({ answer, active: nextActive }) => apply(answer, nextActive),
    focus: () => (inputs.find((i) => i.checked) ?? inputs[0])?.focus(),
    handleKeyDown: (key) => (key === "Tab" ? tabToSlider(slider, root) : "pass"),
    dispose: () => {
      disposed = true;
      stopArrows();
      for (const w of widgets) w.dispose();
      root.remove();
    },
  };
}

function mountDesignEditor(container: HTMLElement, props: PluginQuestionEditorProps): PluginQuestionEditorHandle {
  const root = cardRoot(container);
  const box = textBox(container.ownerDocument, "Your design", "Describe your design…");
  box.maxLength = MAX_DESIGN_CHARS;
  root.append(box);
  let disposed = false;
  let active = props.active;
  const publish = () => {
    if (disposed || !active) return;
    const design = box.value;
    const confidence = slider.value();
    const value: Record<string, string | number> = confidence === null ? { design } : { design, confidence };
    props.onChange(design === "" ? { status: "empty" } : { status: design.trim() ? "ready" : "unready", value });
  };
  box.addEventListener("input", publish);
  // Under the box; an empty box keeps the slider's value locally until there is text.
  const slider = mountConfidence(root, props, publish);
  const stopArrows = listenForArrows(root, slider, props.signal);
  const apply = (state: PluginQuestionAnswerState, nextActive: boolean) => {
    active = nextActive;
    const draft = readAnswer(state);
    setBox(box, draft.design ?? "", nextActive);
    slider.apply(draft.confidence ?? null, nextActive);
  };
  apply(props.answer, props.active);
  return {
    update: ({ answer, active: nextActive }) => apply(answer, nextActive),
    focus: () => box.focus(),
    handleKeyDown: (key) => (key === "Tab" ? tabToSlider(slider, root) : "pass"),
    appendTranscript: (text) => {
      if (disposed || !active) return;
      appendSpeech(box, text);
      // maxLength only stops typing; dictation sets the value directly.
      if (box.value.length > MAX_DESIGN_CHARS) box.value = box.value.slice(0, MAX_DESIGN_CHARS);
      publish();
    },
    dispose: () => {
      disposed = true;
      stopArrows();
      root.remove();
    },
  };
}

export function registerDesignCards(ctx: PluginFrontendContext): void {
  // Both cards show answers and grades the same way.
  const mountAnswered: NonNullable<PluginQuestionRenderer["mountAnswered"]> = (container, props) => {
    if (props.signal.aborted) return;
    const root = cardRoot(container);
    const answer = mountMarkdown(ctx.ui, root, answerText(props.input.payload as unknown as DesignPayload, props.answer as unknown as DesignAnswer), props.signal);

    const view = gradeView(props.grading, readConfidence(props.answer));
    const badgeSlot = container.ownerDocument.createElement("span");
    (props.headerContainer ?? root).append(badgeSlot);
    const color = TONE_COLORS[view.tone];
    const badge = ctx.ui.mountBadge(badgeSlot, { text: view.badge, ...(color ? { color } : {}) }, { signal: props.signal });
    if (view.detail) {
      const detail = container.ownerDocument.createElement("p");
      detail.className = "rederive-detail";
      detail.textContent = view.detail;
      root.append(detail);
    }
    return () => {
      badge.dispose();
      answer.dispose();
      badgeSlot.remove();
      root.remove();
    };
  };

  ctx.registerQuestionRenderer({
    id: DESIGN_QUESTION.typeId,
    supportedContractVersions: SHOWN_CONTRACT_VERSIONS,
    // A design card saved before the pick card existed may still carry options.
    mountAnswerEditor(container, props) {
      const payload = props.input.payload as unknown as DesignPayload;
      return payload.options?.length ? mountChoiceEditor(ctx.ui, container, payload, props) : mountDesignEditor(container, props);
    },
    mountAnswered,
  });
  ctx.registerQuestionRenderer({
    id: PICK_QUESTION.typeId,
    supportedContractVersions: SHOWN_CONTRACT_VERSIONS,
    mountAnswerEditor: (container, props) => mountChoiceEditor(ctx.ui, container, props.input.payload as unknown as DesignPayload, props),
    mountAnswered,
  });
}
