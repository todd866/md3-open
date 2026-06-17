/**
 * Tests for the MCQ quality gates (validate-mcq.ts).
 *
 * Exercises the individual `QualityGate<AuthoringQuestion>` checks plus the
 * `runMcqGates` battery/verdict folding. Builds `AuthoringQuestion` fixtures
 * from the contract types. Covers a clean MCQ that passes the gates and one
 * example of each major flaw (structure block, length bias, format asymmetry,
 * form opacity, option-letter refs, negative stem, missing terminal lead-in,
 * truncation).
 */

import { describe, it, expect } from 'vitest';
import type { AuthoringQuestion, McqOption } from '../contracts';
import {
  checkStructure,
  checkLengthBias,
  checkFormatAsymmetry,
  checkFormOpacity,
  checkOptionLetterRefs,
  checkNegativeStemType,
  checkMissingTerminalQuestion,
  checkTruncatedText,
  runMcqGates,
} from './validate-mcq';

// ─── fixtures ─────────────────────────────────────────────────────────────────

function opt(label: string, text: string, isCorrect = false, explanation?: string): McqOption {
  return { label, text, isCorrect, ...(explanation ? { explanation } : {}) };
}

/** A clean, well-formed MCQ: 4 options, balanced lengths, terminal "?". */
function cleanQuestion(overrides: Partial<AuthoringQuestion> = {}): AuthoringQuestion {
  return {
    cardType: 'mcq',
    stem: 'Which antibiotic provides intracellular coverage for atypical pathogens?',
    options: [
      opt('A', 'Azithromycin for intracellular coverage', true),
      opt('B', 'Amoxicillin for broad-spectrum coverage'),
      opt('C', 'Ceftriaxone for gram-negative organisms'),
      opt('D', 'Doxycycline for atypical pathogen cover'),
    ],
    explanation: 'Macrolides penetrate cells and cover atypicals.',
    complexity: 2,
    importance: 2,
    topics: ['pharmacology'],
    ...overrides,
  };
}

// ─── checkStructure ─────────────────────────────────────────────────────────

describe('checkStructure', () => {
  it('passes a well-formed MCQ with no issues', () => {
    expect(checkStructure(cleanQuestion())).toEqual([]);
  });

  it('blocks when fewer than 4 options', () => {
    const q = cleanQuestion({
      options: [opt('A', 'one', true), opt('B', 'two'), opt('C', 'three')],
    });
    const issues = checkStructure(q);
    expect(issues.some((i) => i.severity === 'block' && /at least 4/.test(i.message))).toBe(true);
  });

  it('blocks when not exactly one correct answer', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'first', true),
        opt('B', 'second', true),
        opt('C', 'third'),
        opt('D', 'fourth'),
      ],
    });
    const issues = checkStructure(q);
    expect(issues.some((i) => i.severity === 'block' && /exactly 1 correct/.test(i.message))).toBe(true);
  });

  it('blocks duplicate labels', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'first', true),
        opt('A', 'second'),
        opt('C', 'third'),
        opt('D', 'fourth'),
      ],
    });
    const issues = checkStructure(q);
    expect(issues.some((i) => /labels must be unique/.test(i.message))).toBe(true);
  });

  it('blocks an empty stem', () => {
    const q = cleanQuestion({ stem: '   ' });
    const issues = checkStructure(q);
    expect(issues.some((i) => /stem is required/.test(i.message))).toBe(true);
  });
});

// ─── checkLengthBias ──────────────────────────────────────────────────────────

describe('checkLengthBias', () => {
  it('passes when option lengths are balanced', () => {
    expect(checkLengthBias(cleanQuestion())).toEqual([]);
  });

  it('warns when the correct answer is much longer than all distractors', () => {
    const q = cleanQuestion({
      options: [
        opt(
          'A',
          'Azithromycin, because Bordetella is intracellular and needs macrolide penetration',
          true,
        ),
        opt('B', 'Amoxicillin'),
        opt('C', 'Ceftriaxone'),
        opt('D', 'Doxycycline'),
      ],
    });
    const issues = checkLengthBias(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('length-bias');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].message).toMatch(/longest/);
  });

  it('warns when the correct answer is much shorter than all distractors', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin', true),
        opt('B', 'Amoxicillin given for broad-spectrum gram-positive coverage'),
        opt('C', 'Ceftriaxone given for gram-negative enteric organisms here'),
        opt('D', 'Doxycycline given for atypical and intracellular cover'),
      ],
    });
    const issues = checkLengthBias(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toMatch(/shortest/);
  });
});

