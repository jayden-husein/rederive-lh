// The graded cards in the browser: the design card (one text box; no host thinking box,
// so dictation comes into the box) and the pick card (option rows; the host thinking
// box takes the reasoning and dictation). Both share the answered view: the answer, the
// verdict badge and the constraint it fails. Option texts and saved answers go through
// the host Markdown pipeline; styles.css uses host theme tokens.
import type {
  PluginFrontendContext,
  PluginQuestionAnswerState,
  PluginQuestionEditorHandle,
  PluginQuestionEditorProps,
  PluginQuestionRenderer,
} from "learnharness-plugin-api";
import { answerText, DESIGN_QUESTION, gradeView, PICK_QUESTION, type DesignAnswer, type DesignPayload, type GradeView } from "./design-card.ts";

type Ui = PluginFrontendContext["ui"];

let mountCount = 0;

const TONE_COLORS: Record<GradeView["tone"], string | undefined> = {
  good: "var(--color-green-500, #22c55e)",
  mid: "var(--color-amber-500, #f59e0b)",
  bad: "var(--color-red-500, #ef4444)",
  none: undefined,
};

/** A draft: any part of either answer shape, as the host hands it back. */
type Draft = Partial<{ choice: string; design: string }>;

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
      if (!disposed && active && input.checked) props.onChange({ status: "ready", value: { choice: option.letter } });
    });
    return input;
  });
  // The reasoning goes in the host thinking box (showThinking on the pick card), which
  // also takes dictation, so this editor has no box of its own.
  const apply = (state: PluginQuestionAnswerState, nextActive: boolean) => {
    active = nextActive;
    const choice = readAnswer(state).choice;
    for (const input of inputs) {
      input.checked = input.value === choice;
      input.disabled = !nextActive;
    }
  };
  apply(props.answer, props.active);
  return {
    update: ({ answer, active: nextActive }) => apply(answer, nextActive),
    focus: () => (inputs.find((i) => i.checked) ?? inputs[0])?.focus(),
    dispose: () => {
      disposed = true;
      for (const w of widgets) w.dispose();
      root.remove();
    },
  };
}

function mountDesignEditor(container: HTMLElement, props: PluginQuestionEditorProps): PluginQuestionEditorHandle {
  const root = cardRoot(container);
  const box = textBox(container.ownerDocument, "Your design", "Describe your design…");
  root.append(box);
  let disposed = false;
  let active = props.active;
  const publish = () => {
    if (disposed || !active) return;
    const design = box.value;
    props.onChange(design === "" ? { status: "empty" } : { status: design.trim() ? "ready" : "unready", value: { design } });
  };
  box.addEventListener("input", publish);
  const apply = (state: PluginQuestionAnswerState, nextActive: boolean) => {
    active = nextActive;
    setBox(box, readAnswer(state).design ?? "", nextActive);
  };
  apply(props.answer, props.active);
  return {
    update: ({ answer, active: nextActive }) => apply(answer, nextActive),
    focus: () => box.focus(),
    appendTranscript: (text) => {
      if (disposed || !active) return;
      appendSpeech(box, text);
      publish();
    },
    dispose: () => {
      disposed = true;
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

    const view = gradeView(props.grading);
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
    supportedContractVersions: [DESIGN_QUESTION.contractVersion],
    // A design card saved before the pick card existed may still carry options.
    mountAnswerEditor(container, props) {
      const payload = props.input.payload as unknown as DesignPayload;
      return payload.options?.length ? mountChoiceEditor(ctx.ui, container, payload, props) : mountDesignEditor(container, props);
    },
    mountAnswered,
  });
  ctx.registerQuestionRenderer({
    id: PICK_QUESTION.typeId,
    supportedContractVersions: [PICK_QUESTION.contractVersion],
    mountAnswerEditor: (container, props) => mountChoiceEditor(ctx.ui, container, props.input.payload as unknown as DesignPayload, props),
    mountAnswered,
  });
}
