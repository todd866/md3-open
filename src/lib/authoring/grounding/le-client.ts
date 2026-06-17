/**
 * LocalEvidence HTTP client — the GROUND stage's live seam.
 *
 * LocalEvidence (https://github.com/todd866/LocalEvidence) is a small, local,
 * stdlib-only retrieval service: it warms a passage index + a knowledge ledger
 * once and answers questions over your own corpus. This client is the thin TS
 * bridge from the authoring pipeline to that service. It is dependency-light by
 * design — just `fetch` — so it can be forked into any stack (and the durable
 * thing is the {@link EvidencePack} / {@link GroundingResult} shapes, not this
 * file).
 *
 * Two calls, mapped onto the authoring contracts:
 *   - {@link ask}            → POST /api/ask           → EvidencePack
 *   - {@link verifyEvidence} → POST /api/verify-evidence → GroundingResult
 *
 * Operational notes (from the LocalEvidence server):
 *   - A warm corpus answers in <5s. Slowness only happens on a COLD corpus, when
 *     LE is still acquiring papers. Curriculum generation is async anyway.
 *   - LE serialises requests (single-threaded on purpose); never point this at
 *     the open internet — bind LE to localhost or your tailnet.
 *   - LE persists every answered entry to `ledger/answers.jsonl`. For BULK card
 *     minting, read that ledger directly via `le-to-cards.ts` rather than
 *     re-asking question-by-question.
 *
 * The live `/api/ask` returns one of two statuses:
 *   - `answered`: a prior worked answer (exact or close paraphrase) — carries the
 *     full ledger entry (answer + reasoning + grounding + evidence).
 *   - `queued`:   a novel question — retrieval only (evidence passages), no
 *     synthesis yet; the question is queued for the next home deep-run.
 * Both map cleanly onto {@link EvidencePack} (a queued pack just has a null answer).
 */

import type {
  EvidencePack,
  EvidencePassage,
  EvidenceTier,
  GroundingResult,
  GroundingStatus,
  SourceRef,
} from "@/lib/authoring/contracts";

// ─── config ──────────────────────────────────────────────────────────────────

/** Where a local LocalEvidence service listens by default. */
export const DEFAULT_LE_BASE_URL = "http://127.0.0.1:8765";

export interface LeClientOptions {
  /** Base URL of the LocalEvidence service. Defaults to {@link DEFAULT_LE_BASE_URL}. */
  baseUrl?: string;
  /** Abort after this many ms. A warm corpus answers in <5s; default is generous. */
  timeoutMs?: number;
  /** Injectable fetch (tests / non-browser runtimes). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Thrown when the LocalEvidence service is unreachable or returns an error. */
export class LeServiceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LeServiceError";
  }
}

// ─── raw LE wire shapes (what server.py actually returns) ────────────────────
// Kept local + loose: this is the foreign boundary. We translate into contract
// types immediately so nothing downstream depends on LE's exact JSON.

interface LeEvidence {
  slug?: string;
  doi?: string | null;
  title?: string;
  tier?: string;
  text?: string;
  passage_ids?: number[];
  score?: number;
}

interface LeGap {
  doi?: string | null;
  title?: string;
  tier?: string;
  reason?: string;
}

/** A full ledger entry, as embedded under `answer` in an "answered" response. */
interface LeLedgerEntry {
  id?: number;
  question?: string;
  answer?: string | null;
  reasoning?: string | null;
  confidence?: string | null;
  evidence?: LeEvidence[];
  gaps?: LeGap[];
}

interface LeAskResponse {
  status?: "answered" | "queued";
  similarity?: number;
  /** present when status === "answered" */
  answer?: LeLedgerEntry;
  /** present when status === "queued" */
  evidence?: LeEvidence[];
  related?: unknown[];
  message?: string;
  error?: string;
}

interface LeVerifyResponse {
  status?: string;
  claim?: string;
  evidence?: LeEvidence[];
  passages?: LeEvidence[];
  confidence?: number;
  gap?: boolean;
  error?: string;
}

// ─── tier normalisation ──────────────────────────────────────────────────────

/**
 * Map LE's free-text tier strings onto the contract's coarse {@link EvidenceTier}.
 * LE uses hyphenated/loose labels ("systematic-review", "article"); the contract
 * uses a fixed set. Unknown labels fall through to "other".
 */
