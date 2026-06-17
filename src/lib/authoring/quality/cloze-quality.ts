/**
 * Cloze quality — detect bad cloze blanking.
 *
 * A blank is "bad" when it tests a fragment rather than a semantic unit, or
 * when the answer is given away by surrounding text. This module finds four
 * failure modes:
 *
 * - partial-range     — the blank splits a numeric range ("[___]-4 weeks" → "2")
 * - short-answer-leak — a 1–2 char answer appears verbatim elsewhere in the front
 * - term-fragment     — a single capital letter blanked off a real word
 * - decode-leak       — an adjacent parenthetical acronym spells out the answer
 *
 * {@link detectBadClozeSpans} is the pure core. {@link clozeQualityGate} wraps
 * it as a {@link QualityGate} so it can run in the quality-gate pipeline and
 * emit {@link QualityIssue} rows.
 */

import type { AuthoringCard, QualityGate, QualityIssue } from "@/lib/authoring/contracts";

export type BadClozeSpanKind = "partial-range" | "short-answer-leak" | "term-fragment" | "decode-leak";

export interface BadClozeSpan {
  kind: BadClozeSpanKind;
  blankIndex: number;
  answer: string;
}

const BLANK_TOKEN = "[___]";

const RANGE_DASH = "[-–—]";
const SIMPLE_NUMBER = /^[<>≤≥]?\s*-?\d+(?:\.\d+)?$/;
const SHORT_TOKEN = /^[A-Za-z0-9]{1,2}$/;
const SINGLE_UPPER_LETTER = /^[A-Z]$/;

