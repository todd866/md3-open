/**
 * LocalEvidence → cards: the SYNTHESIS transform of the GROUND stage.
 *
 * One grounded answer (a LocalEvidence ledger entry, modelled here as an
 * {@link EvidencePack}) becomes a small bundle of authored items: a C1 teaching
 * cloze + a C2 MCQ, both citing the pack's top source and sharing a stable
 * `le:<id>` identity for idempotent upsert.
 *
 * This is the LE analogue of ImageLibrary's `export_to_md3.py`: a deterministic
 * GLUE layer that maps one upstream record onto the fields the md3 card pipeline
 * needs (stableId, cite, complexity/importance defaults, topics). It is pure and
 * dependency-light — no DB, no network, no services.
 *
 * ── The Claude-authored seam ──────────────────────────────────────────────────
 * The hard part — turning evidence passages into a *good* cloze front/back and a
 * *good* MCQ with plausible distractors — is a CLAUDE-CODE-authored step at
 * runtime, not regex glue. So this file does NOT try to phrase cards itself.
 * Instead it defines an {@link AuthorFn} hook that a caller supplies. The caller
 * (md3.info's batch job, or your fork's) hands the pack to Claude Code, gets back
 * draft card text, and this module wires that text into contract-shaped items
 * with the right identity, citation, and complexity. A built-in
 * {@link passthroughAuthor} returns deterministic placeholder drafts so the glue
 * is runnable/testable without an LLM in the loop.
 *
 * Pipeline position:  GROUND (ledger entry) → [Claude authors text] → these items
 *                     → QUALITY-GATE → STRUCTURE → AUDIT.
 */

import * as fs from "node:fs";

import type {
  AuthoredItem,
  AuthoringCard,
  AuthoringQuestion,
  Complexity,
  EvidencePack,
  EvidencePassage,
  EvidenceTier,
  Importance,
  McqOption,
  SourceRef,
} from "@/lib/authoring/contracts";

// ─── complexity defaults (the house rule) ────────────────────────────────────

/** C1 = teaching/scaffold cloze. */
export const C1: Complexity = 1;
/** C2 = standard test MCQ. */
export const C2: Complexity = 2;
/** Items minted from grounded evidence are "important" by default, not foundational. */
const DEFAULT_IMPORTANCE: Importance = 2;

// ─── the Claude-authored seam ─────────────────────────────────────────────────

/** What Claude (or any author) is asked to phrase for one cloze blank. */
export interface ClozeDraft {
  /** Statement with a `[___]` blank. */
  front: string;
  /** The deleted span — SHORT, 1–2 words (house rule). */
  back: string;
  /** Teaching note shown after a miss. */
  context?: string;
  backs?: string[];
}

/** What Claude (or any author) is asked to phrase for one MCQ. */
export interface McqDraft {
  stem: string;
  /** Options in any order; exactly one isCorrect. Labels are assigned here if absent. */
  options: Array<{ text: string; isCorrect: boolean; explanation?: string }>;
  explanation?: string;
}

/** The text-authoring drafts for one pack (either may be omitted/skipped). */
export interface AuthoredDrafts {
  cloze?: ClozeDraft | null;
  mcq?: McqDraft | null;
}

/**
 * The runtime card-writing hook. A caller supplies this; the implementation is
 * expected to be a Claude-Code-authored step that reads the grounded answer +
 * its evidence passages and returns well-phrased card drafts. This module turns
 * those drafts into contract-shaped {@link AuthoredItem}s — it never invents the
 * clinical content itself.
 *
 * `topics` is the deterministic topic suggestion (see {@link deriveTopics}). It
 * is advisory only: the glue wires those derived topics onto the minted items
 * regardless of what the author returns, so use it to shape phrasing — not to
 * override topics ({@link AuthoredDrafts} has no topics channel by design).
 */
export type AuthorFn = (input: {
  pack: EvidencePack;
  /** Deterministic topic suggestion (see {@link deriveTopics}). */
  topics: string[];
}) => AuthoredDrafts;

/**
 * The no-LLM fallback author: deterministic placeholder drafts so the glue is
 * runnable and testable without Claude in the loop. NOT for production cards —
 * it just proves the field-mapping wiring end to end. Real callers pass a
 * Claude-authored {@link AuthorFn}.
 */
export const passthroughAuthor: AuthorFn = ({ pack, topics }) => {
  const answer = (pack.answer ?? "").trim();
  // Only emit drafts when there's an actual worked answer to teach.
  if (!answer) return { cloze: null, mcq: null };

  const firstLine = answer.split("\n").map((l) => l.trim()).find(Boolean) ?? answer;
  const short = firstLine.slice(0, 120);
  return {
    cloze: {
      front: `${pack.question.replace(/\?+$/, "")} → [___].`,
      back: "[placeholder]",
      context: short,
    },
    mcq: {
      stem: pack.question,
      options: [
        { text: short || "(answer)", isCorrect: true },
        { text: "(distractor — author at runtime)", isCorrect: false },
      ],
      explanation: pack.reasoning?.trim() || short || undefined,
    },
  };
};

