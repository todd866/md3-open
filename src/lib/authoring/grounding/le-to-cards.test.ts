/**
 * Tests for the grounding/le-to-cards kit module.
 *
 * Offline only — no network, no live LocalEvidence. `evidencePackToItems` is
 * exercised with both the built-in `passthroughAuthor` and a custom AuthorFn,
 * and `readLedgerLines` is exercised against a tiny temp answers.jsonl written
 * to the OS temp dir. Inputs are built as contract EvidencePack values.
 */

import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  evidencePackToItems,
  passthroughAuthor,
  leStableId,
  topCite,
  deriveTopics,
  readLedger,
  readLedgerLines,
  type AuthorFn,
} from "./le-to-cards";
import type { AuthoringCard, AuthoringQuestion, EvidencePack } from "../contracts";

// ─── fixtures ────────────────────────────────────────────────────────────────

function pack(overrides: Partial<EvidencePack> = {}): EvidencePack {
  return {
    question: "What is the first-line vasopressor in septic shock?",
    answer: "Noradrenaline is the first-line vasopressor in septic shock.",
    reasoning: "Surviving Sepsis 2021 recommends noradrenaline first.",
    confidence: "high",
    evidence: [
      {
        text: "Noradrenaline is recommended as the first-line vasopressor.",
        source: {
          slug: "surviving-sepsis-2021",
          doi: "10.1007/s00134-021-06506-y",
          title: "Surviving Sepsis Campaign 2021",
          tier: "guideline",
        },
        score: 0.9,
      },
      {
        text: "Vasopressin can be added as a second agent.",
        source: { slug: "uptodate-sepsis", title: "UpToDate Sepsis", tier: "review" },
        score: 0.4,
      },
    ],
    ...overrides,
  };
}

// ─── helper-level units ──────────────────────────────────────────────────────

describe("leStableId / topCite / deriveTopics", () => {
  it("leStableId formats as le:<id>", () => {
    expect(leStableId(42)).toBe("le:42");
    expect(leStableId("abc")).toBe("le:abc");
  });

  it("topCite picks the highest-scoring source's DOI", () => {
    expect(topCite(pack())).toBe("doi:10.1007/s00134-021-06506-y");
  });

  it("topCite falls back to slug, then undefined", () => {
    const slugOnly = pack({
      evidence: [
        { text: "x", source: { slug: "only-slug", title: "t", tier: "other" }, score: 1 },
      ],
    });
    expect(topCite(slugOnly)).toBe("only-slug");
    expect(topCite(pack({ evidence: [] }))).toBeUndefined();
  });

  it("deriveTopics extracts content-ish tokens, dropping stopwords", () => {
    const topics = deriveTopics("What is the first-line vasopressor in septic shock?");
    expect(topics).not.toContain("What");
    expect(topics).not.toContain("the");
    expect(topics).toContain("vasopressor");
    expect(topics.length).toBeLessThanOrEqual(4);
  });
});

// ─── evidencePackToItems with the built-in passthrough author ────────────────

describe("evidencePackToItems (passthroughAuthor default)", () => {
  it("mints a C1 cloze + a C2 MCQ, both carrying le:<id> stableIds and the top cite", () => {
    const items = evidencePackToItems(pack(), { id: 7 });
    expect(items).toHaveLength(2);

    const cloze = items.find((i): i is AuthoringCard => i.cardType === "cloze")!;
    const mcq = items.find((i): i is AuthoringQuestion => i.cardType === "mcq")!;

    expect(cloze).toBeDefined();
    expect(cloze.complexity).toBe(1); // C1
    expect(cloze.front).toContain("[___]");
    expect(cloze.stableId).toBe("le:7:cloze");
    expect(cloze.cite).toBe("doi:10.1007/s00134-021-06506-y");

    expect(mcq).toBeDefined();
    expect(mcq.complexity).toBe(2); // C2
    expect(mcq.stableId).toBe("le:7:mcq");
    expect(mcq.cite).toBe("doi:10.1007/s00134-021-06506-y");
    // labels assigned A, B, ...; exactly one correct
    expect(mcq.options.map((o) => o.label)).toEqual(["A", "B"]);
    expect(mcq.options.filter((o) => o.isCorrect)).toHaveLength(1);
  });

  it("emits nothing for a pack with no worked answer", () => {
    expect(evidencePackToItems(pack({ answer: null }), { id: 1 })).toHaveLength(0);
    expect(passthroughAuthor({ pack: pack({ answer: "" }), topics: [] })).toEqual({
      cloze: null,
      mcq: null,
    });
  });

  it("falls back to a slugified-question id when none is supplied", () => {
    const items = evidencePackToItems(pack());
    const cloze = items.find((i): i is AuthoringCard => i.cardType === "cloze")!;
    expect(cloze.stableId).toMatch(/^le:what-is-the-first-line-vasopressor/);
  });
});

// ─── evidencePackToItems with a custom AuthorFn ──────────────────────────────

