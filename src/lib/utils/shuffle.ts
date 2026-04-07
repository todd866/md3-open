/**
 * Shuffle utilities for option randomization.
 *
 * shuffleWithSeed() — deterministic Fisher-Yates using mulberry32 PRNG.
 * Same seed always produces the same order, preventing position bias.
 *
 * displaceFirst() — weighted placement that counters primacy bias.
 * Users click 'A' when unsure, so correct answers are placed later more often.
 */

import { hashString } from './hash';

/** Mulberry32 PRNG — fast, high-quality 32-bit generator */
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic seeded shuffle using mulberry32 PRNG.
 * Same seed always produces the same order.
 */
export function shuffleWithSeed<T>(array: T[], seed: string): T[] {
  const rng = mulberry32(hashString(seed));
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Weighted correct-answer placement to counter primacy bias.
 *
 * For 5 options the target distribution is roughly:
 *   A: 7%, B: 13%, C: 20%, D: 27%, E: 33%
 *
 * Only moves the item if it's at index 0 and matches the predicate.
 */
export function displaceFirst<T>(
  array: T[],
  predicate: (item: T) => boolean,
  seed: string,
): T[] {
  if (array.length < 2 || !predicate(array[0])) return array;
  const result = [...array];
  const n = result.length;

  // Linearly increasing weights: position i gets weight (i + 1)
  const weights: number[] = [];
  let totalWeight = 0;
  for (let i = 0; i < n; i++) {
    const w = i + 1;
    weights.push(w);
    totalWeight += w;
  }

  const rng = mulberry32(hashString(seed + ':displace'));
  const roll = rng() * totalWeight;
  let cumulative = 0;
  let targetIdx = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += weights[i];
    if (roll < cumulative) {
      targetIdx = i;
      break;
    }
  }

  if (targetIdx !== 0) {
    [result[0], result[targetIdx]] = [result[targetIdx], result[0]];
  }
  return result;
}
