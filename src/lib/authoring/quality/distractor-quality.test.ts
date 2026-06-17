/**
 * Tests for distractor quality (distractor-quality.ts).
 *
 * Ports the composite-score cases from md3 production
 * (`audit/distractor-quality.test.ts`) for `computeDistractorQuality`, and adds
 * coverage for the role-taxonomy core: `analyzeDistractorRoles` classification
 * and the `checkDistractorRoles` quality gate (filler, all-or-none, absolute,
 * near-duplicate, and "no teaching role" flags).
 */

import { describe, it, expect } from 'vitest';
import type { AuthoringQuestion, McqOption } from '../contracts';
import {
  computeDistractorQuality,
  analyzeDistractorRoles,
  checkDistractorRoles,
} from './distractor-quality';

// ─── computeDistractorQuality (ported) ────────────────────────────────────────

describe('computeDistractorQuality', () => {
  it('returns a high score when all distractors carry misconceptions and none are dead', () => {
    const result = computeDistractorQuality({
      totalDistractors: 4,
      misconceptionCoverage: 4,
      deadDistractors: 0,
      llmPlausibility: 0.9,
    });
    expect(result).toBeGreaterThanOrEqual(0.9);
  });

  it('penalizes dead distractors', () => {
    const good = computeDistractorQuality({
      totalDistractors: 4,
      misconceptionCoverage: 4,
      deadDistractors: 0,
      llmPlausibility: 0.8,
    });
    const withDead = computeDistractorQuality({
      totalDistractors: 4,
      misconceptionCoverage: 4,
      deadDistractors: 2,
      llmPlausibility: 0.8,
    });
    expect(withDead).toBeLessThan(good);
  });

  it('penalizes low misconception coverage', () => {
    const full = computeDistractorQuality({
      totalDistractors: 4,
      misconceptionCoverage: 4,
      deadDistractors: 0,
      llmPlausibility: 0.8,
    });
    const low = computeDistractorQuality({
      totalDistractors: 4,
      misconceptionCoverage: 1,
      deadDistractors: 0,
      llmPlausibility: 0.8,
    });
    expect(low).toBeLessThan(full);
  });

  it('returns 0 when there are no distractors', () => {
    expect(
      computeDistractorQuality({
        totalDistractors: 0,
        misconceptionCoverage: 0,
        deadDistractors: 0,
        llmPlausibility: 0,
      }),
    ).toBe(0);
  });
});

// ─── role taxonomy helpers ────────────────────────────────────────────────────

function opt(label: string, text: string, isCorrect = false, explanation?: string): McqOption {
  return { label, text, isCorrect, ...(explanation ? { explanation } : {}) };
}

function question(options: McqOption[]): AuthoringQuestion {
  return {
    cardType: 'mcq',
    stem: 'Which agent is first line?',
    options,
    complexity: 2,
    importance: 2,
    topics: ['pharmacology'],
  };
}

describe('analyzeDistractorRoles', () => {
  it('classifies a hollow filler distractor', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'Amoxicillin does not align with current evidence'),
      opt('C', 'Ceftriaxone'),
      opt('D', 'Doxycycline'),
    ]);
    const roles = analyzeDistractorRoles(q);
    expect(roles.find((r) => r.label === 'B')?.role).toBe('filler');
  });

  it('classifies an all-or-none distractor', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'All of the above'),
      opt('C', 'Ceftriaxone'),
      opt('D', 'Doxycycline'),
    ]);
    const roles = analyzeDistractorRoles(q);
    expect(roles.find((r) => r.label === 'B')?.role).toBe('all-or-none');
  });

  it('classifies an absolute-term distractor', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'Amoxicillin is always the correct choice'),
      opt('C', 'Ceftriaxone'),
      opt('D', 'Doxycycline'),
    ]);
    const roles = analyzeDistractorRoles(q);
    expect(roles.find((r) => r.label === 'B')?.role).toBe('absolute');
  });

  it('classifies a high token-overlap distractor as near-miss', () => {
    const q = question([
      opt('A', 'increased serum potassium concentration', true),
      opt('B', 'increased serum sodium concentration'),
      opt('C', 'low glucose'),
      opt('D', 'high calcium'),
    ]);
    const roles = analyzeDistractorRoles(q);
    expect(roles.find((r) => r.label === 'B')?.role).toBe('near-miss');
  });

  it('only returns roles for distractors, not the correct option', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'Amoxicillin'),
      opt('C', 'Ceftriaxone'),
      opt('D', 'Doxycycline'),
    ]);
    expect(analyzeDistractorRoles(q)).toHaveLength(3);
    expect(analyzeDistractorRoles(q).every((r) => r.label !== 'A')).toBe(true);
  });
});

describe('checkDistractorRoles', () => {
  it('flags hollow filler distractors as a warn', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'This does not align with current guidelines'),
      opt('C', 'Ceftriaxone', false, 'A common confusion with gram-negative cover.'),
      opt('D', 'Doxycycline'),
    ]);
    const issues = checkDistractorRoles(q);
    const filler = issues.find((i) => /hollow filler/.test(i.message));
    expect(filler).toBeDefined();
    expect(filler?.severity).toBe('warn');
  });

  it('flags all-or-none distractors as a warn', () => {
    const q = question([
      opt('A', 'Azithromycin', true, 'macrolide'),
      opt('B', 'None of the above'),
      opt('C', 'Ceftriaxone', false, 'gram-negative cover confusion'),
      opt('D', 'Doxycycline'),
    ]);
    const issues = checkDistractorRoles(q);
    expect(issues.some((i) => i.severity === 'warn' && /all-or-none/.test(i.message))).toBe(true);
  });

  it('flags near-duplicate distractor pairs', () => {
    const q = question([
      opt('A', 'Azithromycin for atypical cover', true),
      opt('B', 'Amoxicillin for broad spectrum gram positive cover'),
      opt('C', 'Amoxicillin for broad spectrum gram positive cover today'),
      opt('D', 'Ceftriaxone for gram negatives'),
    ]);
    const issues = checkDistractorRoles(q);
    expect(issues.some((i) => /near-duplicate/.test(i.message))).toBe(true);
  });

  it('emits an info when no distractor targets a misconception or near-miss', () => {
    const q = question([
      opt('A', 'Azithromycin', true),
      opt('B', 'Aspirin'),
      opt('C', 'Insulin'),
      opt('D', 'Warfarin'),
    ]);
    const issues = checkDistractorRoles(q);
    const noTeaching = issues.find((i) => /no distractor targets/.test(i.message));
    expect(noTeaching).toBeDefined();
    expect(noTeaching?.severity).toBe('info');
  });

  it('passes a strong distractor block (misconception/near-miss roles, no flags)', () => {
    const q = question([
      opt('A', 'increased anion gap metabolic acidosis', true),
      opt('B', 'increased anion gap respiratory acidosis', false, 'confuses the primary disorder'),
      opt('C', 'normal anion gap metabolic acidosis', false, 'a real competing diagnosis'),
      opt('D', 'metabolic alkalosis', false, 'the opposite derangement'),
    ]);
    const issues = checkDistractorRoles(q);
    // No filler, no all-or-none, has teaching roles; at most benign info noise.
    expect(issues.some((i) => /hollow filler/.test(i.message))).toBe(false);
    expect(issues.some((i) => /all-or-none/.test(i.message))).toBe(false);
    expect(issues.some((i) => /no distractor targets/.test(i.message))).toBe(false);
  });
});
