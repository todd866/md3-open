/**
 * MCQ quality gates.
 *
 * Ported from md3 production (`question-bank/validate.ts` + `quality/form-checks.ts`),
 * stripped of DB/Prisma/network: every check is a pure function over a single
 * `AuthoringQuestion` and returns `QualityIssue[]`. The DB-driven bank-level checks
 * (duplicate id scans, misconception-link counts, dead-distractor pick stats) are
 * dropped — they were queries, not pure logic.
 *
 * Each exported check is a `QualityGate<AuthoringQuestion>`. `runMcqGates` runs the
 * whole battery and folds the issues into a `QualityVerdict` (ok = no `block` issue).
 *
 * Note on labels: production stored answer-correctness on `option.isCorrect` and used
 * `context` for the post-answer teaching note; here the equivalent is the option's own
 * `explanation` and the question-level `explanation`. Letter-ref checks therefore scan
 * the question `explanation` plus per-option `explanation`s.
 */

import type {
  AuthoringQuestion,
  McqOption,
  QualityGate,
  QualityIssue,
  QualityVerdict,
} from '@/lib/authoring/contracts';

// ─── shared helpers ──────────────────────────────────────────────────────────

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeLabel(label: string): string {
  return label.trim().toUpperCase();
}

function correctOption(q: AuthoringQuestion): McqOption | undefined {
  return q.options.find((o) => o.isCorrect);
}

function distractors(q: AuthoringQuestion): McqOption[] {
  return q.options.filter((o) => !o.isCorrect);
}

/** Per-question post-answer notes to scan: question explanation + option explanations. */
function explanationTexts(q: AuthoringQuestion): string[] {
  const texts: string[] = [];
  if (isNonEmptyString(q.explanation)) texts.push(q.explanation);
  for (const o of q.options) {
    if (isNonEmptyString(o.explanation)) texts.push(o.explanation);
  }
  return texts;
}

function stripMarkdownTables(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('|'))
    .join('\n')
    .trim();
}

function splitStemParagraphs(stem: string): string[] {
  return stem
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
}

// Common abbreviations whose internal periods would otherwise be counted as
// sentence boundaries. Keep conservative — only abbreviations we actually see
// in medical exam stems. Decimals (1.5 mmol) are also protected.
const ABBREVIATIONS_WITH_PERIODS =
  /\b(Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs|etc|approx|cf|e\.g|i\.e|No|Fig|Inc|Co|Ltd|Ave|Blvd|Rd|Ph\.D|M\.D|R\.N|q\.d|b\.i\.d|t\.i\.d|q\.i\.d|p\.r\.n|q\.h\.s|p\.o)\./g;

function countSentences(text: string): number {
  const masked = text
    .replace(ABBREVIATIONS_WITH_PERIODS, (m) => m.replace(/\./g, ''))
    .replace(/(\d)\.(\d)/g, '$1$2');
  const normalized = masked.replace(/\s+/g, ' ').trim();
  if (!normalized) return 0;
  const matches = normalized.match(/[.!?](?=\s|$)/g);
  return matches ? matches.length : 1;
}

function containsMarkdownTable(stem: string): boolean {
  return /(^|\n)\|.+\|/m.test(stem);
}

function hasReferenceRangeColumn(stem: string): boolean {
  return stem
    .split('\n')
    .filter((line) => line.trim().startsWith('|'))
    .some((line) => /\b(normal|reference|range)\b/i.test(line));
}

// Lab labels that, when followed by a numeric value, count as a "lab with value"
// toward the lab-heavy detector.
const LAB_LABEL_PATTERNS: RegExp[] = [
  /\bpH(?=[\s:=|]+\d)/gi,
  /(?:PaCO₂|PaCO2|pCO₂|pCO2)(?=[\s:=|]+\d)/gi,
  /(?<![Ss])(?:PaO₂|PaO2|pO₂|pO2)(?=[\s:=|]+\d)/gi,
  /(?:HCO₃|HCO3)(?=[\s:=|]+\d)/gi,
  /\blactate(?=[\s:=|]+\d)/gi,
  /\banion gap(?=[\s:=|]+\d)/gi,
  /(?:\bNa[⁺+]?|sodium)(?=[\s:=|]+\d)/gi,
  /(?:\bK[⁺+]?|potassium)(?=[\s:=|]+\d)/gi,
  /(?:\bCl[⁻-]?|chloride)(?=[\s:=|]+\d)/gi,
  /\bglucose(?=[\s:=|]+\d)/gi,
  /\b(?:creatinine|Cr)(?=[\s:=|]+\d)/gi,
  /\bBUN(?=[\s:=|]+\d)/gi,
  /(?:FiO₂|FiO2)(?=[\s:=|]+\d)/gi,
];

