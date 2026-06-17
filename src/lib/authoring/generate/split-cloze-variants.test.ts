/**
 * Tests for the split-cloze-variants kit module (DB-free reference port).
 *
 * Ported from md3 production `cards/split-cloze-variants.test.ts`, rebound to the
 * kit's contract: production carried variant linkage on DB columns and returned
 * `{ cards: GeneratedCard[] }`; the kit returns `{ variants: SplitVariant[], ... }`
 * where each variant is `{ card: AuthoringCard, variantGroupId, variantIndex }`
 * (linkage out-of-band) and each variant card gets a `<base>:blank-i` stableId.
 */

import { describe, it, expect } from "vitest";
import { splitClozeVariants } from "./split-cloze-variants";
import type { AuthoringCard } from "../contracts";

const baseCard: AuthoringCard = {
  cardType: "cloze",
  front: "First-line vasopressor in septic shock is [___].",
  back: "noradrenaline",
  topics: ["shock", "vasopressor"],
  complexity: 2,
  importance: 1,
};

describe("splitClozeVariants", () => {
  it("passes single-blank cards through unchanged with stableId set to baseStableId", () => {
    const result = splitClozeVariants(baseCard, "abc123");
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].card.stableId).toBe("abc123");
    expect(result.variants[0].variantGroupId).toBeNull();
    expect(result.variants[0].variantIndex).toBeNull();
    expect(result.variants[0].card.front).toBe(baseCard.front);
    expect(result.legacyAnchorStableIds).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("splits a 2-blank card into 2 variants, interpolating the other answer as prose", () => {
    const card: AuthoringCard = {
      ...baseCard,
      front: "First-line vasopressor in [___] is [___].",
      back: "septic shock",
      backs: ["septic shock", "noradrenaline"],
    };
    const result = splitClozeVariants(card, "abc123");

    expect(result.variants).toHaveLength(2);
    expect(result.legacyAnchorStableIds).toEqual(["abc123"]);
    expect(result.warnings).toHaveLength(0);

    expect(result.variants[0]).toMatchObject({
      variantGroupId: "abc123",
      variantIndex: 0,
    });
    expect(result.variants[0].card).toMatchObject({
      stableId: "abc123:blank-0",
      front: "First-line vasopressor in [___] is noradrenaline.",
      back: "septic shock",
    });
    // backs is removed from the per-variant card.
    expect(result.variants[0].card.backs).toBeUndefined();

    expect(result.variants[1].card).toMatchObject({
      stableId: "abc123:blank-1",
      front: "First-line vasopressor in septic shock is [___].",
      back: "noradrenaline",
    });
  });

  it("splits a 3-blank card into 3 variants, each with exactly one [___]", () => {
    const card: AuthoringCard = {
      ...baseCard,
      front: "Lethal triad: [___], [___], and [___].",
      back: "hypothermia",
      backs: ["hypothermia", "acidosis", "coagulopathy"],
    };
    const result = splitClozeVariants(card, "triad-1");

    expect(result.variants).toHaveLength(3);
    expect(result.legacyAnchorStableIds).toEqual(["triad-1"]);

    for (const v of result.variants) {
      expect(v.card.front.split("[___]").length - 1).toBe(1);
    }
    expect(result.variants[0].card.front).toBe("Lethal triad: [___], acidosis, and coagulopathy.");
    expect(result.variants[1].card.front).toBe("Lethal triad: hypothermia, [___], and coagulopathy.");
    expect(result.variants[2].card.front).toBe("Lethal triad: hypothermia, acidosis, and [___].");
  });

  it("handles $ characters in answers literally (no $-replacement-code surprises)", () => {
    const card: AuthoringCard = {
      ...baseCard,
      front: "Daily cost of [___] is approximately [___].",
      back: "apixaban",
      backs: ["apixaban", "$5/day"],
    };
    const result = splitClozeVariants(card, "cost-1");
    expect(result.variants).toHaveLength(2);
    expect(result.variants[0].card.front).toBe("Daily cost of [___] is approximately $5/day.");
    expect(result.variants[1].card.front).toBe("Daily cost of apixaban is approximately [___].");
  });

  it("soft-fails to pass-through with a warning when blankCount != backs.length", () => {
    const card: AuthoringCard = {
      ...baseCard,
      front: "Three things: [___], [___], and [___].",
      back: "a",
      backs: ["a", "b"], // 3 blanks, 2 backs
    };
    const result = splitClozeVariants(card, "mismatch-1");

    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].variantGroupId).toBeNull();
    expect(result.variants[0].variantIndex).toBeNull();
    expect(result.variants[0].card.stableId).toBe("mismatch-1");
    expect(result.legacyAnchorStableIds).toHaveLength(0);

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      kind: "blank-back-mismatch",
      baseStableId: "mismatch-1",
      blankCount: 3,
      backsLength: 2,
    });
  });
});
