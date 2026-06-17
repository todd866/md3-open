/**
 * Reference Claude-backed AuthorFn for the GROUND → GENERATE seam.
 *
 * `le-to-cards.ts` defines {@link AuthorFn} as **synchronous** (`pack → drafts`)
 * because the deterministic glue around it (identity, citation, complexity,
 * validation) is sync. A real LLM author is async — so this module does the
 * Claude call in {@link draftCardsWithClaude} and exposes
 * {@link evidencePackToItemsWithClaude}, which awaits the drafts and then feeds
 * them through the existing sync glue via a resolved-closure author. The seam
 * ({@link AuthoredDrafts}) is what stays stable; this implementation is meant to
 * be forked.
 *
 * ── Why this file is NOT in the kit barrel (`../index.ts`) ────────────────────
 * The core kit (contracts, generate, quality, structure, the le-to-cards glue,
 * the le-client) has zero non-stdlib runtime deps, so it stays cheap to import
 * and trivial to rebuild. This module is the one place that pulls in the
 * Anthropic SDK, so it's an OPT-IN import: a batch/seed job that wants Claude to
 * phrase cards imports it directly
 *   (`import { evidencePackToItemsWithClaude } from "@/lib/authoring/grounding/author-claude"`),
 * keeping the SDK out of anything that only needs the contracts. Requires
 * `@anthropic-ai/sdk` (already a dependency here) and an `ANTHROPIC_API_KEY` in
 * the environment, or an injected client.
 *
 * ── The deployment-model alternative ──────────────────────────────────────────
 * md3-open's model is "Claude Code orchestrates, BYO token budget." Many forks
 * won't call the SDK at all — their orchestrator reads the ledger packs and
 * writes drafts directly, then calls `evidencePackToItems(pack, { id, author })`
 * with a plain sync {@link AuthorFn}. This file is the convenience path for the
 * SDK route; the seam serves both.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
// The SDK's zodOutputFormat helper is built against Zod v4 (`zod/v4`), so the
// structured-output schema below must use the same — the project's default
// `zod` import is v3 and its types won't flow through `messages.parse`.
import * as z from "zod/v4";

import type { AuthoredItem, EvidencePack } from "@/lib/authoring/contracts";

import {
  deriveTopics,
  evidencePackToItems,
  type AuthorFn,
  type AuthoredDrafts,
} from "./le-to-cards";

// ─── the structured-output schema (mirrors AuthoredDrafts) ───────────────────
// Optional fields are modelled `.nullable()` rather than `.optional()` so the
// JSON schema sent to the API stays strict (every key present); we map the
// nulls back to `undefined` when shaping the contract-level drafts.

const ClozeDraftSchema = z.object({
  front: z
    .string()
    .describe("A statement containing exactly one `[___]` fill-in-the-blank marker."),
  back: z
    .string()
    .describe("The deleted span — the single best answer, 1–2 words (house rule)."),
  context: z
    .string()
    .nullable()
    .describe("A one-sentence teaching note shown after a miss; null if none is warranted."),
});

const McqOptionSchema = z.object({
  text: z.string().describe("The option text."),
  isCorrect: z.boolean(),
  explanation: z
    .string()
    .nullable()
    .describe("Why this option is right/wrong; null if none."),
});

const McqDraftSchema = z.object({
  stem: z.string().describe("The question stem (single-best-answer)."),
  options: z
    .array(McqOptionSchema)
    .describe("Four options, with EXACTLY ONE having isCorrect:true and three plausible distractors."),
  explanation: z
    .string()
    .nullable()
    .describe("Overall teaching explanation for the item; null if none."),
});

const DraftsSchema = z.object({
  cloze: ClozeDraftSchema.nullable().describe(
    "A fill-in-the-blank teaching card, or null if the evidence can't support a clean short-answer blank.",
  ),
  mcq: McqDraftSchema.nullable().describe(
    "A single-best-answer MCQ, or null if the evidence can't support one with plausible distractors.",
  ),
});

type ParsedDrafts = z.infer<typeof DraftsSchema>;

// ─── options ─────────────────────────────────────────────────────────────────

export interface ClaudeAuthorOptions {
  /** Inject a configured client (tests, custom base URL, etc.). Defaults to `new Anthropic()`. */
  client?: Anthropic;
  /** Model id. Defaults to Opus 4.8. */
  model?: string;
  /** Output budget. Leaves room for adaptive thinking; non-streaming is fine at this size. */
  maxTokens?: number;
}

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_TOKENS = 8192;

const SYSTEM_PROMPT = `You are a medical-education card author. You turn a grounded clinical answer and its supporting evidence into spaced-repetition study cards.

Rules:
- Ground every card STRICTLY in the supplied answer, reasoning, and evidence passages. Do not introduce facts, numbers, or drug names that aren't supported by them.
- Cloze card: one statement with a single \`[___]\` blank. The blank's answer ("back") must be 1–2 words — the single most testable term, value, or name. Put any needed teaching nuance in "context", not the blank.
- MCQ: a single-best-answer stem with exactly four options, exactly one correct, and three distractors that are plausible to someone who half-knows the topic (common confusions, adjacent agents, near-miss thresholds) — never throwaway wrong answers.
- If the evidence is too thin or ambiguous to support a clean card of a given type, return null for that type rather than inventing one. Returning one good card beats two weak ones.`;

// ─── the async drafter ─────────────────────────────────────────────────────

/**
 * Ask Claude to phrase a cloze + MCQ for one grounded pack. Pure text authoring:
 * it returns {@link AuthoredDrafts}; the identity/citation/complexity wiring is
 * done downstream by {@link evidencePackToItems}. Returns `{ cloze: null,
 * mcq: null }` if the model declines (safety refusal) or returns nothing usable.
 */
