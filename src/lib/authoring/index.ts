/**
 * Card-authoring kit — public surface.
 *
 * Pipeline: source → ground → generate → quality-gate → structure → audit.
 * The seam contracts (`./contracts`) are the durable API; everything else here
 * is reference implementation you are meant to fork and have Claude Code rebuild
 * for your own stack. See ../../CLAUDE.md and docs/PIPELINE.md.
 */

// Seam contracts — the durable API.
export * from "./contracts";

// GENERATE — source → draft cards/questions.
export * from "./generate/card-extractors";
export * from "./generate/card-validators";
export * from "./generate/split-cloze-variants";
export * from "./generate/mcq-to-cloze";

// QUALITY — gate authored items.
export * from "./quality/validate-mcq";
export * from "./quality/cloze-quality";
export * from "./quality/distractor-quality";
export * from "./quality/option-guessability";

// STRUCTURE — complexity, curriculum, citations.
export * from "./structure/difficulty";
export * from "./structure/curriculum";
export * from "./structure/cite";

// GROUND — LocalEvidence client + the ledger→card transform.
export * from "./grounding/le-client";
export * from "./grounding/le-to-cards";
