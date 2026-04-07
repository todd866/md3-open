/**
 * Shared string hashing utilities.
 *
 * hashString() — djb2 variant, returns a non-negative number (for PRNG seeds, window skips)
 */

/** Hash a string to a non-negative 32-bit integer. djb2 variant (seed=0, multiply-by-31). */
export function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return Math.abs(hash);
}