describe("evidencePackToItems (custom AuthorFn)", () => {
  it("wires the supplied drafts into contract items with le: identity + top cite", () => {
    const author: AuthorFn = ({ pack: p }) => ({
      cloze: {
        front: "The first-line vasopressor in septic shock is [___].",
        back: "noradrenaline",
        context: p.reasoning ?? undefined,
      },
      mcq: {
        stem: p.question,
        options: [
          { text: "Noradrenaline", isCorrect: true, explanation: "First-line." },
          { text: "Dopamine", isCorrect: false },
          { text: "Adrenaline", isCorrect: false },
        ],
        explanation: "SSC 2021.",
      },
    });

    const items = evidencePackToItems(pack(), { id: 99, author });
    expect(items).toHaveLength(2);

    const cloze = items.find((i): i is AuthoringCard => i.cardType === "cloze")!;
    expect(cloze.back).toBe("noradrenaline");
    expect(cloze.context).toBe("Surviving Sepsis 2021 recommends noradrenaline first.");
    expect(cloze.stableId).toBe("le:99:cloze");

    const mcq = items.find((i): i is AuthoringQuestion => i.cardType === "mcq")!;
    expect(mcq.options.map((o) => o.label)).toEqual(["A", "B", "C"]);
    expect(mcq.options.filter((o) => o.isCorrect)).toHaveLength(1);
    expect(mcq.stableId).toBe("le:99:mcq");
    expect(mcq.cite).toBe("doi:10.1007/s00134-021-06506-y");
  });

  it("drops an invalid MCQ draft (≠1 correct) and a blank cloze draft", () => {
    const badAuthor: AuthorFn = () => ({
      cloze: { front: "  ", back: "x" }, // blank front → dropped
      mcq: {
        stem: "Q?",
        options: [
          { text: "A", isCorrect: true },
          { text: "B", isCorrect: true }, // two correct → dropped
        ],
      },
    });
    expect(evidencePackToItems(pack(), { id: 1, author: badAuthor })).toHaveLength(0);
  });
});

// ─── readLedgerLines / readLedger over a temp answers.jsonl ───────────────────

describe("readLedgerLines (offline temp jsonl)", () => {
  const tmpFiles: string[] = [];

  function writeLedger(lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "le-ledger-"));
    const file = path.join(dir, "answers.jsonl");
    fs.writeFileSync(file, lines.join("\n"), "utf-8");
    tmpFiles.push(file);
    return file;
  }

  afterEach(() => {
    while (tmpFiles.length) {
      const f = tmpFiles.pop()!;
      try {
        fs.rmSync(path.dirname(f), { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it("parses answered entries into id + EvidencePack, normalising tier/confidence", () => {
    const file = writeLedger([
      JSON.stringify({
        id: 5,
        question: "What is the target MAP in septic shock?",
        answer: ">=65 mmHg",
        reasoning: "Per SSC.",
        confidence: "MEDIUM", // → moderate
        evidence: [
          { slug: "ssc", doi: "10.x/y", title: "SSC", tier: "Systematic Review", score: 0.8 },
        ],
        gaps: [{ doi: "10.z/gap", title: "Missing RCT", tier: "rct" }],
      }),
      "", // blank line skipped
      "{ this is not valid json", // malformed line skipped
    ]);

    const lines = readLedgerLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0].id).toBe(5);

    const p = lines[0].pack;
    expect(p.question).toBe("What is the target MAP in septic shock?");
    expect(p.answer).toBe(">=65 mmHg");
    expect(p.confidence).toBe("moderate");
    expect(p.evidence[0].source.tier).toBe("systematic_review");
    expect(p.evidence[0].source.doi).toBe("10.x/y");
    expect(p.evidence[0].score).toBe(0.8);
    expect(p.gaps).toHaveLength(1);
    expect(p.gaps![0].tier).toBe("rct");
  });

  it("skips unanswered entries by default, includes them when asked", () => {
    const file = writeLedger([
      JSON.stringify({ id: 1, question: "Answered?", answer: "yes", evidence: [] }),
      JSON.stringify({ id: 2, question: "Retrieval only?", evidence: [] }),
    ]);

    expect(readLedgerLines(file)).toHaveLength(1);
    expect(readLedger(file)).toHaveLength(1);

    const all = readLedgerLines(file, { includeUnanswered: true });
    expect(all).toHaveLength(2);
    expect(all[1].id).toBe(2);
    expect(all[1].pack.answer).toBeNull();
  });

  it("zips ledger ids into le:<id> items via evidencePackToItems", () => {
    const file = writeLedger([
      JSON.stringify({
        id: 12,
        question: "First-line vasopressor in septic shock?",
        answer: "Noradrenaline is first-line.",
        reasoning: "SSC 2021.",
        evidence: [{ slug: "ssc", doi: "10.1/x", title: "SSC", tier: "guideline", score: 1 }],
      }),
    ]);

    const items = readLedgerLines(file).flatMap(({ id, pack: p }) =>
      evidencePackToItems(p, { id }),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.stableId?.startsWith("le:12:"))).toBe(true);
  });
});
