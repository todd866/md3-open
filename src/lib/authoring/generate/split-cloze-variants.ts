/**
 * Split multi-blank cloze cards into single-blank variants.
 *
 * A card with N blanks and N positional answers (`backs`) is expanded into N
 * sibling cards, each testing exactly one blank with the other blanks filled in
 * from `backs`. This is the standard "one-by-one" cloze treatment: studying
 * each blank in isolation rather than guessing all N at once.
 *
 * This is the DB-free reference port. The production version carried variant
 * linkage on extra DB columns (variantGroupId / variantIndex / variantType).
 * The {@link AuthoringCard} contract has no such fields, so the linkage is
 * returned out-of-band in {@link SplitResult} (groupId + per-variant index) and
 * each emitted card gets a derived `stableId` (`<base>:blank-i`) for idempotent
 * upsert. Mismatched blank/back counts pass the card through with a warning.
 */

import type { AuthoringCard } from "@/lib/authoring/contracts";

const BLANK_TOKEN = "[___]";

export interface SplitWarning {
  kind: "blank-back-mismatch";
  baseStableId: string;
  blankCount: number;
  backsLength: number;
  front: string;
}

/** A single emitted variant plus its linkage metadata (out-of-band). */
export interface SplitVariant {
  card: AuthoringCard;
  /** Group key shared by all siblings (= base stableId). Null for pass-through. */
  variantGroupId: string | null;
  /** 0..N-1 index of which blank this variant tests. Null for pass-through. */
  variantIndex: number | null;
}

export interface SplitResult {
  variants: SplitVariant[];
  /** Base stableIds whose original (pre-split) anchor should be retired. */
  legacyAnchorStableIds: string[];
  warnings: SplitWarning[];
}

function countBlanks(front: string): number {
  return front.split(BLANK_TOKEN).length - 1;
}

function passThrough(card: AuthoringCard, baseStableId: string): SplitResult {
  return {
    variants: [{ card: { ...card, stableId: baseStableId }, variantGroupId: null, variantIndex: null }],
    legacyAnchorStableIds: [],
    warnings: [],
  };
}

/**
 * Split a cloze card into single-blank variants.
 *
 * @param card           the source cloze card (should be unsplit)
 * @param baseStableId   stable id for the group; variant ids derive from it
 */
export function splitClozeVariants(card: AuthoringCard, baseStableId: string): SplitResult {
  const blankCount = countBlanks(card.front);
  const backs = card.backs ?? [];

  // Pass-through: 0 or 1 blank, no multi-back signal.
  if (blankCount <= 1 && backs.length <= 1) {
    return passThrough(card, baseStableId);
  }

  // Mismatch: can't positionally split — pass through with a warning.
  if (blankCount !== backs.length) {
    return {
      variants: [{ card: { ...card, stableId: baseStableId }, variantGroupId: null, variantIndex: null }],
      legacyAnchorStableIds: [],
      warnings: [
        {
          kind: "blank-back-mismatch",
          baseStableId,
          blankCount,
          backsLength: backs.length,
          front: card.front,
        },
      ],
    };
  }

  // Positional split on the [___] token (no regex replacement-string magic).
  // For variant i, every blank j !== i is replaced with backs[j].
  const segments = card.front.split(BLANK_TOKEN); // length = blankCount + 1
  const variants: SplitVariant[] = [];

  for (let i = 0; i < blankCount; i++) {
    const front = segments
      .map((seg, j) => {
        if (j >= blankCount) return seg; // tail segment
        return seg + (j === i ? BLANK_TOKEN : backs[j]);
      })
      .join("");

    const variant: AuthoringCard = {
      ...card,
      stableId: `${baseStableId}:blank-${i}`,
      front,
      back: backs[i],
    };
    delete variant.backs;

    variants.push({ card: variant, variantGroupId: baseStableId, variantIndex: i });
  }

  return { variants, legacyAnchorStableIds: [baseStableId], warnings: [] };
}
