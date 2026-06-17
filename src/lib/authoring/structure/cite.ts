/**
 * Citation parsing + source registry (pure, data-free).
 *
 * Merges md3's `cite-utils.ts` (parse/validate cite reference strings) and
 * `source-registry.ts` (slug → source metadata; infer source from context).
 *
 * The production registry imported a bundled `source-registry-data.json`. That
 * data is institution-specific and is NOT shipped here — instead every registry
 * function takes a `SourceDefinition[]` argument so callers supply their own
 * corpus. The matching/normalisation LOGIC is preserved intact.
 *
 * A cite ref ultimately resolves to a {@link SourceRef} from the authoring
 * contracts; {@link sourceDefinitionToRef} bridges the two shapes.
 */

import type { EvidenceTier, SourceRef } from "@/lib/authoring/contracts";

// ─── Cite reference parsing ──────────────────────────────────────────────────

export interface ParsedCite {
  sourceSlug: string;
  section?: string;
}

/**
 * Parse a cite reference string into its components.
 *
 * Formats supported:
 * - "source-slug" → { sourceSlug: "source-slug" }
 * - "source-slug#section" → { sourceSlug: "source-slug", section: "section" }
 * - "source-slug:doc-id:version#section" → { sourceSlug: "source-slug", section: "section" }
 */
export function parseCiteReference(cite: string): ParsedCite | null {
  if (!cite) return null;

  const hashIndex = cite.indexOf("#");
  let sourceSlug: string;
  let section: string | undefined;

  if (hashIndex !== -1) {
    const beforeHash = cite.substring(0, hashIndex);
    section = cite.substring(hashIndex + 1);
    // Extract source slug (first part before any colons)
    sourceSlug = beforeHash.split(":")[0];
  } else {
    // No section, just source slug (potentially with doc-id:version)
    sourceSlug = cite.split(":")[0];
  }

  return { sourceSlug, section };
}

/** Parse one or more cite references separated by semicolons. */
export function parseCiteReferenceList(cite: string): ParsedCite[] {
  if (!cite) return [];

  return cite
    .split(";")
    .map((part) => parseCiteReference(part.trim()))
    .filter((parsed): parsed is ParsedCite => parsed !== null);
}

/** True if a cite string parses into at least one resolvable reference. */
export function isValidCite(cite: string): boolean {
  return parseCiteReferenceList(cite).some((ref) => ref.sourceSlug.length > 0);
}

// ─── Source registry ─────────────────────────────────────────────────────────

export interface SourceDefinition {
  slug: string;
  name: string;
  shortName: string;
  sourceType: "guidelines" | "textbook" | "lecture" | "uptodate" | "peer-reviewed";
  reliability: 1 | 2 | 3 | 4 | 5;
  jurisdiction?: "nsw" | "wa" | "national" | "international" | null;
  publisher?: string;
  url?: string;
  aliases?: string[];
}

function normalizeSourceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "")
    .trim();
}

function getSourceSearchTerms(source: SourceDefinition): string[] {
  return [source.slug, source.name, source.shortName, ...(source.aliases ?? [])]
    .map((term) => normalizeSourceName(term))
    .filter((term) => term.length > 0);
}

/**
 * An indexed view of a source corpus. Build once with {@link buildSourceRegistry}
 * and reuse — the lookups below all take it as their first argument.
 */
export interface SourceRegistry {
  sources: SourceDefinition[];
  bySlug: Map<string, SourceDefinition>;
  slugByTerm: Map<string, string>;
}

/**
 * Index a list of source definitions for fast resolution. `extraAliases` lets
 * callers wire in known shorthand → slug mappings (the production registry
 * hard-coded a handful, e.g. "dsm-5" → "dsm5").
 */
export function buildSourceRegistry(
  sources: SourceDefinition[],
  extraAliases: Record<string, string> = {},
): SourceRegistry {
  const bySlug = new Map(sources.map((source) => [source.slug, source]));
  const slugByTerm = new Map<string, string>();

  for (const source of sources) {
    for (const term of getSourceSearchTerms(source)) {
      if (!slugByTerm.has(term)) {
        slugByTerm.set(term, source.slug);
      }
    }
  }

  for (const [term, slug] of Object.entries(extraAliases)) {
    slugByTerm.set(normalizeSourceName(term), slug);
  }

  return { sources, bySlug, slugByTerm };
}