function countLabsWithValues(stem: string): number {
  let count = 0;
  for (const pat of LAB_LABEL_PATTERNS) {
    const single = new RegExp(pat.source, pat.flags.replace('g', ''));
    if (single.test(stem)) count++;
  }
  return count;
}

function isLabHeavyStem(stem: string): boolean {
  const labWithValueCount = countLabsWithValues(stem);
  if (/\b(ABG|VBG|blood gas)\b/i.test(stem)) {
    return labWithValueCount >= 3;
  }
  return labWithValueCount >= 4;
}

function isQuestionParagraph(paragraph: string): boolean {
  const trimmed = stripMarkdownTables(paragraph);
  return trimmed.endsWith('?') || trimmed.endsWith(':');
}

// ─── structural validity ─────────────────────────────────────────────────────

/**
 * Structural well-formedness of an MCQ: a stem, at least 4 options, unique labels,
 * exactly one correct answer. Blocking — a malformed MCQ cannot be rendered.
 */
export const checkStructure: QualityGate<AuthoringQuestion> = (q) => {
  const issues: QualityIssue[] = [];

  if (!isNonEmptyString(q.stem)) {
    issues.push({ check: 'structure', severity: 'block', message: 'stem is required' });
  }

  if (!Array.isArray(q.options) || q.options.length < 4) {
    issues.push({
      check: 'structure',
      severity: 'block',
      message: 'options must be an array of at least 4 items',
    });
    return issues; // nothing more to check without options
  }

  if (q.options.length > 10) {
    issues.push({
      check: 'structure',
      severity: 'block',
      message: 'options must have at most 10 items',
    });
  }

  q.options.forEach((o, i) => {
    if (!isNonEmptyString(o.label)) {
      issues.push({ check: 'structure', severity: 'block', message: `options[${i}].label is required` });
    }
    if (!isNonEmptyString(o.text)) {
      issues.push({ check: 'structure', severity: 'block', message: `options[${i}].text is required` });
    }
    if (typeof o.isCorrect !== 'boolean') {
      issues.push({
        check: 'structure',
        severity: 'block',
        message: `options[${i}].isCorrect must be boolean`,
      });
    }
  });

  const labels = q.options.map((o) => normalizeLabel(o.label));
  if (new Set(labels).size !== labels.length) {
    issues.push({ check: 'structure', severity: 'block', message: 'options labels must be unique' });
  }

  const correctCount = q.options.filter((o) => o.isCorrect).length;
  if (correctCount !== 1) {
    issues.push({
      check: 'structure',
      severity: 'block',
      message: `options must have exactly 1 correct answer (got ${correctCount})`,
    });
  }

  return issues;
};

// ─── length bias ─────────────────────────────────────────────────────────────

/**
 * Length bias — the correct answer must not be distinguishable by length alone.
 * Flags when the correct answer is the longest OR shortest by more than
 * `thresholdPercent` AND at least `minAbsDiff` characters.
 */
export function checkLengthBias(
  q: AuthoringQuestion,
  thresholdPercent = 15,
  minAbsDiff = 6,
): QualityIssue[] {
  if (!Array.isArray(q.options) || q.options.length < 4) return [];

  const correct = correctOption(q);
  if (!correct) return [];

  const correctLen = correct.text.length;
  const otherLens = distractors(q).map((o) => o.text.length);
  if (otherLens.length === 0) return [];
  const maxOtherLen = Math.max(...otherLens);
  const minOtherLen = Math.min(...otherLens);

  if (correctLen > maxOtherLen) {
    const absDiff = correctLen - maxOtherLen;
    const pctDiff = maxOtherLen > 0 ? Math.round(((correctLen - maxOtherLen) / maxOtherLen) * 100) : 0;
    if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
      return [
        {
          check: 'length-bias',
          severity: 'warn',
          message: `correct answer is longest (${correctLen} chars vs ${maxOtherLen}, +${pctDiff}%)`,
        },
      ];
    }
  }

  if (correctLen < minOtherLen) {
    const absDiff = minOtherLen - correctLen;
    const pctDiff = correctLen > 0 ? Math.round(((minOtherLen - correctLen) / correctLen) * 100) : 0;
    if (pctDiff > thresholdPercent && absDiff >= minAbsDiff) {
      return [
        {
          check: 'length-bias',
          severity: 'warn',
          message: `correct answer is shortest (${correctLen} chars vs ${minOtherLen}, -${pctDiff}%)`,
        },
      ];
    }
  }

  return [];
}