// ─── checkFormatAsymmetry ─────────────────────────────────────────────────────

describe('checkFormatAsymmetry', () => {
  it('passes when no option carries unique formatting', () => {
    expect(checkFormatAsymmetry(cleanQuestion())).toEqual([]);
  });

  it('warns when only the correct answer has an informational parenthetical', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin (covers atypical intracellular pathogens)', true),
        opt('B', 'Amoxicillin'),
        opt('C', 'Ceftriaxone'),
        opt('D', 'Doxycycline'),
      ],
    });
    const issues = checkFormatAsymmetry(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('format-asymmetry');
    expect(issues[0].message).toMatch(/parenthetical/);
  });

  it('ignores bare abbreviation expansions like "(LMWH)"', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Enoxaparin (LMWH)', true),
        opt('B', 'Warfarin'),
        opt('C', 'Aspirin'),
        opt('D', 'Heparin'),
      ],
    });
    expect(checkFormatAsymmetry(q)).toEqual([]);
  });

  it('warns when the correct answer uniquely uses a symbol/arrow', () => {
    const q = cleanQuestion({
      options: [
        opt('A', '↑ serum potassium', true),
        opt('B', 'high serum potassium'),
        opt('C', 'low serum sodium'),
        opt('D', 'normal serum calcium'),
      ],
    });
    const issues = checkFormatAsymmetry(q);
    expect(issues.some((i) => /symbol\/arrow/.test(i.message))).toBe(true);
  });
});

// ─── checkFormOpacity ─────────────────────────────────────────────────────────

describe('checkFormOpacity', () => {
  it('passes when options are similar length and free of tells', () => {
    expect(checkFormOpacity(cleanQuestion())).toEqual([]);
  });

  it('flags length variance when one option is dramatically longer', () => {
    const q = cleanQuestion({
      options: [
        opt(
          'A',
          'Azithromycin, because Bordetella pertussis is intracellular and requires macrolide penetration of the host cell',
          true,
        ),
        opt('B', 'Amoxicillin'),
        opt('C', 'Ceftriaxone'),
        opt('D', 'Doxycycline'),
      ],
    });
    const issues = checkFormOpacity(q);
    expect(issues.some((i) => i.check === 'form-opacity' && /length variance/.test(i.message))).toBe(true);
  });

  it('flags filler distractor text', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin for intracellular coverage', true),
        opt('B', 'This approach does not align with current evidence-based guidelines'),
        opt('C', 'Ceftriaxone for gram-negative organisms'),
        opt('D', 'Doxycycline for atypical pathogen cover'),
      ],
    });
    const issues = checkFormOpacity(q);
    expect(issues.some((i) => /filler text/.test(i.message))).toBe(true);
  });

  it('flags an absolute term in the correct answer', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Always give azithromycin first line', true),
        opt('B', 'Give amoxicillin in selected cases'),
        opt('C', 'Use ceftriaxone if gram-negatives suspected'),
        opt('D', 'Give doxycycline in selected situations'),
      ],
    });
    const issues = checkFormOpacity(q);
    expect(issues.some((i) => /absolute term/.test(i.message))).toBe(true);
  });

  it('does NOT flag absolute terms when only distractors use them', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Give azithromycin in most clinical scenarios here', true),
        opt('B', 'Never give amoxicillin to any patient ever today'),
        opt('C', 'Always use ceftriaxone as the first line therapy'),
        opt('D', 'Give doxycycline in selected situations as needed'),
      ],
    });
    const issues = checkFormOpacity(q);
    expect(issues.some((i) => /absolute term/.test(i.message))).toBe(false);
  });
});

// ─── checkOptionLetterRefs ────────────────────────────────────────────────────

