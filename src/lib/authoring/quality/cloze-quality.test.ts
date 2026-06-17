/**
 * Tests for cloze quality (cloze-quality.ts).
 *
 * Ports the relevant cases from md3 production (`cloze-quality.test.ts`) and
 * rebinds them to the kit's exports. `detectBadClozeSpans` has the same
 * signature in the kit, so those cases port verbatim. Adds tests for the
 * `clozeQualityGate` wrapper (QualityGate over an AuthoringCard) — including
 * non-cloze passthrough and `backs` multi-blank handling.
 */

import { describe, it, expect } from 'vitest';
import type { AuthoringCard, AuthoringQuestion } from '../contracts';
import { detectBadClozeSpans, clozeQualityGate } from './cloze-quality';

describe('detectBadClozeSpans', () => {
  it('flags one side of a numeric range as a partial-range span', () => {
    expect(detectBadClozeSpans('PSGN occurs [___]-4 weeks after GAS infection.', ['2'])).toEqual([
      { kind: 'partial-range', blankIndex: 0, answer: '2' },
    ]);

    expect(detectBadClozeSpans('Amblyopia treatment is best before age 7-[___].', ['8'])).toEqual([
      { kind: 'partial-range', blankIndex: 0, answer: '8' },
    ]);
  });

  it('flags a short answer leaked elsewhere in the front', () => {
    expect(
      detectBadClozeSpans('Carrier screening includes fragile [___] (X-linked).', ['X']),
    ).toEqual([{ kind: 'short-answer-leak', blankIndex: 0, answer: 'X' }]);
  });

  it('flags a single-letter term fragment even when not repeated', () => {
    expect(detectBadClozeSpans('Carrier screening includes fragile [___].', ['X'])).toEqual([
      { kind: 'term-fragment', blankIndex: 0, answer: 'X' },
    ]);
  });

  it('allows single-letter classification labels when the label is the target', () => {
    expect(
      detectBadClozeSpans('Metformin-associated lactic acidosis is Type [___].', ['B']),
    ).toEqual([]);
  });

  it('allows meaningful short clinical tokens (C3)', () => {
    expect(
      detectBadClozeSpans('In PSGN, complement pattern is low [___] with normal C4.', ['C3']),
    ).toEqual([]);
  });

  it('flags single-letter answer that appears inside an UPPERCASE acronym in front', () => {
    expect(
      detectBadClozeSpans('A patient is GCS-unresponsive. AVPU score is [___].', ['P']),
    ).toEqual([{ kind: 'short-answer-leak', blankIndex: 0, answer: 'P' }]);
  });

  it('flags binary-classifier leak when the other half is given in the front', () => {
    expect(
      detectBadClozeSpans(
        'Lactic acidosis: type [___] = tissue hypoperfusion (shock, hypoxia); type B = no hypoperfusion.',
        ['A'],
      ),
    ).toEqual([{ kind: 'short-answer-leak', blankIndex: 0, answer: 'A' }]);
  });

  it('does NOT flag gestation notation `N+0 and N+6 weeks` as a range tell', () => {
    expect(
      detectBadClozeSpans('Preterm birth occurs between [___]+0 and [___]+6 weeks.', ['20', '36']),
    ).toEqual([]);
  });

  it('does NOT flag numeric IDs like DSM-5 (false-positive guard)', () => {
    expect(
      detectBadClozeSpans(
        'DSM-5 borderline personality disorder requires at least [___] of 9 criteria.',
        ['5'],
      ),
    ).toEqual([]);
  });

  it('flags a decode-leak where blank + following words expand to an adjacent acronym', () => {
    expect(
      detectBadClozeSpans('First-line rehydration is [___] rehydration solution (ORS).', ['oral']),
    ).toEqual([{ kind: 'decode-leak', blankIndex: 0, answer: 'oral' }]);
  });

  it('flags a decode-leak where preceding words + blank expand to an adjacent acronym', () => {
    expect(
      detectBadClozeSpans(
        'An overweight adolescent has a slipped capital femoral [___] (SCFE).',
        ['epiphysis'],
      ),
    ).toEqual([{ kind: 'decode-leak', blankIndex: 0, answer: 'epiphysis' }]);
  });

  it('does NOT flag an adjacent acronym unrelated to the answer (route, e.g. IV)', () => {
    expect(detectBadClozeSpans('In anaphylaxis give [___] (IV).', ['adrenaline'])).toEqual([]);
  });

  it('returns nothing when there are no blanks', () => {
    expect(detectBadClozeSpans('No blanks at all here.', ['x'])).toEqual([]);
  });

  it('returns nothing when answers are empty', () => {
    expect(detectBadClozeSpans('A blank [___] here.', [])).toEqual([]);
  });
});

describe('clozeQualityGate', () => {
  function clozeCard(front: string, back: string, backs?: string[]): AuthoringCard {
    return {
      cardType: 'cloze',
      front,
      back,
      ...(backs ? { backs } : {}),
      complexity: 2,
      importance: 2,
      topics: ['test'],
    };
  }

  it('passes a clean cloze card (whole-term blank) with no issues', () => {
    const card = clozeCard('First-line antibiotic for atypical pneumonia is [___].', 'azithromycin');
    expect(clozeQualityGate(card)).toEqual([]);
  });

  it('emits a warn QualityIssue for a bad partial-range cloze', () => {
    const card = clozeCard('PSGN occurs [___]-4 weeks after GAS infection.', '2');
    const issues = clozeQualityGate(card);
    expect(issues).toHaveLength(1);
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].check).toBe('cloze-partial-range');
    expect(issues[0].message).toMatch(/blank 1/);
  });

  it('uses `backs` for multi-blank cards when present', () => {
    // First blank leaks a single letter inside the acronym; second is clean.
    const card = clozeCard(
      'AVPU score is [___] and the GCS is [___].',
      'P',
      ['P', '15'],
    );
    const issues = clozeQualityGate(card);
    expect(issues.length).toBeGreaterThanOrEqual(1);
    expect(issues.some((i) => i.check === 'cloze-short-answer-leak')).toBe(true);
  });

  it('returns no issues for a non-cloze item (MCQ passthrough)', () => {
    const mcq: AuthoringQuestion = {
      cardType: 'mcq',
      stem: 'Which agent?',
      options: [
        { label: 'A', text: 'one', isCorrect: true },
        { label: 'B', text: 'two', isCorrect: false },
        { label: 'C', text: 'three', isCorrect: false },
        { label: 'D', text: 'four', isCorrect: false },
      ],
      complexity: 2,
      importance: 2,
      topics: ['x'],
    };
    // clozeQualityGate is typed as QualityGate (AuthoredItem); MCQ should pass through.
    expect(clozeQualityGate(mcq)).toEqual([]);
  });
});