// ─── format asymmetry ────────────────────────────────────────────────────────

/**
 * Format asymmetry — the correct answer has formatting (informational
 * parentheticals or symbols/arrows) that the distractors lack, or vice versa.
 * Standard abbreviation expansions like "(LMWH)" are ignored.
 */
export const checkFormatAsymmetry: QualityGate<AuthoringQuestion> = (q) => {
  if (!Array.isArray(q.options) || q.options.length < 4) return [];

  const correct = correctOption(q);
  if (!correct) return [];
  const others = distractors(q);

  const abbrOnly = /^\([A-Z]{2,6}\)$/;
  const infoParenPattern = /\([^)]+\)/g;
  const symbolPattern = /[↑↓→←±≥≤]/;

  const correctInfoParens = (correct.text.match(infoParenPattern) || []).filter((p) => !abbrOnly.test(p));
  if (correctInfoParens.length > 0) {
    const distractorsWithInfoParens = others.filter((d) =>
      (d.text.match(infoParenPattern) || []).some((p) => !abbrOnly.test(p)),
    );
    if (distractorsWithInfoParens.length === 0) {
      return [
        {
          check: 'format-asymmetry',
          severity: 'warn',
          message: 'correct answer has unique parenthetical formatting',
        },
      ];
    }
  }

  const correctHasSymbols = symbolPattern.test(correct.text);
  const distractorsWithSymbols = others.filter((d) => symbolPattern.test(d.text));
  if (correctHasSymbols && distractorsWithSymbols.length === 0) {
    return [
      { check: 'format-asymmetry', severity: 'warn', message: 'correct answer has unique symbol/arrow format' },
    ];
  }
  if (!correctHasSymbols && others.length > 0 && distractorsWithSymbols.length === others.length) {
    return [
      { check: 'format-asymmetry', severity: 'warn', message: 'all distractors use symbols but correct does not' },
    ];
  }

  return [];
};

// ─── form opacity (surface mechanical checks) ────────────────────────────────

const FILLER_PATTERNS = [
  /does not align with/i,
  /is not indicated for/i,
  /does not address the/i,
  /is not appropriate in this/i,
  /does not reflect current/i,
  /is not consistent with/i,
  /is not supported by/i,
];

const ABSOLUTE_TERMS = ['always', 'never', 'all', 'none', 'every', 'no patient'];

/**
 * Surface mechanical checks on the option block: length variance, correct answer
 * markedly longer than distractors, filler distractor text, and absolute terms in
 * the *correct* answer (the classic giveaway — students eliminate absolutes first).
 */
export const checkFormOpacity: QualityGate<AuthoringQuestion> = (q) => {
  const options = q.options ?? [];
  if (options.length === 0) return [];

  const issues: QualityIssue[] = [];

  const lengths = options.map((o) => o.text.length);
  const avgLength = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  if (avgLength > 0) {
    const maxDeviation = Math.max(...lengths.map((l) => Math.abs(l - avgLength) / avgLength));
    if (maxDeviation > 0.5) {
      const shortest = Math.min(...lengths);
      const longest = Math.max(...lengths);
      issues.push({
        check: 'form-opacity',
        severity: 'warn',
        message: `length variance: shortest ${shortest} chars, longest ${longest} chars (${Math.round(
          maxDeviation * 100,
        )}% deviation)`,
      });
    }
  }

  const correct = correctOption(q);
  const others = distractors(q);
  if (correct && others.length > 0) {
    const avgDistractorLen = others.reduce((a, o) => a + o.text.length, 0) / others.length;
    if (correct.text.length > avgDistractorLen * 1.5) {
      issues.push({
        check: 'form-opacity',
        severity: 'warn',
        message: `correct answer longer: correct is ${correct.text.length} chars, avg distractor is ${Math.round(
          avgDistractorLen,
        )} chars`,
      });
    }
  }

  for (const opt of options) {
    if (FILLER_PATTERNS.some((p) => p.test(opt.text))) {
      issues.push({
        check: 'form-opacity',
        severity: 'warn',
        message: `filler text: "${opt.text.substring(0, 50)}..."`,
      });
      break;
    }
  }

  if (correct) {
    const strippedCorrect = correct.text.replace(/\([A-Z]{2,}\)/g, '');
    const correctAbsolute = ABSOLUTE_TERMS.find((t) => new RegExp(`\\b${t}\\b`, 'i').test(strippedCorrect));
    if (correctAbsolute) {
      issues.push({
        check: 'form-opacity',
        severity: 'warn',
        message: `absolute term "${correctAbsolute}" in correct answer "${correct.text.substring(0, 40)}"`,
      });
    }
  }

  return issues;
};

