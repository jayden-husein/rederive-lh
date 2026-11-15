// The graded cards (design and pick), shared by the backend and the browser bundle: names, the
// payload/answer/grade shapes, and what the answered card shows. Imports only names.ts,
// so the frontend never pulls in Node or schema code.
import { TOOL_NAMES } from "./names.ts";

export const DESIGN_QUESTION = {
  typeId: "rederive-design",
  label: "Your design",
  toolName: TOOL_NAMES.askDesign,
  contractVersion: 1,
} as const;

/** The pick card: the problem's options, with the host thinking box for the learner's reasoning. */
export const PICK_QUESTION = {
  typeId: "rederive-pick",
  label: "Your pick",
  toolName: TOOL_NAMES.askPick,
  contractVersion: 1,
} as const;

/** The card's input. No answer key: grading reads the map through the chat id. */
export interface DesignPayload {
  problemId: string;
  /** How many of the problem's constraints the learner has been given so far. */
  constraintsGiven: number;
  /** Pick cards (and design cards saved before the pick card existed): the learner picks one. */
  options?: { letter: string; text: string }[];
}

/** A pick or a free-text design. `why` only on picks saved before the pick card had the host thinking box. */
export type DesignAnswer = { choice: string; why?: string } | { design: string };

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

/** The answered card's badge and line. Any grading error reads "Not graded": the teacher judges it. */
export function gradeView(outcome: { result: unknown } | { error: string } | undefined): GradeView {
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