const TERM_FRAGMENT_LEFT_ALLOWLIST = new Set([
  "type",
  "class",
  "group",
  "grade",
  "stage",
  "category",
  "score",
  "asa",
  "nyha",
  "figo",
]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function contextWithoutBlank(before: string, after: string): string {
  return `${before} ${after}`;
}

function isPartialRange(answer: string, before: string, after: string): boolean {
  if (!SIMPLE_NUMBER.test(answer.trim())) return false;

  const beforeTrim = before.trimEnd();
  const afterTrim = after.trimStart();

  // Exclude operator-prefixed numerals like "+0 and", "/10", ":1000" — these
  // are gestation notation, ratios, fractions, not range tells. The number must
  // have a "free" left boundary (start, whitespace, or non-operator punctuation).
  const afterStartsRange =
    new RegExp(`^${RANGE_DASH}\\s*\\d`).test(afterTrim) ||
    /^(?:to|and)\s+(?:^|[\s(,;:])?\d/i.test(afterTrim);
  const beforeEndsRange =
    new RegExp(`(?:^|[\\s(,;:])\\d\\s*${RANGE_DASH}$`).test(beforeTrim) ||
    /(?:^|[\s(,;:])\d\s+(?:to|and)$/i.test(beforeTrim);

  return afterStartsRange || beforeEndsRange;
}

function hasShortAnswerLeak(answer: string, before: string, after: string): boolean {
  const token = answer.trim();
  if (!SHORT_TOKEN.test(token)) return false;

  // Mask hyphenated fixed identifiers (DSM-5, ICD-10, COVID-19) so e.g.
  // "5 of 9 DSM-5 criteria" doesn't false-flag the answer "5".
  const text = contextWithoutBlank(before, after).replace(/\b[A-Z]{2,}-\d+\b/g, " ");

  const re = new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(token)}($|[^A-Za-z0-9])`, "i");
  if (re.test(text)) return true;

  // Single-letter answer leaked inside an UPPERCASE acronym ≥3 chars in front —
  // e.g. "AVPU score is [___]" → "P" (third letter of AVPU).
  if (SINGLE_UPPER_LETTER.test(token)) {
    const acronyms = text.match(/\b[A-Z]{3,}\b/g) ?? [];
    if (acronyms.some((a) => a.includes(token))) return true;
  }

  // Binary-classifier leak: a paired classifier (type/class/stage/grade) is
  // mentioned with a *different* single letter — answer forced by the binary.
  // e.g. "type [___] = hypoperfusion; type B = no hypoperfusion" → "A".
  if (SINGLE_UPPER_LETTER.test(token)) {
    const pairedRe = /\b(?:type|class|stage|grade|category|group)\s+([A-E])\b/gi;
    for (const m of text.matchAll(pairedRe)) {
      if (m[1].toUpperCase() !== token.toUpperCase()) return true;
    }
  }

  return false;
}

function isTermFragment(answer: string, before: string, after: string): boolean {
  const token = answer.trim();
  if (!SINGLE_UPPER_LETTER.test(token)) return false;

  const beforeWord = before.match(/([A-Za-z][a-z]{2,})\s*$/)?.[1]?.toLowerCase();
  if (!beforeWord) return false;
  if (TERM_FRAGMENT_LEFT_ALLOWLIST.has(beforeWord)) return false;

  const afterTrim = after.trimStart();
  return afterTrim === "" || /^[).,;:]/.test(afterTrim);
}

function wordsOf(text: string): string[] {
  return text
    .split(/\s+/)
    .map((w) => w.replace(/[^A-Za-z0-9-]/g, ""))
    .filter(Boolean);
}

function initialsOf(words: string[]): string {
  return words
    .flatMap((w) => w.split(/[-/]+/))
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

// Decode-leak: an adjacent parenthetical acronym spells out the very phrase the
// blank belongs to, so the answer is given away by its own abbreviation.
// e.g. "[oral] rehydration solution (ORS)" → O+R+S = ORS.
// Scoped to lone uppercase initialisms (≥2 capitals) so single-word qualifiers
// like "(Caucasian)", routes like "(IV)", and brand eponyms don't false-flag.
function isDecodeLeak(answer: string, before: string, after: string): boolean {
  const paren = after.match(/^([^.()]*?)\(([A-Za-z][A-Za-z0-9/-]{1,8})\)/);
  if (!paren) return false;
  const between = paren[1];
  const acronym = paren[2];
  const capitalCount = (acronym.match(/[A-Z]/g) ?? []).length;
  if (capitalCount < 2) return false;

  const beforeInitials = initialsOf(wordsOf(before));
  const spanInitials = initialsOf([...wordsOf(before), answer, ...wordsOf(between)]);
  const acronymUpper = acronym.toUpperCase();
  if (!spanInitials.endsWith(acronymUpper)) return false;
  // The blank must fall inside the final acronym-span — otherwise the acronym
  // is decoding neighbouring words, not the answer.
  return beforeInitials.length >= spanInitials.length - acronymUpper.length;
}

/**
 * Detect bad cloze spans in a front string given its ordered answers.
 * `front` uses the `[___]` blank token; `answers` are positional (answers[i]
 * fills the i-th blank).
 */
export function detectBadClozeSpans(front: string, answers: string[]): BadClozeSpan[] {
  const segments = front.split(BLANK_TOKEN);
  const blankCount = segments.length - 1;
  if (blankCount <= 0 || answers.length === 0) return [];

  const issues: BadClozeSpan[] = [];
  const limit = Math.min(blankCount, answers.length);

  for (let i = 0; i < limit; i += 1) {
    const answer = String(answers[i] ?? "").trim();
    if (!answer) continue;

    const before = segments[i] ?? "";
    const after = segments[i + 1] ?? "";

    if (isPartialRange(answer, before, after)) {
      issues.push({ kind: "partial-range", blankIndex: i, answer });
      continue;
    }
    if (hasShortAnswerLeak(answer, before, after)) {
      issues.push({ kind: "short-answer-leak", blankIndex: i, answer });
      continue;
    }
    if (isTermFragment(answer, before, after)) {
      issues.push({ kind: "term-fragment", blankIndex: i, answer });
      continue;
    }
    if (isDecodeLeak(answer, before, after)) {
      issues.push({ kind: "decode-leak", blankIndex: i, answer });
    }
  }

  return issues;
}

const KIND_MESSAGES: Record<BadClozeSpanKind, string> = {
  "partial-range": "blank splits a numeric range — blank the whole range instead",
  "short-answer-leak": "short answer appears elsewhere in the front (guessable)",
  "term-fragment": "single letter blanked off a real word — blank the whole term",
  "decode-leak": "answer is spelled out by an adjacent parenthetical acronym",
};

/** Map a detected span to its contract {@link QualityIssue}. */
function spanToIssue(span: BadClozeSpan): QualityIssue {
  return {
    check: `cloze-${span.kind}`,
    severity: "warn",
    message: `Bad cloze span at blank ${span.blankIndex + 1} ("${span.answer}"): ${KIND_MESSAGES[span.kind]}`,
  };
}

/**
 * Quality gate: flag bad cloze blanking on an authored cloze card.
 *
 * Conforms to {@link QualityGate}. Non-cloze items and cards with no blanks
 * pass cleanly (return no issues). Uses `backs` when present, else `back`.
 */
export const clozeQualityGate: QualityGate = (item): QualityIssue[] => {
  if (item.cardType !== "cloze") return [];
  const card = item as AuthoringCard;
  const answers = card.backs && card.backs.length > 0 ? card.backs : [card.back];
  return detectBadClozeSpans(card.front, answers).map(spanToIssue);
};