// ─── deterministic glue: drafts → contract items ─────────────────────────────

/** Stable id for items minted from a ledger entry: `le:<id>`. */
export function leStableId(id: number | string): string {
  return `le:${id}`;
}

/**
 * The citation for a pack = the top source's DOI (as a `doi:` cite ref), falling
 * back to its slug, then null. "Top" = highest-scoring passage, else the first.
 */
export function topCite(pack: EvidencePack): string | undefined {
  const top = topSource(pack);
  if (!top) return undefined;
  if (top.doi) return `doi:${top.doi}`;
  if (top.slug) return top.slug;
  return undefined;
}

function topSource(pack: EvidencePack): SourceRef | undefined {
  const passages = pack.evidence ?? [];
  if (!passages.length) return undefined;
  const ranked: EvidencePassage[] = [...passages].sort(
    (a, b) => (b.score ?? 0) - (a.score ?? 0),
  );
  return ranked[0].source;
}

/**
 * Derive a coarse topic suggestion from the question. Deterministic and crude on
 * purpose — these are the topics the glue wires onto minted items; the
 * {@link AuthorFn} sees them only to frame its prompt and cannot override them.
 * Extracts capitalised / multi-word noun-ish tokens, deduped, capped.
 */
export function deriveTopics(question: string, max = 4): string[] {
  const stop = new Set([
    "what","which","when","why","how","where","who","the","a","an","of","for",
    "in","on","with","to","is","are","does","do","and","or","at","by","under",
    "warrants","most","best","first","line","threshold",
  ]);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of question.replace(/[?.,;:!()]/g, " ").split(/\s+/)) {
    const w = tok.trim();
    if (w.length < 3) continue;
    const key = w.toLowerCase();
    if (stop.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

function buildCloze(
  draft: ClozeDraft,
  ctx: { id: number | string; cite?: string; topics: string[] },
): AuthoringCard | null {
  const front = draft.front.trim();
  const back = draft.back.trim();
  if (!front || !back) return null;
  return {
    cardType: "cloze",
    front,
    back,
    backs: draft.backs?.length ? draft.backs : undefined,
    context: draft.context?.trim() || undefined,
    complexity: C1,
    importance: DEFAULT_IMPORTANCE,
    topics: ctx.topics,
    cite: ctx.cite,
    stableId: `${leStableId(ctx.id)}:cloze`,
  };
}

function buildMcq(
  draft: McqDraft,
  ctx: { id: number | string; cite?: string; topics: string[] },
): AuthoringQuestion | null {
  const stem = draft.stem.trim();
  if (!stem) return null;
  const options: McqOption[] = draft.options
    .filter((o) => o.text.trim())
    .map((o, i) => ({
      label: String.fromCharCode(65 + i), // A, B, C, ...
      text: o.text.trim(),
      isCorrect: o.isCorrect,
      explanation: o.explanation?.trim() || undefined,
    }));
  // A valid MCQ needs ≥2 options and exactly one correct answer.
  if (options.length < 2) return null;
  if (options.filter((o) => o.isCorrect).length !== 1) return null;
  return {
    cardType: "mcq",
    stem,
    options,
    explanation: draft.explanation?.trim() || undefined,
    complexity: C2,
    importance: DEFAULT_IMPORTANCE,
    topics: ctx.topics,
    cite: ctx.cite,
    stableId: `${leStableId(ctx.id)}:mcq`,
  };
}

/**
 * Turn ONE grounded answer into authored items: a C1 cloze + a C2 MCQ.
 *
 * The deterministic glue here owns identity (`le:<id>`), citation (top source
 * DOI), and complexity defaults (C1=1, C2=2). The CARD TEXT comes from `author`
 * — supply a Claude-authored {@link AuthorFn} at runtime; the default
 * {@link passthroughAuthor} yields placeholder drafts for wiring/tests.
 *
 * Returns however many items the author produced valid drafts for (0–2). A pack
 * with no worked answer yields no items.
 *
 * `id` defaults to a hash-free positional id when the pack didn't carry one;
 * prefer passing the ledger entry's real `id` (see {@link readLedger}, whose
 * packs are returned in ledger order so the caller can zip ids).
 */
export function evidencePackToItems(
  pack: EvidencePack,
  options: { author?: AuthorFn; id?: number | string } = {},
): AuthoredItem[] {
  const author = options.author ?? passthroughAuthor;
  const id = options.id ?? slugifyQuestion(pack.question);
  const topics = deriveTopics(pack.question);
  const cite = topCite(pack);

  const drafts = author({ pack, topics });
  const items: AuthoredItem[] = [];

  if (drafts.cloze) {
    const card = buildCloze(drafts.cloze, { id, cite, topics });
    if (card) items.push(card);
  }
  if (drafts.mcq) {
    const q = buildMcq(drafts.mcq, { id, cite, topics });
    if (q) items.push(q);
  }
  return items;
}

/** A url-safe slug fallback id, matching LE's own `project` slug style. */
function slugifyQuestion(q: string): string {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ─── reading the ledger (pure parse, no service) ──────────────────────────────

/**
 * Parse a LocalEvidence `ledger/answers.jsonl` file into {@link EvidencePack}s.
 *
 * This is the BULK path: rather than re-asking LE question-by-question over HTTP,
 * read the persisted ledger directly. Each non-blank line is one JSON ledger
 * entry. Malformed lines are skipped. Only entries with a worked `answer` are
 * returned by default (the curriculum seeds); pass `includeUnanswered: true` to
 * also get retrieval-only entries.
 *
 * Packs are returned in file order, each carrying the LE `id` so callers can
 * mint stable `le:<id>` items — read the id from the matching {@link LedgerLine}
 * via {@link readLedgerLines} when you need to zip them with
 * `evidencePackToItems(pack, { id })`.
 */
export function readLedger(
  path: string,
  options: { includeUnanswered?: boolean } = {},
): EvidencePack[] {
  return readLedgerLines(path, options).map((l) => l.pack);
}

/** A parsed ledger entry: its LE id plus the contract-shaped pack. */
export interface LedgerLine {
  id: number | string;
  pack: EvidencePack;
}

/**
 * Like {@link readLedger} but also returns each entry's LE `id`, so the caller
 * can mint stable `le:<id>` items:
 *
 *   for (const { id, pack } of readLedgerLines(path))
 *     items.push(...evidencePackToItems(pack, { id, author }));
 */
export function readLedgerLines(
  path: string,
  options: { includeUnanswered?: boolean } = {},
): LedgerLine[] {
  const raw = fs.readFileSync(path, "utf-8");
  const out: LedgerLine[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(s);
    } catch {
      continue; // skip malformed lines, mirroring LE's own loader
    }
    if (!options.includeUnanswered && !entry.answer) continue;
    out.push({
      id: (entry.id as number | undefined) ?? slugifyQuestion(String(entry.question ?? "")),
      pack: ledgerEntryToPack(entry),
    });
  }
  return out;
}

// ─── ledger entry (raw JSON) → EvidencePack ───────────────────────────────────
// Self-contained translation so this file doesn't depend on le-client.ts; the
// ledger schema is documented in LocalEvidence/localevidence/ledger.py.

interface RawEvidence {
  slug?: string;
  doi?: string | null;
  title?: string;
  tier?: string;
  text?: string;
  score?: number;
}

interface RawGap {
  doi?: string | null;
  title?: string;
  tier?: string;
}

function ledgerEntryToPack(entry: Record<string, unknown>): EvidencePack {
  const evidence = (entry.evidence as RawEvidence[] | undefined) ?? [];
  const gaps = (entry.gaps as RawGap[] | undefined) ?? [];
  return {
    question: String(entry.question ?? "").trim(),
    answer: (entry.answer as string | null | undefined) ?? null,
    reasoning: (entry.reasoning as string | null | undefined) ?? null,
    confidence: normalizeConfidence(entry.confidence as string | null | undefined),
    evidence: evidence.map((ev) => ({
      // Ledger evidence entries don't carry passage text (only passage_ids);
      // text is empty until a retrieval/verify call rehydrates it.
      text: (ev.text ?? "").trim(),
      source: {
        slug: ev.slug,
        doi: ev.doi ?? undefined,
        title: ev.title ?? "(untitled source)",
        tier: normalizeTier(ev.tier),
      },
      score: typeof ev.score === "number" ? ev.score : undefined,
    })),
    gaps: gaps.length
      ? gaps.map((g) => ({
          doi: g.doi ?? undefined,
          title: g.title ?? "(untitled source)",
          tier: normalizeTier(g.tier),
        }))
      : undefined,
  };
}

function normalizeConfidence(c: string | null | undefined): EvidencePack["confidence"] {
  switch ((c ?? "").trim().toLowerCase()) {
    case "high":
      return "high";
    case "moderate":
    case "medium":
      return "moderate";
    case "low":
      return "low";
    default:
      return null;
  }
}

/** See le-client.normalizeTier — duplicated here to keep this file standalone. */
function normalizeTier(tier: string | undefined | null): EvidenceTier {
  switch ((tier ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")) {
    case "guideline":
    case "guidelines":
      return "guideline";
    case "systematic_review":
    case "meta_analysis":
      return "systematic_review";
    case "rct":
    case "randomized_controlled_trial":
    case "randomised_controlled_trial":
      return "rct";
    case "cohort":
    case "case_control":
    case "observational":
      return "cohort";
    case "review":
    case "narrative_review":
      return "review";
    default:
      return "other";
  }
}
