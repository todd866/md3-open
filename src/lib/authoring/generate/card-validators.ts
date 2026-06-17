/**
 * Card validators — quality validation for authored cards.
 *
 * Catches obviously bad cards before they enter a study deck: too-short or
 * question-shaped answers, fronts that leak the answer, malformed cloze blanks,
 * "one-of-many" guessing cards, missing context/citation, and bad cloze span
 * selection (delegated to {@link detectBadClozeSpans}).
 *
 * This is the DB-free reference port: it operates purely on
 * {@link AuthoringCard}/{@link AuthoringQuestion} contract objects and plain
 * strings. The production filesystem image-existence check (does the image
 * exist in public/ or a sidecar?) is dropped — only the pure "front references
 * an image but the card carries no image" check is kept.
 */

import type { AuthoredItem, AuthoringQuestion } from "@/lib/authoring/contracts";
import { detectBadClozeSpans } from "@/lib/authoring/quality/cloze-quality";

/**
 * Extract MCQ option structure from a cloze card's front/back text for
 * guessability analysis. Returns null if no parseable MCQ option pattern is
 * present. (Authored MCQs use {@link AuthoringQuestion.options} directly; this
 * helper recovers options embedded in free-text fronts.)
 */
export function extractMCQOptions(
  front: string,
  back: string,
): { label: string; text: string; isCorrect: boolean }[] | null {
  // Match option lines like "A) text", "A. text", "A: text".
  const optionRegex = /^([A-E])[).:\s]\s*(.+)$/gm;
  const options: { label: string; text: string; isCorrect: boolean }[] = [];

  let match: RegExpExecArray | null;
  while ((match = optionRegex.exec(front)) !== null) {
    options.push({ label: match[1], text: match[2].trim(), isCorrect: false });
  }

  if (options.length < 2) return null;

  // Mark the correct answer by matching back text (case-insensitive).
  const backLower = back.toLowerCase().trim();
  for (const option of options) {
    if (option.text.toLowerCase().trim() === backLower) {
      option.isCorrect = true;
    }
  }

  return options;
}

/** A single card-quality finding. */
export interface CardQualityIssue {
  card: AuthoredItem;
  issue: string;
  severity: "error" | "warning";
}

/**
 * Validate a single authored cloze card and return its quality issues.
 *
 * MCQ items are validated only for the checks that apply to them; the bulk of
 * the rules target cloze fronts/blanks.
 */