describe('checkOptionLetterRefs', () => {
  it('passes when explanations do not reference shuffled letters', () => {
    expect(checkOptionLetterRefs(cleanQuestion())).toEqual([]);
  });

  it('warns when the explanation references "Option B"', () => {
    const q = cleanQuestion({ explanation: 'Option B is wrong because it lacks atypical cover.' });
    const issues = checkOptionLetterRefs(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('option-letter-ref');
    expect(issues[0].message).toMatch(/Option B/);
  });

  it('also scans per-option explanations', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin for intracellular coverage', true, 'Better than Option C in atypicals.'),
        opt('B', 'Amoxicillin for broad-spectrum coverage'),
        opt('C', 'Ceftriaxone for gram-negative organisms'),
        opt('D', 'Doxycycline for atypical pathogen cover'),
      ],
    });
    const issues = checkOptionLetterRefs(q);
    expect(issues.some((i) => /Option C/.test(i.message))).toBe(true);
  });
});

// ─── checkNegativeStemType ────────────────────────────────────────────────────

describe('checkNegativeStemType', () => {
  it('passes a positively-phrased stem', () => {
    expect(checkNegativeStemType(cleanQuestion())).toEqual([]);
  });

  it('warns on a NOT stem', () => {
    const q = cleanQuestion({ stem: 'Which of the following is NOT an indication for azithromycin?' });
    const issues = checkNegativeStemType(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('negative-stem');
    expect(issues[0].message).toMatch(/NOT/);
  });

  it('warns on an EXCEPT stem', () => {
    const q = cleanQuestion({ stem: 'All of these cover atypicals EXCEPT which agent?' });
    expect(checkNegativeStemType(q).some((i) => /EXCEPT/.test(i.message))).toBe(true);
  });
});

// ─── checkMissingTerminalQuestion ─────────────────────────────────────────────

describe('checkMissingTerminalQuestion', () => {
  it('passes a stem ending in "?"', () => {
    expect(checkMissingTerminalQuestion(cleanQuestion())).toEqual([]);
  });

  it('passes a stem ending in ":"', () => {
    const q = cleanQuestion({ stem: 'The best first-line agent for atypical pneumonia is:' });
    expect(checkMissingTerminalQuestion(q)).toEqual([]);
  });

  it('warns when the stem ends without "?" or ":"', () => {
    const q = cleanQuestion({ stem: 'The best first-line agent for atypical pneumonia' });
    const issues = checkMissingTerminalQuestion(q);
    expect(issues).toHaveLength(1);
    expect(issues[0].check).toBe('missing-terminal-question');
  });
});

// ─── checkTruncatedText ───────────────────────────────────────────────────────

describe('checkTruncatedText', () => {
  it('passes complete stems and options', () => {
    expect(checkTruncatedText(cleanQuestion())).toEqual([]);
  });

  it('warns when an option ends mid-clause on a conjunction', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin for intracellular coverage', true),
        opt('B', 'Amoxicillin which covers broad-spectrum gram positives and'),
        opt('C', 'Ceftriaxone for gram-negative organisms'),
        opt('D', 'Doxycycline for atypical pathogen cover'),
      ],
    });
    const issues = checkTruncatedText(q);
    expect(issues.some((i) => i.check === 'truncated-text' && /options\[1\]/.test(i.message))).toBe(true);
  });
});

// ─── runMcqGates (battery + verdict) ──────────────────────────────────────────

describe('runMcqGates', () => {
  it('returns ok=true with no issues on a clean MCQ', () => {
    const verdict = runMcqGates(cleanQuestion());
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
  });

  it('returns ok=false when a structural block issue fires', () => {
    const q = cleanQuestion({
      options: [opt('A', 'only', true), opt('B', 'two'), opt('C', 'three')],
    });
    const verdict = runMcqGates(q);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((i) => i.severity === 'block')).toBe(true);
  });

  it('returns ok=true but surfaces warn issues for a length-biased item', () => {
    const q = cleanQuestion({
      options: [
        opt('A', 'Azithromycin, because Bordetella is intracellular and needs macrolide penetration', true),
        opt('B', 'Amoxicillin'),
        opt('C', 'Ceftriaxone'),
        opt('D', 'Doxycycline'),
      ],
    });
    const verdict = runMcqGates(q);
    expect(verdict.ok).toBe(true); // only warns, no block
    expect(verdict.issues.some((i) => i.check === 'length-bias')).toBe(true);
  });
});
