/**
 * Card-authoring kit — seam contracts.
 *
 * These types are the DURABLE API of the authoring pipeline. The implementations
 * behind each stage (generation, quality-gating, grounding, structuring) are
 * reference code you are expected to fork and have Claude Code rebuild for your
 * own stack — possibly in another language. The CONTRACTS are what stays stable
 * across those rebuilds, so depend on the shapes here, not on any one function.
 *
 * Pipeline:  source → ground → generate → quality-gate → structure → audit
 *
 * Nothing in this file imports the database, Next.js, or any service. It is pure
 * type surface so it can be read, copied, and re-implemented anywhere.
 */

// ─── Core authored units ────────────────────────────────────────────────────

/** Complexity tier: 1 = teaching/scaffold (C1), 2 = standard test, 3 = hard. */
export type Complexity = 1 | 2 | 3;
/** Importance: 1 = normal, 2 = important, 3 = foundational. */
export type Importance = 1 | 2 | 3;

export type CardType = "cloze" | "mcq";

/**
 * A cloze (fill-in-the-blank) card. `back` is the deleted span (kept SHORT —
 * 1–2 words is the house rule); `backs` carries multi-blank answers when a card
 * was split from a list. `context` is the teaching note shown after a miss.
 */
export interface AuthoringCard {
  cardType: "cloze";
  front: string;
  back: string;
  backs?: string[];
  context?: string;
  complexity: Complexity;
  importance: Importance;
  topics: string[];
  /** Citation ref, e.g. "doi:10.1007/s00431-022-04458-z" or "source-slug:doc#sec". */
  cite?: string;
  /** Content-hash identity for idempotent upsert, e.g. "le:42" | "mdx:..." | "bank:...". */
  stableId?: string;
}

export interface McqOption {
  label: string; // "A" | "B" | ...
  text: string;
  isCorrect: boolean;
  explanation?: string;
}

/** A multiple-choice question. */
export interface AuthoringQuestion {
  cardType: "mcq";
  stem: string;
  /**
   * Two minimums apply, by design. GENERATE/GROUND treat **≥2** as the structural
   * validity floor (`buildMcq`, `validateQuestion`); the QUALITY-GATE
   * (`runMcqGates`) expects **≥4** — the single-best-answer house standard. So a
   * 2–3 option item is valid-but-below-standard and the gate flags it (not a
   * contradiction — validity and quality are separate bars). The deterministic
   * `passthroughAuthor` placeholder emits 2 options and is wiring-only, below the
   * quality bar on purpose; real authors (e.g. author-claude.ts) emit 4.
   */
  options: McqOption[];
  explanation?: string;
  complexity: Complexity;
  importance: Importance;
  topics: string[];
  cite?: string;
  stableId?: string;
}

export type AuthoredItem = AuthoringCard | AuthoringQuestion;

// ─── Sources & grounding (the LocalEvidence seam) ────────────────────────────

export type EvidenceTier =
  | "guideline"
  | "systematic_review"
  | "rct"
  | "cohort"
  | "review"
  | "other";

export interface SourceRef {
  slug?: string;
  doi?: string;
  title: string;
  tier: EvidenceTier;
  year?: string;
  journal?: string;
}

export interface EvidencePassage {
  text: string;
  source: SourceRef;
  /** Fused retrieval score, if available. */
  score?: number;
}

/**
 * The output of a grounded answer (LocalEvidence ledger entry, simplified).
 * `answer`/`reasoning`/`confidence` are populated at synthesis time and may be
 * null on a freshly-retrieved entry. This is the curriculum SEED that the
 * generation stage turns into cards.
 */
export interface EvidencePack {
  question: string;
  answer?: string | null;
  reasoning?: string | null;
  confidence?: "high" | "moderate" | "low" | null;
  evidence: EvidencePassage[];
  /** DOIs wanted but not retrieved — the corpus gap. */
  gaps?: SourceRef[];
}

// ─── Quality-gate seam ───────────────────────────────────────────────────────

export type IssueSeverity = "block" | "warn" | "info";

export interface QualityIssue {
  /** The check that fired, e.g. "length-bias" | "format-asymmetry" | "guessable". */
  check: string;
  severity: IssueSeverity;
  message: string;
}

/** Result of running an item through the quality gates. */
export interface QualityVerdict {
  ok: boolean; // false if any `block` issue present
  issues: QualityIssue[];
}

/** Signature every quality gate implements. */
export type QualityGate<T extends AuthoredItem = AuthoredItem> = (item: T) => QualityIssue[];

// ─── Grounding/audit seam (verify a claim against evidence) ──────────────────

export type GroundingStatus = "supported" | "contradicted" | "unsupported";

/** Result of checking one authored claim against retrieved evidence. */
export interface GroundingResult {
  claim: string;
  status: GroundingStatus;
  passages: EvidencePassage[];
  confidence?: number;
  /** When status is "unsupported": is it a real defect, or just a corpus gap? */
  gap?: boolean;
}
