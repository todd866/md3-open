/**
 * Card extractors — pull cloze cards out of MDX component blocks.
 *
 * Extraction policy: EXPLICIT Q&A ONLY (no auto-blank from bold terms).
 *
 * Extracts from:
 * - <KeyPoint>       -> card from **Q:** / **A:** format only
 * - <Danger>         -> card from **Q:** / **A:** format only
 * - <ClinicalPearl>  -> card from **Q:** / **A:** format only
 *
 * Components without Q&A format are teaching-only and produce no card. The
 * old bold-term-blank fallback was removed because it generated low-quality
 * "guess which word was bold" cloze cards, and the <Mnemonic> auto-blanking
 * was removed because it produced brittle multi-blank giveaway cards.
 *
 * This is the DB-free reference port: every extractor returns plain
 * {@link AuthoringCard} objects built from strings only — no filesystem,
 * Prisma, rotations, citation-registry, or logging dependencies. The pure
 * QA-boundary trimming that production kept in a sibling module is inlined
 * here so this file compiles standalone.
 */

import type { AuthoringCard, Complexity, Importance } from "@/lib/authoring/contracts";

// ─── Source components we know how to extract ───────────────────────────────

export type SourceComponent = "KeyPoint" | "Danger" | "ClinicalPearl";

// ─── Extraction stats — tracks teaching-only component skips ─────────────────

export interface ExtractionStats {
  keyPointTotal: number;
  keyPointSkipped: number;
  dangerTotal: number;
  dangerSkipped: number;
  clinicalPearlTotal: number;
  clinicalPearlSkipped: number;
  // Context-quality violations on emitted cloze cards. Counted at extract time
  // so a seed log can surface the gap; the same helpers back any later audit.
  clozeMissingContext: number;
  clozeStubContext: number;
  clozeRestatesAnswer: number;
}

function emptyStats(): ExtractionStats {
  return {
    keyPointTotal: 0,
    keyPointSkipped: 0,
    dangerTotal: 0,
    dangerSkipped: 0,
    clinicalPearlTotal: 0,
    clinicalPearlSkipped: 0,
    clozeMissingContext: 0,
    clozeStubContext: 0,
    clozeRestatesAnswer: 0,
  };
}

let _stats: ExtractionStats = emptyStats();

export function resetExtractionStats(): void {
  _stats = emptyStats();
}

export function getExtractionStats(): ExtractionStats {
  return { ..._stats };
}

// ─── QA-boundary trimming (inlined, was a sibling module in production) ──────

export type AnswerBoundaryKind =
  | "blank"
  | "unordered-list"
  | "ordered-list"
  | "blockquote"
  | "heading"
  | "component"
  | "attribution";

function getAnswerBoundaryKind(line: string): AnswerBoundaryKind | null {
  if (line.length === 0) return "blank";
  if (/^[-*+]\s+/.test(line)) return "unordered-list";
  if (/^\d+\.\s+/.test(line)) return "ordered-list";
  if (/^>\s+/.test(line)) return "blockquote";
  if (/^#{1,6}\s+/.test(line)) return "heading";
  if (/^<[/A-Z]/i.test(line)) return "component";
  if (/^(?:See also|Source|Sources|Reference|References):/i.test(line)) return "attribution";
  return null;
}

/**
 * Trim a raw answer at the first markdown block boundary, so teaching
 * bullets/headings/attribution lines do not get swallowed into the memorized
 * answer span.
 */
export function trimAnswerAtMarkdownBoundary(rawAnswer: string): string {
  const lines = rawAnswer.trim().split("\n");
  const kept: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    if (index > 0 && getAnswerBoundaryKind(trimmed)) break;
    kept.push(lines[index]);
  }

  return kept.join("\n").trim();
}

// ─── Context-quality helpers ─────────────────────────────────────────────────
// A "good" context teaches WHY/WHEN/TRAP. These helpers detect the three most
// common failure modes (missing, stub, restates-answer).

/** True when the card has no usable teaching context. */
export function isMissingContext(ctx: string | null | undefined): boolean {
  if (ctx == null) return true;
  return ctx.trim().length === 0;
}

