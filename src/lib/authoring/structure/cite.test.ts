/**
 * Tests for the structure/cite kit module (cite parsing + source registry).
 *
 * The parse cases are ported from md3 production `cite-utils.test.ts`. The kit
 * also exposes `isValidCite` and a corpus-injected registry (production bundled
 * its own JSON; the kit takes a `SourceDefinition[]`), so the registry cases use
 * a small in-test corpus and assert the resolution/bridge logic.
 */

import { describe, it, expect } from "vitest";
import {
  parseCiteReference,
  parseCiteReferenceList,
  isValidCite,
  buildSourceRegistry,
  resolveRegisteredSourceSlug,
  matchRegisteredSourceName,
  extractSourceLineNames,
  inferSingleSourceSlugFromSourceLines,
  resolveCiteToSourceRef,
  sourceDefinitionToRef,
  type SourceDefinition,
} from "./cite";

// ─── parseCiteReference ──────────────────────────────────────────────────────

describe("parseCiteReference", () => {
  it("returns null for empty string", () => {
    expect(parseCiteReference("")).toBeNull();
  });

  it("parses a simple source slug", () => {
    expect(parseCiteReference("cc-bible")).toEqual({ sourceSlug: "cc-bible" });
  });

  it("parses source-slug#section", () => {
    expect(parseCiteReference("cc-bible#shock-classification")).toEqual({
      sourceSlug: "cc-bible",
      section: "shock-classification",
    });
  });

  it("parses source-slug:doc-id:version#section (drops the doc/version, keeps slug + section)", () => {
    expect(parseCiteReference("arc:guideline-11.2:2024#adrenaline")).toEqual({
      sourceSlug: "arc",
      section: "adrenaline",
    });
  });

  it("parses source-slug:doc-id without a section", () => {
    expect(parseCiteReference("anzcor:als")).toEqual({ sourceSlug: "anzcor" });
  });

  it("parses a real-world doi cite ref", () => {
    expect(parseCiteReference("doi:10.1007/s00431-022-04458-z")).toEqual({
      sourceSlug: "doi",
    });
  });
});

// ─── parseCiteReferenceList ──────────────────────────────────────────────────

describe("parseCiteReferenceList", () => {
  it("returns an empty list for empty input", () => {
    expect(parseCiteReferenceList("")).toEqual([]);
  });

  it("parses semicolon-separated cite references and trims whitespace", () => {
    expect(parseCiteReferenceList(" anzcor#als ; arc:guideline-11.2:2024#adrenaline ")).toEqual([
      { sourceSlug: "anzcor", section: "als" },
      { sourceSlug: "arc", section: "adrenaline" },
    ]);
  });
});

// ─── isValidCite ─────────────────────────────────────────────────────────────

describe("isValidCite", () => {
  it("is true when at least one ref has a non-empty source slug", () => {
    expect(isValidCite("cc-bible#shock")).toBe(true);
    expect(isValidCite("a;b")).toBe(true);
  });

  it("is false for empty / slug-less input", () => {
    expect(isValidCite("")).toBe(false);
    expect(isValidCite("#section-only")).toBe(false);
  });
});

// ─── source registry ─────────────────────────────────────────────────────────

const CORPUS: SourceDefinition[] = [
  {
    slug: "anzcor",
    name: "Australian and New Zealand Committee on Resuscitation",
    shortName: "ANZCOR",
    sourceType: "guidelines",
    reliability: 5,
    aliases: ["anzcor-14-2", "anzcor-14-3"],
  },
  {
    slug: "dsm5",
    name: "Diagnostic and Statistical Manual of Mental Disorders, 5th Edition",
    shortName: "DSM-5",
    sourceType: "textbook",
    reliability: 4,
    publisher: "APA",
  },
];

const registry = buildSourceRegistry(CORPUS, { "dsm-5": "dsm5" });

describe("source registry resolution", () => {
  it("resolves canonical slugs and aliases", () => {
    expect(resolveRegisteredSourceSlug(registry, "anzcor")).toBe("anzcor");
    expect(resolveRegisteredSourceSlug(registry, "ANZCOR")).toBe("anzcor");
    expect(resolveRegisteredSourceSlug(registry, "anzcor-14-2")).toBe("anzcor");
    expect(resolveRegisteredSourceSlug(registry, "dsm-5")).toBe("dsm5"); // extraAlias
  });

  it("returns undefined for unknown sources", () => {
    expect(resolveRegisteredSourceSlug(registry, "definitely-not-a-source")).toBeUndefined();
  });

  it("matches a registered source by name", () => {
    expect(matchRegisteredSourceName(registry, "ANZCOR")?.slug).toBe("anzcor");
    expect(matchRegisteredSourceName(registry, "DSM-5")?.slug).toBe("dsm5");
    expect(matchRegisteredSourceName(registry, "no-such-source")).toBeNull();
  });
});

describe("source-line extraction + inference", () => {
  it("extracts source names from bold Sources: lines", () => {
    const content = [
      "<ClinicalPearl>",
      "**Source:** ANZCOR (Dr James Dent, RPA Emergency).",
      "</ClinicalPearl>",
    ].join("\n");
    expect(extractSourceLineNames(content)).toEqual(["ANZCOR"]);
  });

  it("infers a single source slug when the Sources: lines resolve unambiguously", () => {
    const content = "**Sources:** ANZCOR\n";
    expect(inferSingleSourceSlugFromSourceLines(registry, content)).toBe("anzcor");
  });
});

describe("bridge to contracts", () => {
  it("maps a guideline source definition to a SourceRef with the guideline tier", () => {
    expect(sourceDefinitionToRef(CORPUS[0])).toEqual({
      slug: "anzcor",
      title: "Australian and New Zealand Committee on Resuscitation",
      tier: "guideline",
      journal: undefined,
    });
  });

  it("resolves a cite string to a SourceRef via the registry, null when unregistered", () => {
    const ref = resolveCiteToSourceRef(registry, "anzcor#als");
    expect(ref?.slug).toBe("anzcor");
    expect(ref?.tier).toBe("guideline");
    expect(resolveCiteToSourceRef(registry, "nope#x")).toBeNull();
  });
});