export async function draftCardsWithClaude(
  input: { pack: EvidencePack; topics: string[] },
  options: ClaudeAuthorOptions = {},
): Promise<AuthoredDrafts> {
  const { pack, topics } = input;
  const client = options.client ?? new Anthropic();
  const model = options.model ?? DEFAULT_MODEL;
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  const response = await client.messages.parse({
    model,
    max_tokens: maxTokens,
    thinking: { type: "adaptive" },
    system: SYSTEM_PROMPT,
    output_config: { format: zodOutputFormat(DraftsSchema) },
    messages: [{ role: "user", content: buildPrompt(pack, topics) }],
  });

  // A safety refusal (or any non-conforming output) leaves parsed_output null.
  if (response.stop_reason === "refusal" || !response.parsed_output) {
    return { cloze: null, mcq: null };
  }
  return toDrafts(response.parsed_output);
}

/**
 * A ready-to-use {@link AuthorFn} factory: closes over the SDK options so you can
 * hand it to anything expecting the sync seam. NOTE the seam is sync, so this
 * cannot truly satisfy {@link AuthorFn} (which returns drafts, not a promise) —
 * prefer {@link evidencePackToItemsWithClaude}, which awaits for you. This
 * factory exists for callers that batch the async drafting themselves.
 */
export function makeClaudeDrafter(options: ClaudeAuthorOptions = {}) {
  return (input: { pack: EvidencePack; topics: string[] }) =>
    draftCardsWithClaude(input, options);
}

/**
 * The convenience end-to-end call: ONE grounded pack → authored items, using
 * Claude for the text and the deterministic glue for everything else.
 *
 * Mirrors {@link evidencePackToItems}'s signature/behaviour (same `id`, same
 * 0–2 items out, same skip-when-no-answer), but does the authoring with Claude
 * instead of the placeholder {@link AuthorFn}. Implementation: derive topics,
 * await the drafts, then feed them through the sync glue via a resolved-closure
 * author so all identity/citation/complexity logic stays in one place.
 */
export async function evidencePackToItemsWithClaude(
  pack: EvidencePack,
  options: ClaudeAuthorOptions & { id?: number | string } = {},
): Promise<AuthoredItem[]> {
  // Skip the API call entirely when there's no worked answer to teach from —
  // matches passthroughAuthor's guard.
  if (!(pack.answer ?? "").trim()) return [];

  const topics = deriveTopics(pack.question);
  const drafts = await draftCardsWithClaude({ pack, topics }, options);

  // Resolved-closure author: the sync seam expects (input) => drafts; we already
  // have the drafts, so ignore the input and return them. The glue re-derives
  // the same topics internally.
  const resolved: AuthorFn = () => drafts;
  return evidencePackToItems(pack, { id: options.id, author: resolved });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function toDrafts(parsed: ParsedDrafts): AuthoredDrafts {
  return {
    cloze: parsed.cloze
      ? {
          front: parsed.cloze.front,
          back: parsed.cloze.back,
          context: parsed.cloze.context ?? undefined,
        }
      : null,
    mcq: parsed.mcq
      ? {
          stem: parsed.mcq.stem,
          options: parsed.mcq.options.map((o) => ({
            text: o.text,
            isCorrect: o.isCorrect,
            explanation: o.explanation ?? undefined,
          })),
          explanation: parsed.mcq.explanation ?? undefined,
        }
      : null,
  };
}

function buildPrompt(pack: EvidencePack, topics: string[]): string {
  const parts: string[] = [
    `QUESTION:\n${pack.question.trim()}`,
    `WORKED ANSWER:\n${(pack.answer ?? "").trim() || "(none)"}`,
  ];
  if (pack.reasoning?.trim()) parts.push(`REASONING:\n${pack.reasoning.trim()}`);
  if (pack.confidence) parts.push(`ANSWER CONFIDENCE: ${pack.confidence}`);
  parts.push(`EVIDENCE:\n${formatEvidence(pack)}`);
  if (topics.length) parts.push(`SUGGESTED TOPICS (refine if needed): ${topics.join(", ")}`);
  parts.push(
    "Author the cloze and MCQ from the above. Return null for either type if the evidence can't support a clean card of that type.",
  );
  return parts.join("\n\n");
}

function formatEvidence(pack: EvidencePack): string {
  const passages = (pack.evidence ?? []).filter((e) => e.text.trim());
  if (!passages.length) {
    // Ledger evidence often carries source metadata but no rehydrated passage
    // text. Tell the model to lean on the worked answer/reasoning and not invent.
    const sources = (pack.evidence ?? [])
      .map((e, i) => `[${i + 1}] (${e.source.tier}) ${sourceCite(e.source.doi, e.source.slug)} ${e.source.title}`)
      .join("\n");
    return sources
      ? `(passage text not available — sources listed for citation only; rely on the worked answer/reasoning above and do NOT invent specifics)\n${sources}`
      : "(no evidence passages — rely on the worked answer/reasoning above and do NOT invent specifics)";
  }
  return passages
    .map((e, i) => {
      const head = `[${i + 1}] (${e.source.tier}; ${sourceCite(e.source.doi, e.source.slug)}) ${e.source.title}`;
      return `${head}\n${e.text.trim()}`;
    })
    .join("\n\n");
}

function sourceCite(doi: string | undefined, slug: string | undefined): string {
  if (doi) return `doi:${doi}`;
  if (slug) return slug;
  return "no-id";
}