/**
 * True when the context is a meaningless placeholder — most commonly an
 * acronym-definition stub ("MCD = minimal change disease.") or a placeholder
 * left by older pipelines ("See per-option explanations.").
 *
 * Acronym decoding belongs in hover UX, not the context slot. The acronym
 * prefix must be all-caps + digits, and the stub must be a single sentence —
 * a context that begins with an acronym definition and then teaches is fine.
 */
export function isStubContext(ctx: string | null | undefined): boolean {
  if (ctx == null) return false;
  const trimmed = ctx.trim();
  if (trimmed.length === 0) return false;
  // Known meaningless placeholders — match regardless of length.
  if (
    /^(?:see\s+per[-\s]option(?:\s+explanations?)?|see\s+options?|see\s+(?:above|below)|see\s+explanations?|n\/?a)\.?$/i.test(
      trimmed,
    )
  )
    return true;
  // Acronym = expansion patterns. Strip a single trailing period, then refuse
  // to flag if there's a sentence boundary (period + whitespace + non-empty)
  // which signals additional teaching.
  const stripped = trimmed.replace(/\.\s*$/, "");
  if (/\.\s+\S/.test(stripped)) return false; // multi-sentence — not a stub
  const definition = stripped.match(/^([A-Z][A-Z0-9]{1,9})\s*(=|:|\bstands for\b|\bmeans\b)\s+(.+)$/);
  if (definition) {
    const operator = definition[2];
    const rhs = definition[3];
    if (/\b(?:stands for|means)\b/i.test(operator)) return true;
    // Colon/equal contexts can be real mnemonic maps rather than empty acronym
    // expansions; keep those (they teach how to use the mnemonic). Plain
    // lowercase expansions remain stubs.
    if (/^[A-Za-z][A-Za-z\s'’/-]+$/.test(rhs.trim())) return true;
  }
  return false;
}

/**
 * True when the context is essentially a restatement of the answer — the
 * answer appears in the context and the context isn't much longer than the
 * answer (so it's echoing, not teaching).
 */
export function restatesAnswer(
  ctx: string | null | undefined,
  answer: string | null | undefined,
): boolean {
  if (!ctx || !answer) return false;
  const c = ctx.trim().toLowerCase();
  const a = answer.trim().toLowerCase();
  if (c.length === 0 || a.length === 0) return false;
  if (!c.includes(a)) return false;
  // Context must be at least ~2x the answer's length AND add ~80 extra chars
  // to count as teaching beyond the restatement.
  return c.length < Math.max(a.length * 2, a.length + 80);
}

function tallyContextQuality(ctx: string | null | undefined, answer: string): void {
  if (isMissingContext(ctx)) {
    _stats.clozeMissingContext++;
    return;
  }
  if (isStubContext(ctx)) {
    _stats.clozeStubContext++;
    return;
  }
  if (restatesAnswer(ctx, answer)) {
    _stats.clozeRestatesAnswer++;
  }
}

// ─── Text normalization helpers ──────────────────────────────────────────────

/**
 * Normalize context strings: collapse mid-sentence \n\n to single space.
 * Preserves intentional paragraph breaks (after sentence-ending punctuation).
 */
export function normalizeContext(text: string): string {
  return text
    .replace(/([a-z,;)’”])\n\n([a-z])/g, "$1 $2")
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Strip MDX components from text, keeping only the display text.
 * - <WikiLink slug="...">Display Text</WikiLink> -> Display Text
 * - <Term abbr="ABC" /> -> ABC
 * - <Term abbr="ABC">Full Name</Term> -> Full Name
 * - HTML entities (&lt; &gt; &amp;) -> decoded characters
 */
export function stripMdxComponents(text: string): string {
  return text
    .replace(/<LearnMore[\s\S]*?<\/LearnMore>/g, "")
    .replace(/^Source:.*$/gm, "")
    .replace(/\nSource:.*$/gm, "")
    .replace(/<WikiLink[^>]*>([^<]*)<\/WikiLink>/g, "$1")
    .replace(/<Term\s+abbr="([^"]+)"\s*\/>/g, "$1")
    .replace(/<Term[^>]*>([^<]*)<\/Term>/g, "$1")
    .replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, "")
    .replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\{\s*['"]\s*([<>])\s*['"]\s*\}/g, "$1")
    .replace(/\\([<>*_])/g, "$1")
    .replace(/\[\\_\\_\\_\]/g, "[___]")
    .trim();
}

/**
 * Strip emoji/label prefixes from card front text.
 * Removes patterns like "💡 PEARL:", "⚠️ DANGER:", "🔑 KEY:", and plain-text
 * equivalents.
 */
export function stripCardPrefixes(text: string): string {
  return text
    .replace(/^💡\s*PEARL:\s*/u, "")
    .replace(/^⚠️\s*DANGER:\s*/u, "")
    .replace(/^🔑\s*KEY:\s*/u, "")
    .replace(/^PEARL:\s*/i, "")
    .replace(/^DANGER:\s*/i, "")
    .replace(/^KEY:\s*/i, "")
    .trim();
}

// ─── Attribute extraction (JSX-style) ────────────────────────────────────────

function extractStringAttr(attrs: string, name: string): string | undefined {
  // Allow escaped quotes inside the quoted value so a context like
  // ...inspiratory \"whoop\"... doesn't truncate at the first \".
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)')`);
  const match = attrs.match(pattern);
  const raw = match?.[1] ?? match?.[2];
  if (!raw || raw.trim().length === 0) return undefined;
  return raw
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .trim();
}

/** Extract a JSX numeric attribute like importance={3}. */
function extractNumberAttr(attrs: string, name: string): number | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*\\{\\s*(\\d+)\\s*\\}`);
  const match = attrs.match(pattern);
  return match ? parseInt(match[1], 10) : undefined;
}

// ─── Heading / topic extraction ──────────────────────────────────────────────

export type Heading = { index: number; level: number; text: string; topics: string[] };

const HEADING_IGNORE_TITLES = new Set([
  "practice questions",
  "test your knowledge",
  "overview",
  "key facts",
  "definition",
  "sources",
  "related topics",
  "references",
  "mcqs",
  "mcq",
  "quick reference",
  "high-yield drill",
  "high yield drill",
  "rapid recall",
  "rapid review",
  "summary",
  "recap",
  "self test",
  "self-test",
  "self assessment",
  "self-assessment",
]);

const WORD_STOPLIST = new Set([
  "and",
  "or",
  "the",
  "a",
  "an",
  "of",
  "to",
  "for",
  "in",
  "on",
  "with",
  "without",
  "vs",
  "versus",
  "management",
  "assessment",
  "approach",
  "overview",
  "basics",
  "guide",
  "numbers",
  "practice",
  "questions",
  "notes",
  "classification",
  "cluster",
  "clusters",
  "core",
  "detail",
  "details",
  "boundary",
  "boundaries",
  "domain",
  "domains",
  "severity",
  "severities",
  "subtype",
  "subtypes",
  "feature",
  "features",
  "criterion",
  "criteria",
  "principle",
  "principles",
  "factor",
  "factors",
  "role",
  "roles",
  "level",
  "levels",
  "type",
  "types",
  "kind",
  "kinds",
  "mode",
  "modes",
  "option",
  "options",
  "risk",
  "risks",
  "summary",
  "additional",
  "sample",
  "samples",
  "example",
  "examples",
  "table",
  "tables",
  "list",
  "lists",
  "common",
  "general",
  "specific",
  "introduction",
  "background",
  "mcq",
  "mcqs",
  "pearl",
  "pearls",
  "tip",
  "tips",
  "trait",
  "traits",
  "significance",
  "prognostic",
  "prevention",
  "detection",
  "diagnosis",
  "high",
  "low",
  "yield",
]);

function dedupeTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of topics) {
    const t = raw.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    result.push(t);
  }
  return result;
}

function cleanHeadingText(raw: string): string {
  return raw
    .replace(/\s+#+\s*$/, "")
    .replace(/^Week\s*\d+\s*[:.\-–—]\s*/i, "")
    .replace(/^\d+(?:\.\d+)*[.)]?\s+/, "")
    .trim();
}

function topicsFromHeadingText(raw: string): string[] {
  // Strip embedded MDX before tokenising so component-attribute names don't
  // leak into the word list and produce phantom acronyms.
  const cleaned = cleanHeadingText(stripMdxComponents(raw));
  if (!cleaned) return [];
  if (HEADING_IGNORE_TITLES.has(cleaned.toLowerCase())) return [];

  const primary = cleaned.split(/[:–—-]/)[0]?.trim() ?? cleaned;
  if (!primary) return [];

  const topics = new Set<string>();

  // Multi-topic chapter titles ("Cardiology, Developmental & Endocrinology")
  // are lists, not single phrase topics — split on simultaneous comma + `&`.
  const isMultiTopicList = /,/.test(primary) && /(?:\s+&\s+|\s+and\s+)/.test(primary);
  if (isMultiTopicList) {
    const parts = primary
      .split(/\s*,\s*|\s+&\s+|\s+and\s+/i)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of parts) topics.add(p);
  } else {
    topics.add(primary);
  }

  // Add obvious abbreviations already present (BLS, CPR, ABG, etc.)
  for (const match of primary.matchAll(/\b[A-Z][A-Z0-9]{1,}\b/g)) {
    topics.add(match[0]);
  }

  // Add key words from the heading.
  const words = primary.split(/[^A-Za-z0-9]+/).filter(Boolean);
  for (const word of words) {
    const lower = word.toLowerCase();
    if (WORD_STOPLIST.has(lower)) continue;
    if (word.length < 3) continue;
    if (!/[A-Za-z]/.test(word)) continue; // skip numbers-only tokens
    if (/^\d+[a-z]?$/i.test(word)) continue; // skip section-numbering tokens
    topics.add(word);
  }

  return [...topics];
}

export function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const pattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  for (const match of content.matchAll(pattern)) {
    const level = match[1]?.length ?? 0;
    const rawText = match[2] ?? "";
    const index = match.index ?? 0;
    const topics = topicsFromHeadingText(rawText);
    headings.push({ index, level, text: rawText.trim(), topics });
  }
  return headings.sort((a, b) => a.index - b.index);
}

/**
 * Walk ancestor headings backward from a position, collecting the closest
 * heading at each level while climbing toward h1.
 */
function walkAncestorHeadings(headings: Heading[], index: number, visit: (h: Heading) => void): void {
  let currentLevel = Infinity;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.index >= index) continue;
    if (h.level >= currentLevel) continue;
    currentLevel = h.level;
    visit(h);
    if (currentLevel <= 1) break;
  }
}

function topicsForIndex(headings: Heading[], index: number): string[] {
  if (headings.length === 0) return [];
  const collected: string[] = [];
  walkAncestorHeadings(headings, index, (h) => {
    collected.push(...h.topics);
  });
  return dedupeTopics(collected);
}

// ─── Q&A pair parsing ────────────────────────────────────────────────────────

export function parseQAPairs(content: string): Array<{ question: string; answer: string }> {
  const qaRegex = /\*\*Q:\*\*\s*([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)(?=\s*\*\*Q:\*\*|\s*$)/gi;
  const pairs: Array<{ question: string; answer: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = qaRegex.exec(content)) !== null) {
    const question = m[1].trim();
    // Stop at the first markdown block boundary so teaching bullets/headings
    // do not get swallowed into the memorized answer.
    const answer = trimAnswerAtMarkdownBoundary(m[2].trim());
    pairs.push({ question, answer });
  }
  return pairs;
}

/**
 * Split a multi-blank answer string and align it to the blank count.
 * - blankCount <= 1: single answer (no backs array)
 * - parts >= blankCount: truncate to blankCount and return backs
 * - parts <  blankCount: fall back to single answer (MDX needs fixing)
 */
export function alignMultiBlankAnswers(
  answerPart: string,
  blankCount: number,
): { back: string; backs?: string[] } {
  if (blankCount <= 1) {
    return { back: answerPart };
  }

  const parts = answerPart
    .split(/[;\n]/)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);

  if (parts.length >= blankCount) {
    const aligned = parts.slice(0, blankCount);
    return { back: aligned[0], backs: aligned };
  }

  return { back: parts[0] ?? answerPart };
}

// ─── Complexity heuristic ────────────────────────────────────────────────────

/**
 * Calculate complexity for a cloze card.
 * 1 = trivial (single-letter mnemonic, 1–2 word lookup)
 * 2 = moderate (KeyPoint cloze, drug doses, specific clinical facts)
 * 3 = complex (reserved for reasoning items)
 *
 * KeyPoint defaults to C2: short definitional answers ("thiamine", "6 months")
 * are exactly the C2 band — a specific fact someone must *know*, not a naive
 * scaffold. True C1 scaffolds are author-tagged via `complexity={1}`.
 */
function calculateComplexity(sourceComponent: SourceComponent, answer: string, front: string): Complexity {
  const answerWordCount = answer.trim().split(/\s+/).length;
  const hasNumbers = /\d/.test(answer);
  const hasUnits =
    /\b(mg|mL|mmol|mmHg|%|kg|cm|mm|bpm|min|sec|hours?|minutes?|days?|weeks?)\b/i.test(answer);

  if (sourceComponent === "KeyPoint") {
    // Author-supplied scaffolds aside, KeyPoints test specific recall facts.
    void front;
    void answerWordCount;
    void hasNumbers;
    void hasUnits;
    return 2;
  }

  // Danger / ClinicalPearl always moderate.
  return 2;
}

// ─── Component extraction ────────────────────────────────────────────────────

interface ComponentConfig {
  tagName: string;
  sourceComponent: SourceComponent;
  getComplexity: (back: string, front: string) => Complexity;
  statTotal: keyof ExtractionStats;
  statSkipped: keyof ExtractionStats;
}

function buildCard(args: {
  front: string;
  back: string;
  backs?: string[];
  context?: string;
  topics: string[];
  complexity: Complexity;
  importance?: Importance;
  cite?: string;
}): AuthoringCard {
  const card: AuthoringCard = {
    cardType: "cloze",
    front: args.front,
    back: args.back,
    complexity: args.complexity,
    importance: args.importance ?? 1,
    topics: args.topics,
  };
  if (args.backs && args.backs.length > 0) card.backs = args.backs;
  if (args.context) card.context = args.context;
  if (args.cite) card.cite = args.cite;
  return card;
}

function extractComponentCards(
  content: string,
  headings: Heading[],
  config: ComponentConfig,
): AuthoringCard[] {
  const cards: AuthoringCard[] = [];

  const tagRegex = new RegExp(
    `<${config.tagName}((?:[^>"]|"[^"]*")*)>([\\s\\S]*?)<\\/${config.tagName}>`,
    "g",
  );

  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(content)) !== null) {
    (_stats[config.statTotal] as number)++;
    const attrs = match[1] ?? "";
    const innerContent = match[2].trim();
    const headingTopics = topicsForIndex(headings, match.index ?? 0);

    const contextOverride = extractStringAttr(attrs, "context");
    // No heading-breadcrumb fallback: a same-across-N-cards breadcrumb taught
    // nothing. If the author didn't write context=, leave it empty.
    const resolvedContext = contextOverride
      ? normalizeContext(stripMdxComponents(contextOverride))
      : undefined;
    const cite = extractStringAttr(attrs, "cite");
    const importanceAttr = extractNumberAttr(attrs, "importance");
    const importance: Importance | undefined =
      importanceAttr === 1 || importanceAttr === 2 || importanceAttr === 3
        ? (importanceAttr as Importance)
        : undefined;
    const complexityAttr = extractNumberAttr(attrs, "complexity");
    const complexityOverride: Complexity | undefined =
      complexityAttr === 1 || complexityAttr === 2 || complexityAttr === 3
        ? (complexityAttr as Complexity)
        : undefined;

    // Parse all Q&A pairs (handles multiple per component, trims trailing notes).
    const qaPairs = parseQAPairs(innerContent);
    if (qaPairs.length > 0) {
      for (const { question, answer } of qaPairs) {
        const questionPart = stripCardPrefixes(question);
        const answerPart = answer;
        const hasCloze = /\[\.\.\.\]|\[___\]|\[\\_\\_\\_\]/.test(questionPart);

        if (hasCloze) {
          const front = questionPart.replace(/\[\.\.\.\]/g, "[___]").replace(/\[\\_\\_\\_\]/g, "[___]");
          const blankCount = (front.match(/\[___\]/g) ?? []).length;
          const { back: alignedBack, backs: alignedBacks } = alignMultiBlankAnswers(answerPart, blankCount);

          tallyContextQuality(resolvedContext, alignedBack);
          cards.push(
            buildCard({
              front: stripMdxComponents(front),
              back: stripMdxComponents(alignedBack),
              backs: alignedBacks ? alignedBacks.map(stripMdxComponents) : undefined,
              context: resolvedContext,
              topics: dedupeTopics(headingTopics),
              complexity: complexityOverride ?? config.getComplexity(alignedBack, front),
              importance,
              cite,
            }),
          );
        } else {
          tallyContextQuality(resolvedContext, answerPart);
          cards.push(
            buildCard({
              front: stripMdxComponents(questionPart) + " [___]",
              back: stripMdxComponents(answerPart),
              context: resolvedContext,
              topics: dedupeTopics(headingTopics),
              complexity: complexityOverride ?? config.getComplexity(answerPart, questionPart),
              importance,
              cite,
            }),
          );
        }
      }
      continue; // Q&A already handled
    }

    // Fallback: inline cloze — has [___] blanks and **A:** but no **Q:** prefix.
    // e.g. "**MDE** requires [___] or more symptoms. **A:** 5"
    const strippedInner = stripMdxComponents(innerContent);
    const hasCloze = /\[___\]/.test(strippedInner);
    const inlineAnswerMatch = strippedInner.match(/^([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)$/);
    if (hasCloze && inlineAnswerMatch) {
      const questionPart = stripCardPrefixes(inlineAnswerMatch[1].trim());
      const rawAnswer = trimAnswerAtMarkdownBoundary(inlineAnswerMatch[2].trim());

      const front = questionPart.replace(/\[\.\.\.\]/g, "[___]");
      const blankCount = (front.match(/\[___\]/g) ?? []).length;
      const { back: alignedBack, backs: alignedBacks } = alignMultiBlankAnswers(rawAnswer, blankCount);

      tallyContextQuality(resolvedContext, alignedBack);
      cards.push(
        buildCard({
          front: stripMdxComponents(front),
          back: stripMdxComponents(alignedBack),
          backs: alignedBacks ? alignedBacks.map(stripMdxComponents) : undefined,
          context: resolvedContext,
          topics: dedupeTopics(headingTopics),
          complexity: complexityOverride ?? config.getComplexity(alignedBack, front),
          importance,
          cite,
        }),
      );
      continue;
    }

    (_stats[config.statSkipped] as number)++;
  }

  return cards;
}

/** Extract cards from <KeyPoint> components. */
export function extractKeyPointCards(content: string, headings: Heading[]): AuthoringCard[] {
  return extractComponentCards(content, headings, {
    tagName: "KeyPoint",
    sourceComponent: "KeyPoint",
    getComplexity: (back, front) => calculateComplexity("KeyPoint", back, front),
    statTotal: "keyPointTotal",
    statSkipped: "keyPointSkipped",
  });
}

/** Extract cards from <Danger> components. */
export function extractDangerCards(content: string, headings: Heading[]): AuthoringCard[] {
  return extractComponentCards(content, headings, {
    tagName: "Danger",
    sourceComponent: "Danger",
    getComplexity: () => 2,
    statTotal: "dangerTotal",
    statSkipped: "dangerSkipped",
  });
}

/** Extract cards from <ClinicalPearl> components. */
export function extractClinicalPearlCards(content: string, headings: Heading[]): AuthoringCard[] {
  return extractComponentCards(content, headings, {
    tagName: "ClinicalPearl",
    sourceComponent: "ClinicalPearl",
    getComplexity: () => 2,
    statTotal: "clinicalPearlTotal",
    statSkipped: "clinicalPearlSkipped",
  });
}

/**
 * Extract every supported card from a single MDX content string.
 * Convenience wrapper running all three component extractors against the
 * shared heading index.
 */
export function extractCardsFromContent(content: string): AuthoringCard[] {
  const headings = extractHeadings(content);
  return [
    ...extractKeyPointCards(content, headings),
    ...extractDangerCards(content, headings),
    ...extractClinicalPearlCards(content, headings),
  ];
}