export function validateCard(card: AuthoredItem): CardQualityIssue[] {
  const issues: CardQualityIssue[] = [];
  const push = (issue: string, severity: "error" | "warning") => issues.push({ card, issue, severity });

  if (card.cardType === "mcq") {
    return validateQuestion(card);
  }

  const front = card.front;
  const back = card.back;
  const backs = card.backs;
  const blankCount = (front.match(/\[___\]/g) ?? []).length;

  // Answer too short (likely parsing error). Allow 2–3 char answers — often
  // valid (abbreviations, percentages, codes). Only flag 1-char answers.
  // Skip for multi-cloze cards where back is just the first blank.
  if (back.length <= 1 && !(backs && backs.length > 1)) {
    push(`Answer too short: "${back}" (${back.length} chars)`, "error");
  }

  // Answer ends with ? (likely a header was used as answer).
  if (back.endsWith("?")) {
    push(`Answer looks like a question: "${back}"`, "error");
  }

  // Answer ends with : (likely a header label).
  if (back.endsWith(":")) {
    push(`Answer looks like a label: "${back}"`, "warning");
  }

  // Front already contains most of the answer (too easy).
  const backWords = back.toLowerCase().split(/\s+/);
  const frontLower = front.toLowerCase();
  const containedWords = backWords.filter((w) => w.length > 3 && frontLower.includes(w));
  if (containedWords.length > backWords.length * 0.5 && backWords.length > 1) {
    push(`Front contains too much of the answer: "${containedWords.join(", ")}"`, "warning");
  }

  // Missing cloze blank.
  if (!front.includes("[___]")) {
    push("Front has no cloze blank [___]", "error");
  }

  // Overlong fronts are hard to review and usually indicate card scope drift.
  const frontWordCount = front.split(/\s+/).filter(Boolean).length;
  if (frontWordCount > 45) {
    push(`Front unusually long: ${frontWordCount} words (target <= 45)`, "warning");
  }

  // Very long answers (might be a parsing error).
  if (back.length > 100 && !(backs && backs.length > 1)) {
    push(`Answer unusually long: ${back.length} chars`, "warning");
  }

  // Leading [___] — no question framing before the blank.
  const frontStripped = front.replace(/^(⚠️\s*DANGER:\s*|💡\s*PEARL:\s*|🔑\s*)/u, "").trimStart();
  if (frontStripped.startsWith("[___]")) {
    push("Front starts with [___] — no question framing before the blank", "warning");
  }

  // Bad cloze span selection: the blank tests a fragment rather than a semantic
  // unit (e.g. "[___]-4 weeks" → "2" should be "[___] weeks" → "2-4").
  const answers = backs && backs.length > 0 ? backs : [back];
  const badSpans = detectBadClozeSpans(front, answers);
  if (badSpans.length > 0) {
    const sample = badSpans
      .slice(0, 3)
      .map((span) => `blank ${span.blankIndex + 1} "${span.answer}" (${span.kind})`)
      .join(", ");
    push(`Bad cloze span selection: ${sample}`, "warning");
  }

  // Front references an image but the card carries none. (The production
  // filesystem existence check is dropped in this DB-free port.)
  if (
    /\b(look at the|shown in the|see the|in this) (image|figure|ecg|tracing|x-ray|ct|scan)\b/i.test(front)
  ) {
    push("Front references an image but card has no image", "error");
  }

  // Backs array / blank count mismatch.
  if (blankCount > 1 && (!backs || backs.length === 0)) {
    push(`Multi-blank cloze requires backs array; found ${blankCount} blanks with no backs`, "error");
  }
  if (backs && backs.length > 0 && blankCount > 0 && backs.length !== blankCount) {
    push(
      `backs array length (${backs.length}) does not match blank count (${blankCount}) — mismatch`,
      "error",
    );
  }

  // JSX/HTML tags in back text.
  if (/<[A-Za-z][^>]*>/.test(back)) {
    push(`Back contains HTML/JSX tags: "${back.slice(0, 60)}..."`, "warning");
  }

  // "One-of-many" cloze: front uses an indefinite article ("a characteristic
  // feature of Y is [___]") and answer is a single short word — several valid
  // answers could fill the blank, producing a "what am I thinking of" card.
  const oneOfMany =
    /\ba\s+(?:characteristic|common|typical|classic|frequent|recognised|recognized|possible|potential)\s+(?:symptom|feature|sign|finding|manifestation|complication|cause|side.?effect|presentation|example)\s+/i;
  if (oneOfMany.test(front) && back.split(/\s+/).length <= 2) {
    push(
      `"One-of-many" cloze: "${front.slice(0, 60)}..." → "${back}" (answer is one of several valid options)`,
      "warning",
    );
  }

  // Missing context — bare Q/A with no teaching value.
  if (!card.context || card.context.trim().length === 0) {
    push("Card has no context — students see bare Q/A with no explanation", "warning");
  }

  // Missing citation.
  if (!card.cite) {
    push("Card has no cite attribute — source not traceable", "warning");
  }

  return issues;
}

/**
 * Validate an authored MCQ. Checks structural soundness (option count, exactly
 * one correct answer) and traceability (citation).
 */
function validateQuestion(question: AuthoringQuestion): CardQualityIssue[] {
  const issues: CardQualityIssue[] = [];
  const push = (issue: string, severity: "error" | "warning") =>
    issues.push({ card: question, issue, severity });

  if (!question.stem || question.stem.trim().length === 0) {
    push("MCQ has no stem", "error");
  }

  const options = question.options ?? [];
  if (options.length < 2) {
    push(`MCQ has too few options: ${options.length} (need >= 2)`, "error");
  }

  const correctCount = options.filter((o) => o.isCorrect).length;
  if (correctCount === 0) {
    push("MCQ has no correct option marked", "error");
  } else if (correctCount > 1) {
    push(`MCQ has ${correctCount} correct options (single-best-answer expects 1)`, "warning");
  }

  if (!question.cite) {
    push("Question has no cite attribute — source not traceable", "warning");
  }

  return issues;
}

/** Validate all cards/questions and return the valid set plus a summary. */
export function validateAllCards(cards: AuthoredItem[]): {
  valid: AuthoredItem[];
  issues: CardQualityIssue[];
  summary: { errors: number; warnings: number; valid: number };
} {
  const allIssues: CardQualityIssue[] = [];
  const valid: AuthoredItem[] = [];

  for (const card of cards) {
    const cardIssues = validateCard(card);
    const hasError = cardIssues.some((i) => i.severity === "error");
    if (!hasError) valid.push(card);
    allIssues.push(...cardIssues);
  }

  const errors = allIssues.filter((i) => i.severity === "error").length;
  const warnings = allIssues.filter((i) => i.severity === "warning").length;

  return { valid, issues: allIssues, summary: { errors, warnings, valid: valid.length } };
}
