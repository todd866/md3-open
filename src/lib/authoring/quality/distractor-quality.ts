/**
 * Distractor quality — composite score plus a role-taxonomy analysis.
 *
 * Ported from md3 production (`audit/distractor-quality.ts`). The composite score
 * is pure already; the role-taxonomy analysis is the DB-free core of the audit:
 * it classifies each distractor by the *kind* of error it tests for, and flags
 * distractor blocks that are weak (filler / near-duplicate / all-or-nothing
 * options that test-takers eliminate on sight).
 *
 * No DB: the production audit also folded in misconception-link coverage and
 * dead-distractor pick counts (both Prisma queries). Those become *inputs* to
 * `computeDistractorQuality` — the caller supplies them — rather than queries here.
 */

import type { AuthoringQuestion, McqOption, QualityGate, QualityIssue } from '@/lib/authoring/contracts';

export interface DistractorQualityInput {
  totalDistractors: number;
  /** How many distractors carry a misconception/explanation link. */
  misconceptionCoverage: number;
  /** Distractors never selected (0 picks with enough data). */
  deadDistractors: number;
  /** 0–1 plausibility estimate from an external scorer. */
  llmPlausibility: number;
}

/**
 * Composite distractor quality score (0–1). Three signals, equally weighted:
 * coverage (fraction with a misconception link), health (fraction not dead),
 * and plausibility (external estimate).
 */
export function computeDistractorQuality(input: DistractorQualityInput): number {
  if (input.totalDistractors === 0) return 0;
  const coverage = input.misconceptionCoverage / input.totalDistractors;
  const health = 1 - input.deadDistractors / input.totalDistractors;
  const plausibility = input.llmPlausibility;
  return (coverage + health + plausibility) / 3;
}

// ─── role taxonomy ───────────────────────────────────────────────────────────

/**
 * The role a distractor plays. A good distractor block draws on *several* roles;
 * a block where every distractor is "filler" or "implausible" is weak.
 */
export type DistractorRole =
  | 'misconception' // a believable wrong belief a learner actually holds
  | 'near-miss' // close to correct but distinguishable on one detail
  | 'opposite' // the inverse of the correct answer
  | 'filler' // hollow "does not align with…" negation, no teaching value
  | 'absolute' // hedged into wrongness by always/never/all/none
  | 'all-or-none' // "all/none of the above" style
  | 'unclassified';

export interface DistractorRoleInfo {
  label: string;
  role: DistractorRole;
}

const FILLER_PATTERNS = [
  /does not align with/i,
  /is not indicated for/i,
  /does not address the/i,
  /is not appropriate in this/i,
  /does not reflect current/i,
  /is not consistent with/i,
  /is not supported by/i,
];

const ABSOLUTE_PATTERN = /\b(always|never|all|none|every|exclusively|invariably|absolutely)\b/i;
const ALL_OR_NONE_PATTERN = /\b(?:all|none)\s+of\s+(?:the\s+)?(?:above|listed|options)\b/i;
const NEGATION_OPPOSITE_PATTERN = /\b(?:no|not|absence of|without|lack of|decreased|reduced)\b/i;

/** Token-overlap similarity (Jaccard over lowercased word sets). */
function tokenOverlap(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / new Set([...wa, ...wb]).size;
}

function classifyDistractor(distractor: McqOption, correct: McqOption | undefined): DistractorRole {
  const text = distractor.text;
  if (ALL_OR_NONE_PATTERN.test(text)) return 'all-or-none';
  if (FILLER_PATTERNS.some((p) => p.test(text))) return 'filler';
  if (ABSOLUTE_PATTERN.test(text)) return 'absolute';

  if (correct) {
    const overlap = tokenOverlap(text, correct.text);
    if (overlap >= 0.6) return 'near-miss';
    // An explicit negation of an otherwise-overlapping correct answer reads as
    // the opposite (e.g. "decreased X" vs "increased X").
    if (overlap >= 0.3 && NEGATION_OPPOSITE_PATTERN.test(text) && !NEGATION_OPPOSITE_PATTERN.test(correct.text)) {
      return 'opposite';
    }
  }

  // A distractor that carries its own misconception/explanation is doing the
  // teaching job we want; treat it as a misconception-role distractor.
  if (distractor.explanation && distractor.explanation.trim().length > 0) return 'misconception';

  return 'unclassified';
}

/**
 * Classify every distractor in a question by role. Pure, render-order independent.
 */
export function analyzeDistractorRoles(q: AuthoringQuestion): DistractorRoleInfo[] {
  const correct = q.options.find((o) => o.isCorrect);
  return q.options
    .filter((o) => !o.isCorrect)
    .map((d) => ({ label: d.label, role: classifyDistractor(d, correct) }));
}

/**
 * Quality gate over the distractor block. Flags hollow filler, absolute-term
 * distractors a test-taker eliminates on sight, near-duplicate distractor pairs,
 * and blocks with no genuine misconception/near-miss role at all.
 */
export const checkDistractorRoles: QualityGate<AuthoringQuestion> = (q) => {
  const issues: QualityIssue[] = [];
  const roles = analyzeDistractorRoles(q);
  if (roles.length === 0) return issues;

  const filler = roles.filter((r) => r.role === 'filler');
  if (filler.length > 0) {
    issues.push({
      check: 'distractor-role',
      severity: 'warn',
      message: `hollow filler distractor(s): ${filler.map((r) => r.label).join(', ')}`,
    });
  }

  const absolute = roles.filter((r) => r.role === 'absolute');
  if (absolute.length > 0) {
    issues.push({
      check: 'distractor-role',
      severity: 'info',
      message: `distractor(s) using absolute terms (easily eliminated): ${absolute
        .map((r) => r.label)
        .join(', ')}`,
    });
  }

  const allOrNone = roles.filter((r) => r.role === 'all-or-none');
  if (allOrNone.length > 0) {
    issues.push({
      check: 'distractor-role',
      severity: 'warn',
      message: `all-or-none distractor(s) weaken discrimination: ${allOrNone.map((r) => r.label).join(', ')}`,
    });
  }

  // No distractor exercises a real misconception or near-miss — the block is
  // just chaff and the item tests recognition, not discrimination.
  const hasTeachingRole = roles.some((r) => r.role === 'misconception' || r.role === 'near-miss');
  if (!hasTeachingRole) {
    issues.push({
      check: 'distractor-role',
      severity: 'info',
      message: 'no distractor targets a plausible misconception or near-miss',
    });
  }

  // Near-duplicate distractor pairs collapse the effective option count.
  const distractors = q.options.filter((o) => !o.isCorrect);
  for (let i = 0; i < distractors.length; i++) {
    for (let j = i + 1; j < distractors.length; j++) {
      if (tokenOverlap(distractors[i].text, distractors[j].text) >= 0.8) {
        issues.push({
          check: 'distractor-role',
          severity: 'warn',
          message: `near-duplicate distractors ${distractors[i].label} and ${distractors[j].label}`,
        });
      }
    }
  }

  return issues;
};