export function normalizeTier(tier: string | undefined | null): EvidenceTier {
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

// ─── translators (LE wire → contract) ────────────────────────────────────────

function toSourceRef(ev: LeEvidence | LeGap): SourceRef {
  return {
    slug: "slug" in ev ? ev.slug : undefined,
    doi: ev.doi ?? undefined,
    title: ev.title ?? "(untitled source)",
    tier: normalizeTier(ev.tier),
  };
}

function toPassage(ev: LeEvidence): EvidencePassage {
  return {
    text: (ev.text ?? "").trim(),
    source: toSourceRef(ev),
    score: typeof ev.score === "number" ? ev.score : undefined,
  };
}

function normalizeConfidence(
  c: string | null | undefined,
): EvidencePack["confidence"] {
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

/**
 * Translate either response shape (answered ledger entry OR queued retrieval)
 * into a single {@link EvidencePack}. Exported so `le-to-cards.ts` can reuse it
 * on raw ledger lines without re-implementing the mapping.
 */
export function leEntryToEvidencePack(
  question: string,
  entry: LeLedgerEntry | LeAskResponse,
): EvidencePack {
  const passages = (entry.evidence ?? []).map(toPassage);
  const gaps = ((entry as LeLedgerEntry).gaps ?? []).map(toSourceRef);
  return {
    question: (entry as LeLedgerEntry).question?.trim() || question,
    answer: (entry as LeLedgerEntry).answer ?? null,
    reasoning: (entry as LeLedgerEntry).reasoning ?? null,
    confidence: normalizeConfidence((entry as LeLedgerEntry).confidence),
    evidence: passages,
    gaps: gaps.length ? gaps : undefined,
  };
}

// ─── transport ───────────────────────────────────────────────────────────────

async function postJson<T>(
  url: string,
  body: unknown,
  opts: LeClientOptions,
): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new LeServiceError(
      "No fetch implementation available (pass `fetchImpl` in a non-fetch runtime).",
    );
  }

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const aborted = cause instanceof Error && cause.name === "AbortError";
    throw new LeServiceError(
      aborted
        ? `LocalEvidence did not respond within ${timeoutMs}ms at ${url}. ` +
            `If the corpus is cold it may still be acquiring papers; retry once warm.`
        : `Could not reach LocalEvidence at ${url}. Is the service running? ` +
            `Start it with \`localevidence serve\` (default ${DEFAULT_LE_BASE_URL}).`,
      cause,
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (cause) {
    throw new LeServiceError(
      `LocalEvidence returned non-JSON from ${url} (status ${res.status}).`,
      cause,
    );
  }

  if (!res.ok) {
    const msg =
      (parsed as { error?: string })?.error ?? `HTTP ${res.status}`;
    throw new LeServiceError(`LocalEvidence error from ${url}: ${msg}`);
  }
  return parsed as T;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Ask LocalEvidence a question. POSTs `{ question }` to `/api/ask` and returns
 * an {@link EvidencePack}.
 *
 * - If LE has a worked answer (exact or close paraphrase) the pack carries the
 *   full synthesis (answer + reasoning + confidence + cited evidence).
 * - If the question is novel, LE returns retrieval only and queues it for the
 *   next deep run: the pack has `answer: null` and `confidence: null`, but the
 *   `evidence` passages are still usable as a curriculum seed once synthesised.
 */
export async function ask(
  question: string,
  opts: LeClientOptions = {},
): Promise<EvidencePack> {
  const q = question.trim();
  if (!q) throw new LeServiceError("ask(): empty question.");

  const baseUrl = opts.baseUrl ?? DEFAULT_LE_BASE_URL;
  const res = await postJson<LeAskResponse>(`${baseUrl}/api/ask`, { question: q }, opts);

  if (res.error) throw new LeServiceError(`LocalEvidence /api/ask: ${res.error}`);

  // "answered" → the full ledger entry lives under `answer`.
  if (res.status === "answered" && res.answer) {
    return leEntryToEvidencePack(q, res.answer);
  }
  // "queued" (or anything else) → retrieval-only entry; answer stays null.
  return leEntryToEvidencePack(q, res);
}

export interface VerifyEvidenceOptions extends LeClientOptions {
  /** Optional context shipped to LE alongside the claim (e.g. the card front). */
  context?: string;
  /** Cap how many supporting passages LE should return. */
  topK?: number;
}

/**
 * Verify one authored claim against the corpus. POSTs `{ claim, context?, k? }`
 * to `/api/verify-evidence` and returns a {@link GroundingResult}.
 *
 * The AUDIT stage uses this to check that a card's claim is actually supported.
 * When LE reports `unsupported`, `gap` distinguishes a real card defect from a
 * mere corpus gap (the answer may be right, the corpus just lacks the paper).
 *
 * Note: `/api/verify-evidence` is part of the LocalEvidence service contract the
 * authoring pipeline targets. If your fork of LE only exposes retrieval, you can
 * implement verification on top of `ask()` instead — the {@link GroundingResult}
 * shape is what the pipeline depends on, not this endpoint.
 */
export async function verifyEvidence(
  claim: string,
  opts: VerifyEvidenceOptions = {},
): Promise<GroundingResult> {
  const c = claim.trim();
  if (!c) throw new LeServiceError("verifyEvidence(): empty claim.");

  const baseUrl = opts.baseUrl ?? DEFAULT_LE_BASE_URL;
  const payload: Record<string, unknown> = { claim: c };
  if (opts.context) payload.context = opts.context;
  if (typeof opts.topK === "number") payload.k = opts.topK;

  const res = await postJson<LeVerifyResponse>(
    `${baseUrl}/api/verify-evidence`,
    payload,
    opts,
  );

  if (res.error) {
    throw new LeServiceError(`LocalEvidence /api/verify-evidence: ${res.error}`);
  }

  const passages = (res.passages ?? res.evidence ?? []).map(toPassage);
  return {
    claim: res.claim?.trim() || c,
    status: normalizeStatus(res.status),
    passages,
    confidence: typeof res.confidence === "number" ? res.confidence : undefined,
    gap: typeof res.gap === "boolean" ? res.gap : undefined,
  };
}

function normalizeStatus(status: string | undefined): GroundingStatus {
  switch ((status ?? "").trim().toLowerCase()) {
    case "supported":
    case "support":
      return "supported";
    case "contradicted":
    case "refuted":
    case "contradict":
      return "contradicted";
    default:
      return "unsupported";
  }
}