// ─── explanation hygiene ─────────────────────────────────────────────────────

/**
 * Option letter references in explanations. Options are shuffled at render time,
 * so "Option B is wrong" becomes misleading after shuffle. Explanations must use
 * option text, not letters.
 */
export const checkOptionLetterRefs: QualityGate<AuthoringQuestion> = (q) => {
  const pattern = /Option [A-E]\b/g;
  const refs = new Set<string>();
  for (const text of explanationTexts(q)) {
    for (const m of text.match(pattern) ?? []) refs.add(m);
  }
  if (refs.size === 0) return [];
  return [
    {
      check: 'option-letter-ref',
      severity: 'warn',
      message: `explanation references shuffled option letters: ${[...refs].join(', ')}`,
    },
  ];
};

// ─── bare subscripts ─────────────────────────────────────────────────────────

const BARE_SUBSCRIPT_PATTERNS = [
  /\bNaHCO3\b/,
  /\bH2CO3\b/,
  /\bPaCO2\b/,
  /\bEtCO2\b/,
  /\bcmH2O\b/,
  /\bPaO2\b/,
  /\bFiO2\b/,
  /\bSpO2\b/,
  /\bSaO2\b/,
  /\bHCO3\b/,
  /\bCO2\b/,
  /\bH2O\b/,
  /\bN2O\b/,
  /\bNH4\+/,
  /\bSO4\b/,
  /\bCa2\+/,
  /\bMg2\+/,
  /\bFe2\+/,
  /\bFe3\+/,
  /\bK\+/,
  /\bNa\+/,
];

function hasBareSubscript(text: string): boolean {
  return BARE_SUBSCRIPT_PATTERNS.some((p) => p.test(text));
}

/**
 * Bare ASCII chemistry/physiology notation that should use Unicode subscripts,
 * e.g. "CO2" → "CO₂", "Ca2+" → "Ca²⁺". Informational only.
 */
export const checkBareSubscripts: QualityGate<AuthoringQuestion> = (q) => {
  const fields: string[] = [];
  if (isNonEmptyString(q.stem) && hasBareSubscript(q.stem)) fields.push('stem');
  if (isNonEmptyString(q.explanation) && hasBareSubscript(q.explanation)) fields.push('explanation');
  if (q.options?.some((o) => hasBareSubscript(o.text))) fields.push('options');
  if (fields.length === 0) return [];
  return [
    {
      check: 'bare-subscript',
      severity: 'info',
      message: `bare ASCII subscripts (use Unicode) in: ${fields.join(', ')}`,
    },
  ];
};

// ─── negative stem ───────────────────────────────────────────────────────────

/**
 * Negative stem patterns (NOT / EXCEPT / LEAST likely). These test elimination
 * rather than knowledge and are pedagogically weak.
 */
export const checkNegativeStemType: QualityGate<AuthoringQuestion> = (q) => {
  if (!isNonEmptyString(q.stem)) return [];
  const patterns: { regex: RegExp; label: string }[] = [
    { regex: /\bNOT\b/, label: 'NOT' },
    { regex: /\bEXCEPT\b/, label: 'EXCEPT' },
    { regex: /\bLEAST\s+likely\b/i, label: 'LEAST likely' },
  ];
  for (const { regex, label } of patterns) {
    if (regex.test(q.stem)) {
      return [
        { check: 'negative-stem', severity: 'warn', message: `negative stem ("${label}") tests elimination, not knowledge` },
      ];
    }
  }
  return [];
};

// ─── terminal lead-in ────────────────────────────────────────────────────────

/**
 * Stems should end with "?" or ":" so the lead-in is clear.
 */
export const checkMissingTerminalQuestion: QualityGate<AuthoringQuestion> = (q) => {
  if (!isNonEmptyString(q.stem)) return [];
  const trimmed = q.stem.trim();
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar !== '?' && lastChar !== ':') {
    return [
      {
        check: 'missing-terminal-question',
        severity: 'warn',
        message: `stem should end with "?" or ":" (ends with "${trimmed.slice(-20).trim()}")`,
      },
    ];
  }
  return [];
};