export function resolveRegisteredSourceSlug(
  registry: SourceRegistry,
  sourceRef: string,
): string | undefined {
  const normalized = normalizeSourceName(sourceRef);
  if (!normalized) return undefined;
  return registry.slugByTerm.get(normalized);
}

export function getRegisteredSourceBySlug(
  registry: SourceRegistry,
  slug: string,
): SourceDefinition | undefined {
  return registry.bySlug.get(slug);
}

export function findRegisteredSourcesInText(
  registry: SourceRegistry,
  sourceText: string,
): SourceDefinition[] {
  const normalized = normalizeSourceName(sourceText);
  const matches = new Map<string, SourceDefinition>();

  const exactSlug = resolveRegisteredSourceSlug(registry, sourceText);
  if (exactSlug) {
    const exactSource = getRegisteredSourceBySlug(registry, exactSlug);
    if (exactSource) {
      matches.set(exactSource.slug, exactSource);
    }
  }

  for (const source of registry.sources) {
    const exactMatch = getSourceSearchTerms(source).some((term) => term === normalized);
    if (exactMatch) {
      matches.set(source.slug, source);
    }
  }

  for (const source of registry.sources) {
    const containsMatch = getSourceSearchTerms(source).some(
      (term) => term.length > 2 && normalized.includes(term),
    );
    if (containsMatch) {
      matches.set(source.slug, source);
    }
  }

  return [...matches.values()];
}

export function matchRegisteredSourceName(
  registry: SourceRegistry,
  sourceName: string,
): SourceDefinition | null {
  const exactSlug = resolveRegisteredSourceSlug(registry, sourceName);
  if (exactSlug) {
    return getRegisteredSourceBySlug(registry, exactSlug) ?? null;
  }
  return findRegisteredSourcesInText(registry, sourceName)[0] ?? null;
}

/** Extract the source text from a `Sources: ...` markdown line, if present. */
export function extractSourceTextFromLine(line: string): string | null {
  const match = line.match(/^\s*(?:\*\*)?Sources?:(?:\*\*)?\s*(.+)$/i);
  return match ? match[1].trim() : null;
}

/** Collect all source names appearing on `Sources:` lines in a markdown body. */
export function extractSourceLineNames(content: string): string[] {
  const names: string[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    const sourceText = extractSourceTextFromLine(line);
    if (!sourceText) continue;

    names.push(
      ...sourceText
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .map((part) =>
          part
            .replace(/\.$/, "")
            .replace(/\s*\([^)]*\)\s*$/, "")
            .trim(),
        ),
    );
  }

  return names;
}

/**
 * Infer a single source slug from a markdown body, but only when the
 * `Sources:` lines resolve unambiguously to exactly one registered source.
 */
export function inferSingleSourceSlugFromSourceLines(
  registry: SourceRegistry,
  content: string,
): string | undefined {
  const matchedSlugs = new Set<string>();

  for (const sourceName of extractSourceLineNames(content)) {
    for (const source of findRegisteredSourcesInText(registry, sourceName)) {
      matchedSlugs.add(source.slug);
    }
  }

  return matchedSlugs.size === 1 ? [...matchedSlugs][0] : undefined;
}

// ─── Bridge to contracts ─────────────────────────────────────────────────────

/** Map a registry source type to the contract's coarse evidence tier. */
function tierForSourceType(sourceType: SourceDefinition["sourceType"]): EvidenceTier {
  switch (sourceType) {
    case "guidelines":
      return "guideline";
    case "peer-reviewed":
      return "review";
    default:
      // textbook, lecture, uptodate → no specific study-design tier
      return "other";
  }
}

/** Convert a registry definition into a contract {@link SourceRef}. */
export function sourceDefinitionToRef(source: SourceDefinition): SourceRef {
  return {
    slug: source.slug,
    title: source.name,
    tier: tierForSourceType(source.sourceType),
    journal: source.publisher,
  };
}

/**
 * Resolve a cite string to a {@link SourceRef} via the registry. Returns null
 * when the slug is not registered. The cite's `#section`, if any, is dropped
 * (SourceRef has no section field) — use {@link parseCiteReference} to retain it.
 */
export function resolveCiteToSourceRef(
  registry: SourceRegistry,
  cite: string,
): SourceRef | null {
  const parsed = parseCiteReference(cite);
  if (!parsed) return null;
  const source =
    getRegisteredSourceBySlug(registry, parsed.sourceSlug) ??
    matchRegisteredSourceName(registry, parsed.sourceSlug);
  return source ? sourceDefinitionToRef(source) : null;
}
