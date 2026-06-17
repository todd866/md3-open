/**
 * Tests for option guessability (option-guessability.ts).
 *
 * Smoke + edge coverage for `analyzeGuessability` (the pure signal analyzer over
 * an option list), `validateAgainstCorrect`, `getGuessabilitySeverity`, and the
 * `checkGuessability` quality gate. Covers a clean balanced block (low score),
 * each major tell (length, qualifier, parenthetical, specificity), and the
 * `block` escalation when the tells correctly point at the real answer.
 */

import { describe, it, expect } from 'vitest';
import type { AuthoringQuestion, McqOption } from '../contracts';
import {
  analyzeGuessability,
  validateAgainstCorrect,
  getGuessabilitySeverity,
  checkGuessability,
} from './option-guessability';

function opt(label: string, text: string, isCorrect = false): McqOption {
  return { label, text, isCorrect };
}

function question(options: McqOption[]): AuthoringQuestion {
  return {
    cardType: 'mcq',
    stem: 'Which finding fits the diagnosis?',
    options,
    complexity: 2,
    importance: 2,
    topics: ['diagnosis'],
  };
}

// ─── getGuessabilitySeverity ──────────────────────────────────────────────────

describe('getGuessabilitySeverity', () => {
  it('maps score bands to severities', () => {
    expect(getGuessabilitySeverity(0.0)).toBe('none');
    expect(getGuessabilitySeverity(0.15)).toBe('low');
    expect(getGuessabilitySeverity(0.3)).toBe('medium');
    expect(getGuessabilitySeverity(0.5)).toBe('high');
    expect(getGuessabilitySeverity(0.8)).toBe('critical');
  });
});

// ─── analyzeGuessability ──────────────────────────────────────────────────────

describe('analyzeGuessability', () => {
  it('returns a zeroed profile for fewer than 2 options', () => {
    const profile = analyzeGuessability([opt('A', 'only option', true)]);
    expect(profile.score).toBe(0);
    expect(profile.issues).toEqual([]);
    expect(profile.likelyCorrectByTell).toBeNull();
  });

  it('gives a low score to a balanced, tell-free option block', () => {
    const profile = analyzeGuessability([
      opt('A', 'elevated serum potassium level', true),
      opt('B', 'elevated serum sodium level here'),
      opt('C', 'reduced serum calcium level now'),
      opt('D', 'reduced serum chloride level too'),
    ]);
    expect(profile.score).toBeLessThan(0.1);
    expect(getGuessabilitySeverity(profile.score)).toBe('none');
  });

  it('detects length asymmetry when one option is far longer', () => {
    const profile = analyzeGuessability([
      opt(
        'A',
        'metabolic acidosis with an elevated anion gap secondary to lactate accumulation in hypoperfused tissue beds',
        true,
      ),
      opt('B', 'alkalosis'),
      opt('C', 'acidosis'),
      opt('D', 'normal'),
    ]);
    expect(profile.signals.lengthAsymmetry).toBeGreaterThan(0);
    expect(profile.issues.some((s) => /longer|length variance/i.test(s))).toBe(true);
  });

  it('detects a qualifier asymmetry when only one option hedges', () => {
    const profile = analyzeGuessability([
      opt('A', 'usually resolves spontaneously over time', true),
      opt('B', 'requires immediate surgery'),
      opt('C', 'requires lifelong dialysis'),
      opt('D', 'requires permanent pacing'),
    ]);
    expect(profile.signals.qualifierAsymmetry).toBeGreaterThan(0);
    expect(profile.issues.some((s) => /hedg/i.test(s))).toBe(true);
  });

  it('detects a parenthetical tell when only one option has "(…)"', () => {
    const profile = analyzeGuessability([
      opt('A', 'macrolide (covers atypical intracellular pathogens)', true),
      opt('B', 'penicillin'),
      opt('C', 'cephalosporin'),
      opt('D', 'tetracycline'),
    ]);
    expect(profile.signals.parentheticalTell).toBeGreaterThan(0);
    expect(profile.issues.some((s) => /parenthetical/i.test(s))).toBe(true);
  });

  it('detects specificity asymmetry when one option carries all the numbers', () => {
    const profile = analyzeGuessability([
      opt('A', 'give 5 mg over 30 minutes for 2 weeks', true),
      opt('B', 'observe'),
      opt('C', 'reassure'),
      opt('D', 'discharge'),
    ]);
    expect(profile.signals.specificityAsymmetry).toBeGreaterThan(0);
  });
});

// ─── validateAgainstCorrect ───────────────────────────────────────────────────

describe('validateAgainstCorrect', () => {
  it('reports tellsMatchCorrect=false when no consensus tell exists', () => {
    const options = [
      opt('A', 'elevated serum potassium level', true),
      opt('B', 'elevated serum sodium level here'),
      opt('C', 'reduced serum calcium level now'),
      opt('D', 'reduced serum chloride level too'),
    ];
    const profile = analyzeGuessability(options);
    const result = validateAgainstCorrect(options, profile);
    expect(result.actualCorrectLabel).toBe('A');
    expect(result.tellsMatchCorrect).toBe(false);
  });

  it('reports tellsMatchCorrect=true when multiple tells converge on the real answer', () => {
    // The correct answer is simultaneously longest, hedged, parenthetical and
    // specific — multiple signals all point at option A, which is correct.
    const options = [
      opt(
        'A',
        'usually treated with approximately 5 mg IV over 30 minutes (titrated to effect) for most patients',
        true,
      ),
      opt('B', 'surgery'),
      opt('C', 'dialysis'),
      opt('D', 'observe'),
    ];
    const profile = analyzeGuessability(options);
    const result = validateAgainstCorrect(options, profile);
    expect(profile.likelyCorrectByTell).toBe('A');
    expect(result.tellsMatchCorrect).toBe(true);
  });
});

// ─── checkGuessability gate ───────────────────────────────────────────────────

describe('checkGuessability', () => {
  it('returns no issues for a clean, balanced MCQ', () => {
    const q = question([
      opt('A', 'elevated serum potassium level', true),
      opt('B', 'elevated serum sodium level here'),
      opt('C', 'reduced serum calcium level now'),
      opt('D', 'reduced serum chloride level too'),
    ]);
    expect(checkGuessability(q)).toEqual([]);
  });

  it('escalates to block when the tells correctly predict the real answer', () => {
    const q = question([
      opt(
        'A',
        'usually treated with approximately 5 mg IV over 30 minutes (titrated to effect) for most patients',
        true,
      ),
      opt('B', 'surgery'),
      opt('C', 'dialysis'),
      opt('D', 'observe'),
    ]);
    const issues = checkGuessability(q);
    const blocked = issues.find((i) => i.severity === 'block');
    expect(blocked).toBeDefined();
    expect(blocked?.check).toBe('guessable');
    expect(blocked?.message).toMatch(/point at the correct answer/);
  });

  it('warns/infos (not block) when tells exist but do not point at the correct answer', () => {
    // Strong tells converge on the LONG hedged/specific option, but the correct
    // answer is a short distractor-shaped option, so the item is not exploitable.
    const q = question([
      opt(
        'A',
        'usually treated with approximately 5 mg IV over 30 minutes (titrated to effect) for most patients',
      ),
      opt('B', 'surgery', true),
      opt('C', 'dialysis'),
      opt('D', 'observe'),
    ]);
    const issues = checkGuessability(q);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.every((i) => i.severity !== 'block')).toBe(true);
    expect(issues[0].check).toBe('guessable');
  });
});