// ─── exam-style calibration ──────────────────────────────────────────────────

/**
 * Exam-style calibration: a standalone question paragraph after the setup, setup
 * length bounded, and lab-heavy stems presented as a referenced table.
 */
export const checkExamStyleCalibration: QualityGate<AuthoringQuestion> = (q) => {
  if (!isNonEmptyString(q.stem)) return [];
  const issues: QualityIssue[] = [];

  const stem = q.stem.trim();
  const paragraphs = splitStemParagraphs(stem);
  const questionParagraphIndex = paragraphs.findLastIndex((p) => isQuestionParagraph(p));

  if (questionParagraphIndex !== -1) {
    const questionParagraph = stripMarkdownTables(paragraphs[questionParagraphIndex]);
    const questionParagraphSentences = countSentences(questionParagraph);
    const setupText = paragraphs
      .slice(0, questionParagraphIndex)
      .map((p) => stripMarkdownTables(p))
      .join(' ');
    const setupSentenceCount = countSentences(setupText);

    if (questionParagraphSentences > 1) {
      issues.push({
        check: 'exam-style',
        severity: 'info',
        message: 'stem should end with a standalone question paragraph after the setup',
      });
    }

    // > 10 sentences of setup is the genuine wall-of-text outlier; real CC
    // vignettes routinely run 8-10 sentences.
    if (setupSentenceCount > 10) {
      issues.push({
        check: 'exam-style',
        severity: 'info',
        message: `setup has ${setupSentenceCount} sentences before the question lead-in`,
      });
    }
  }

  if (isLabHeavyStem(stem)) {
    const inlineRangeCount = (stem.match(/\(normal\s+[^)]+\)/gi) || []).length;
    if (inlineRangeCount < 3) {
      if (!containsMarkdownTable(stem)) {
        issues.push({
          check: 'exam-style',
          severity: 'info',
          message: 'lab-heavy stem should use a markdown table instead of inline values',
        });
      } else if (!hasReferenceRangeColumn(stem)) {
        issues.push({
          check: 'exam-style',
          severity: 'info',
          message: 'lab table should include a Normal/Reference range column',
        });
      }
    }
  }

  return issues;
};

// ─── truncation ──────────────────────────────────────────────────────────────

const LONG_WORD_ENDINGS =
  /\b(and|the|for|with|from|that|which|this|these|their|multiple|associated|including|anticipatory|comorbid|resulting|causing|involving|presenting|developing|especially)\s*$/i;
const SHORT_WORD_ENDINGS = /\s(a|an|or|of|in|to|by|as|at|on)\s*$/;

function looksIncomplete(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 40) return false;
  if (/[.?!;:)"']$/.test(trimmed)) return false;
  return LONG_WORD_ENDINGS.test(trimmed) || SHORT_WORD_ENDINGS.test(trimmed);
}

/**
 * Truncated text in the stem or options — text that ends mid-clause on a
 * preposition, article, or conjunction that clearly needs a following word.
 */
export const checkTruncatedText: QualityGate<AuthoringQuestion> = (q) => {
  const issues: QualityIssue[] = [];
  if (isNonEmptyString(q.stem) && looksIncomplete(q.stem)) {
    issues.push({
      check: 'truncated-text',
      severity: 'warn',
      message: `stem looks truncated: "...${q.stem.trim().slice(-40)}"`,
    });
  }
  q.options?.forEach((o, i) => {
    if (looksIncomplete(o.text)) {
      issues.push({
        check: 'truncated-text',
        severity: 'warn',
        message: `options[${i}] looks truncated: "${o.text}"`,
      });
    }
  });
  return issues;
};

// ─── runner ──────────────────────────────────────────────────────────────────

/** The full MCQ gate battery, in run order. */
export const MCQ_GATES: QualityGate<AuthoringQuestion>[] = [
  checkStructure,
  checkLengthBias,
  checkFormatAsymmetry,
  checkFormOpacity,
  checkOptionLetterRefs,
  checkBareSubscripts,
  checkNegativeStemType,
  checkMissingTerminalQuestion,
  checkExamStyleCalibration,
  checkTruncatedText,
];

/**
 * Run every MCQ gate over a question and fold the results into a verdict.
 * `ok` is false when any issue is severity `block`.
 */
export function runMcqGates(q: AuthoringQuestion): QualityVerdict {
  const issues = MCQ_GATES.flatMap((gate) => gate(q));
  const ok = !issues.some((issue) => issue.severity === 'block');
  return { ok, issues };
}
