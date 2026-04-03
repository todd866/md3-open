/**
 * Normalizes common MDX escape patterns in string literals.
 * - JSX expression escapes: {'<'} and {'>'} -> < and >
 * - Backslash escapes: \< and \> -> < and >
 */
export function normalizeAngleBracketEscapes(text: string): string {
  if (!text) return text;
  return text
    .replace(/\{\s*['"]\s*([<>])\s*['"]\s*\}/g, '$1')
    .replace(/\\([<>])/g, '$1');
}
