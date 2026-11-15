// The graded cards (design and pick), shared by the backend and the browser bundle: names, the
// payload/answer/grade shapes, and what the answered card shows. Imports only names.ts,
// so the frontend never pulls in Node or schema code.
import { TOOL_NAMES } from "./names.ts";

/**
 * Version 2 added the confidence slider to the answer. The browser still shows version 1
 * cards; the backend answers only the current version, as the host contract requires.
 */
export const CARD_CONTRACT_VERSION = 2;
export const SHOWN_CONTRACT_VERSIONS = [1, CARD_CONTRACT_VERSION];

export const DESIGN_QUESTION = {
  typeId: "rederive-design",
  label: "Your design",
  toolName: TOOL_NAMES.askDesign,
  contractVersion: CARD_CONTRACT_VERSION,
} as const;

/** The pick card: the problem's options, with the host thinking box for the learner's reasoning. */
export const PICK_QUESTION = {
  typeId: "rederive-pick",
  label: "Your pick",
  toolName: TOOL_NAMES.askPick,
  contractVersion: CARD_CONTRACT_VERSION,
} as const;

/**
 * The confidence slider's stops, the same as the native quiz's (LearnHarness 0.6.x):
 * how sure the learner is that their answer holds up, in percent. 50 is a coin flip and
 * the resting value, so an untouched slider records 50.
 */
export const CONFIDENCE_STOPS = [0, 30, 50, 70, 90, 100] as const;
export type Confidence = (typeof CONFIDENCE_STOPS)[number];
export const DEFAULT_CONFIDENCE: Confidence = 50;

/** The native slider's colour per stop, red at 0% to green at 100% (LearnHarness 0.6.x). */
export const CONFIDENCE_COLORS = ["#ef4444", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981"] as const;

const TICK = "color-mix(in oklab, var(--foreground) 35%, transparent)";
const TICKS = [30, 50, 70, 90];

/** The rail behind the slider, as the native quiz draws it: filled up to `stop` in its colour, ticks at the inner stops. */
export function confidenceRailStyle(stop: Confidence): Record<string, string> {
  const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(stop)] ?? CONFIDENCE_COLORS[2];
  return {
    backgroundColor: "var(--background)",
    backgroundImage: [`linear-gradient(90deg, ${color} 0%, ${color} ${stop}%, transparent ${stop}%, transparent 100%)`, ...TICKS.map(() => `linear-gradient(90deg, ${TICK}, ${TICK})`)].join(", "),
    backgroundSize: ["100% 100%", ...TICKS.map(() => "1px 100%")].join(", "),
    backgroundPosition: ["0 0", ...TICKS.map((t) => `${t}% 0`)].join(", "),
    backgroundRepeat: "no-repeat",
  };
}

/** The stop `delta` stops away from `stop`, held at the ends (← and → on the native slider). */
export function stepConfidence(stop: Confidence, delta: number): Confidence {
  const at = CONFIDENCE_STOPS.indexOf(stop);
  return CONFIDENCE_STOPS[Math.min(CONFIDENCE_STOPS.length - 1, Math.max(0, at + delta))]!;
}

/** The stop nearest to `value`. */
export function snapConfidence(value: number): Confidence {
  let best: Confidence = CONFIDENCE_STOPS[0];
  for (const stop of CONFIDENCE_STOPS) if (Math.abs(stop - value) < Math.abs(best - value)) best = stop;
  return best;
}

/** A saved confidence, or null when the answer has none (a version 1 card). */
export function readConfidence(answer: unknown): Confidence | null {
  const value = typeof answer === "object" && answer !== null ? (answer as { confidence?: unknown }).confidence : undefined;
  return typeof value === "number" && (CONFIDENCE_STOPS as readonly number[]).includes(value) ? (value as Confidence) : null;
}

/** The card's input. No answer key: grading reads the map through the chat id. */
export interface DesignPayload {
  problemId: string;
  /** How many of the problem's constraints the learner has been given so far. */
  constraintsGiven: number;
  /** Pick cards (and design cards saved before the pick card existed): the learner picks one. */
  options?: { letter: string; text: string }[];
}

/**
 * A pick or a free-text design, with how sure the learner is (version 2 cards). `why` only
 * on picks saved before the pick card had the host thinking box.
 */
export type DesignAnswer = ({ choice: string; why?: string } | { design: string }) & { confidence?: Confidence };

export type Verdict = "holds" | "partly" | "breaks";

/** What gradeAnswer returns. `constraint` is map text for a constraint already given. */
export interface DesignGrade {
  verdict: Verdict;
  /** The constraint it fails (1-based), 0 for the bare problem, null when it holds or none was named. */
  failedAt: number | null;
  constraint: string | null;
  gradedBy: "map" | "model";
}

const VERDICTS: readonly string[] = ["holds", "partly", "breaks"];

/** A saved grade, or null if it isn't one (an older or broken result). */
export function readGrade(value: unknown): DesignGrade | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.verdict !== "string" || !VERDICTS.includes(v.verdict)) return null;
  const failedAt = typeof v.failedAt === "number" && Number.isInteger(v.failedAt) && v.failedAt >= 0 ? v.failedAt : null;
  const constraint = typeof v.constraint === "string" && v.constraint.trim() ? v.constraint : null;
  return { verdict: v.verdict as Verdict, failedAt, constraint, gradedBy: v.gradedBy === "map" ? "map" : "model" };
}

export interface GradeView {
  badge: string;
  tone: "good" | "mid" | "bad" | "none";
  detail: string | null;
}

const NOT_GRADED: GradeView = { badge: "Not graded", tone: "none", detail: null };

/**
 * The answered card's badge and line. Any grading error reads "Not graded": the teacher
 * judges it. With a confidence, the badge says how sure they were: "Breaks · 90% sure".
 */
export function gradeView(outcome: { result: unknown } | { error: string } | undefined, confidence: Confidence | null = null): GradeView {
  const view = verdictView(outcome);
  return confidence === null ? view : { ...view, badge: `${view.badge} · ${confidence}% sure` };
}

function verdictView(outcome: { result: unknown } | { error: string } | undefined): GradeView {
  const grade = outcome && "result" in outcome ? readGrade(outcome.result) : null;
  if (!grade) return NOT_GRADED;
  if (grade.verdict === "holds") return { badge: "Holds up so far", tone: "good", detail: null };
  const partly = grade.verdict === "partly";
  const detail = grade.constraint
    ? `${partly ? "Doesn't fully handle" : "Breaks on"}: ${grade.constraint}`
    : grade.failedAt === 0
      ? partly ? "Doesn't fully solve the problem yet." : "Doesn't solve the problem yet."
      : null;
  return { badge: partly ? "Partly holds" : "Breaks", tone: partly ? "mid" : "bad", detail };
}

/** The learner's answer as Markdown: the picked option, or their design. */
export function answerText(payload: DesignPayload, answer: DesignAnswer): string {
  if ("choice" in answer) {
    const option = payload.options?.find((o) => o.letter === answer.choice);
    const pick = option ? `**${option.letter}.** ${option.text}` : answer.choice;
    return answer.why?.trim() ? `${pick}\n\nWhy: ${answer.why.trim()}` : pick;
  }
  return answer.design;
}
