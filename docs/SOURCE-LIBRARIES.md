# Source libraries — the SOURCE and GROUND stages

The card-authoring kit under `src/lib/authoring/` is the *generate → quality-gate
→ structure → audit* tail of a longer pipeline. The first two stages —
**SOURCE** (where raw material comes from) and **GROUND** (turning a clinical
question into cited evidence) — do not live in this repo. They live in separate,
mostly-Python repositories on the same machine, and Claude Code reaches them by
running their CLIs and reading the files they emit.

This is deliberate. The pipeline spans a language boundary on purpose:

```
  PYTHON (durable hoards + retrieval + validity)        TYPESCRIPT (this repo)
 ┌───────────────────────────────────────────┐  ┌──────────────────────────────┐
 │ PaperLibrary   ImageLibrary   content_lake │  │  generate → quality → struct │
 │       │             │              │       │  │            → audit           │
 │       └─────┬───────┴──────┬───────┘       │  │                              │
 │          paperscope     LocalEvidence ─────┼──┼─▶ EvidencePack → AuthoringCard│
 │       (validity)        (/api/ask, pack)   │  │                              │
 └───────────────────────────────────────────┘  └──────────────────────────────┘
```

Claude Code is what stitches across that boundary: it runs a Python step, reads
its JSON/JSONL/Markdown output, and feeds the relevant shape into the TS kit. The
**durable API** is the data contract in
[`src/lib/authoring/contracts.ts`](../src/lib/authoring/contracts.ts) —
specifically `EvidencePack`, `EvidencePassage`, and `SourceRef`. Everything
below is reference implementation you are expected to fork, swap out, or rebuild
(in any language) as long as it keeps producing those shapes.

> **You do not need any of these repos to run md3-open.** They are how *grounded*
> curriculum is minted upstream. If you only want to study or author cards by
> hand, skip this doc. If you want to "spool up your own" grounded card factory,
> this is the map.

---

## The recurring pattern: ingest everything, gate at serve time

Every source library here is built on one idea, and it is worth stating up front
because it is the load-bearing design decision:

> **Ingest everything into a durable hoard. Put the lawfulness / openness gate
> downstream, at the single point where content leaves for serving — never at
> ingestion.**

The hoard is allowed to contain copyrighted, mixed-license, and unknown-provenance
material, because acquisition and retrieval are research/fair-dealing activities
and because filtering at ingestion throws away provenance you can never recover.
What is *served* — what reaches md3 and its users — passes through exactly one
gate that admits only the lawful/open subset.

**The worked example is ImageLibrary's `usage_tier` gate** (see its section
below). Every image is stored with `usage_tier ∈ {open, copyright, unknown}`. The
corpus ingests all three. A single module, `export_to_md3.py`, is hard-wired to
`usage_tier='open'` and *refuses* to widen even if a caller asks:

```python
ALLOWED_TIERS = ("open",)   # the gate. Do not widen without a licensing review.

def build_export_manifest(lib, out_dir, *, tiers=ALLOWED_TIERS):
    if tuple(tiers) != ALLOWED_TIERS:
        raise ValueError(f"export is hard-limited to {ALLOWED_TIERS}; refused {tiers!r}")
    ...
```

The same shape recurs elsewhere: PaperLibrary keeps full text of paywalled papers
for personal retrieval but has an `--oa-only` / `OA_ONLY=1` lane that never touches
Anna's Archive or Sci-Hub; ImageLibrary's `card_match.py` has a `SERVE_TIER`
switch that defaults to the auth-gated `copyright` lane and must be set to `open`
to surface public images. **When you fork this stack, replicate the pattern, not
the specific tiers:** the hoard is permissive, and there is exactly one auditable
chokepoint that decides what is lawful to serve.

---

## PaperLibrary — the durable paper store

**What it is.** A permanent, local-first personal paper library: one SQLite
catalog plus one PDF/text store, deduped by DOI / MD5 / PMID, so any paper pulled
anywhere on the machine lands here once and is never re-fetched. Acquisition
cascades through catalog hit → Unpaywall OA → Europe PMC → Anna's Archive → libgen
→ Sci-Hub, with each candidate PDF DOI/title-verified before storage (a hard-won
guard: an ungated run once filed a 2005 Platelets paper as two different ALS
refs). It is the corpus that LocalEvidence grows and queries, and the place
ImageLibrary points at when a figure's source document is already held.

**Where it lives.** `~/Projects/PaperLibrary` (separate git repo, used as a local
safety net rather than a publish target). Entry point: `library.py`.

**Its contract (what the kit consumes).** PaperLibrary does not produce cards or
`EvidencePack`s directly — it is the *substrate* under GROUND. Downstream, the
papers it holds surface in two contract shapes:
- A held paper maps to a `SourceRef` (`doi`, `title`, `tier`, `year`, `journal`)
  via its catalog metadata (`catalog.jsonl` carries DOI/title/source; CrossRef
  backfill fills the rest).
- Its extracted text (`text/`) is what LocalEvidence chunks into the
  `EvidencePassage[]` of a pack, and what paperscope validates.

The hoard/gate pattern here: the full store is for personal retrieval; the
`--oa-only` lane (`library.py pull --oa-only`, `OA_ONLY=1`, `harvest.sh run-oa`)
is the open subset that never invokes the paywalled acquisition steps.

**How Claude Code runs it as a step.**
```bash
# Is a paper already held? Pull it if not (idempotent; auto-extracts text).
python3 ~/Projects/PaperLibrary/library.py have   10.1007/s00431-022-04458-z
python3 ~/Projects/PaperLibrary/library.py pull   10.1007/s00431-022-04458-z --title "..."

# Semantic search over everything held (the corpus you draw cards from).
python3 ~/Projects/PaperLibrary/library.py search "neonatal sepsis empiric antibiotics" -k 10

# Open-access-only acquisition (zero IP friction; safe to run unattended).
OA_ONLY=1 python3 ~/Projects/PaperLibrary/library.py pull <doi>
```
In practice Claude Code rarely calls PaperLibrary directly during authoring — it
calls LocalEvidence, which grows PaperLibrary as a side effect. You reach for the
`library.py` CLI when you want to pre-warm a corpus or check coverage before a
curriculum run.

---

## ImageLibrary — the durable medical-image store (worked example of the gate)

**What it is.** A permanent, local-first medical-image corpus: one SQLite catalog
plus one image store, deduped by SHA-256 (exact) and a perceptual hash (near-dups
— re-encodes, resizes, crops of the same finding). Every image harvested from the
web or imported from a local stash (Anki decks, folders, textbook PDFs) lands here
once, **with its provenance and license recorded**. It is the sibling of
PaperLibrary for figures; PDFs live in PaperLibrary, figures live here, and when a
figure's source document is already a held paper/book it is referenced by file MD5
rather than re-copied.

**Where it lives.** `~/Projects/ImageLibrary` (separate git repo). Entry point:
`library.py`; the serving gate is `export_to_md3.py`.

**The `usage_tier` gate — the canonical instance of the pattern.** Every image
row carries `usage_tier ∈ {open, copyright, unknown}` (`open` = CC / public domain,
e.g. Wikimedia, OpenStax; `copyright` = textbooks; `unknown` = mixed-provenance Anki
imports). The corpus ingests all tiers freely — license filtering *never* happens
in the lake. The decision about what md3 may serve is made *later and in exactly
one place*: `export_to_md3.py`, hard-wired to `usage_tier='open'` and refusing to
widen via a caller argument (see the code in the pattern section above). Nothing
`copyright`/`unknown` can leave for serving. This module already wires
open-licensed images into md3: it emits `export-manifest.jsonl` (one JSON line per
eligible open image) carrying exactly the fields md3's figure pipeline needs —
`local_path`, `condition`, `modality`, `caption`, `tags`, `license`,
`attribution`, `source`, `source_url`. Wiring that manifest into md3's
figure-sidecars/R2 is a separate, deliberate step; `export_to_md3.py` never
touches md3 directly.

**The matchers (`card_match.py`, `caption_match.py`).** These decide *which* image
illustrates a given card — the bridge from the image hoard to an authored card:
- `card_match.py` — a modality-coherence visual-concept classifier over BiomedCLIP
  neighbours. A card tests an inherently *visual* finding iff its top-K image
  neighbours agree on modality; `coherence()` is the pure, model-free decision and
  the rest is orchestration that emits per-card candidate images for agent review.
  It has its own instance of the gate: `SERVE_TIER` (env, default `copyright`)
  chooses which lane to surface picks from, and a `JUNK_IMAGE_CLASSES` set keeps
  text-pages, line diagrams, and montages out of picks.
- `caption_match.py` — the second, higher-precision gate the matchers add: only
  match a card to an image when the image's own textbook *caption* names the card's
  finding. (It rejects, e.g., a mislabeled STEMI overlay that CLIP similarity alone
  would have retrieved, because the caption contains no "STEMI".)

**Its contract (what the kit consumes).** The export manifest's per-image fields
are what an authored card's image sidecar needs; the matchers produce
`{stableId, matches:[…]}` candidate sets keyed by the card's `stableId` (the same
`stableId` an `AuthoringCard` carries in `contracts.ts`). There is no first-class
"image" type in `contracts.ts` today — images attach to a card by `stableId`, so
the manifest and the kit meet at that identity.

**How Claude Code runs it as a step.**
```bash
# Ingest (the hoard takes everything, regardless of license).
python3 ~/Projects/ImageLibrary/library.py import-anki ~/Downloads          # .apkg decks
python3 ~/Projects/ImageLibrary/library.py import-pdf  ~/Desktop/textbooks  # figures+captions
python3 ~/Projects/ImageLibrary/library.py embed                            # BiomedCLIP, incremental

# Match cards to images (dump cards from md3 first; see card_match.py header).
python3 ~/Projects/ImageLibrary/card_match.py    --cards /tmp/visual-cards.json --out /tmp/visual-candidates.json
python3 ~/Projects/ImageLibrary/caption_match.py --out /tmp/caption-candidates.json

# The ONE serving gate: open-tier images only.
python3 ~/Projects/ImageLibrary/export_to_md3.py --out export   # -> export/export-manifest.jsonl
```

---

## LocalEvidence — the GROUND engine (produces the EvidencePack seed)

**What it is.** A local-first clinical-evidence workbench — an OpenEvidence-style
reference tool that runs from the laptop against the personally curated
PaperLibrary corpus. This is the heart of the GROUND stage: it takes a clinical
*question* and runs **discover → triage → acquire → index → pack → ledger**,
producing a grounded evidence pack that the kit's GENERATE stage turns into cards.
Crucially, **it grows PaperLibrary as it goes** — acquisition dedupes at the
PaperLibrary level, so the corpus compounds and the second similar question is
fast.

The five stages (each writes a JSON checkpoint; `--resume` reuses them):
1. **discover** — OpenAlex, relevance-ranked, abstracts only (no downloads).
2. **triage** — embed abstracts (MiniLM), score `relevance × evidence-tier`,
   dedupe against PaperLibrary, select the top-N *missing* papers.
3. **acquire** — `PaperLibrary.library.pull` cascade (dedup → Unpaywall → Europe
   PMC → Anna's → Sci-Hub), each PDF DOI/title-verified, catalogued, text-extracted.
4. **index** — chunk full text → SQLite FTS5 (BM25) + dense MiniLM, fused by
   Reciprocal Rank Fusion; reference-list/table chunks dropped.
5. **pack** — ranked passages grouped by source + a coverage report + a gap log of
   what was wanted but not retrieved.

**A note on speed (relevant to curriculum generation).** LocalEvidence is slow
*only on a cold corpus*, because the first question on a new topic is fetching
papers. Warm-corpus answers are fast (sub-5s for retrieval), because acquisition
already deduped into PaperLibrary. Curriculum generation is async anyway: ask the
questions, let the corpus warm, then mint cards against the packs. The phone face
even queues a novel question (`ledger/queue.jsonl`) for a later deep run rather
than blocking on synthesis.

**Where it lives.** `~/Projects/LocalEvidence` (separate git repo). It runs both
as a CLI (`python3 -m localevidence ask …`) and as a warm local **service**
(`python3 -m localevidence serve` on `http://127.0.0.1:8765`, bound to localhost
by default). The service exposes the answer loop (`/api/ask`) and an
evidence-verification endpoint (`/api/verify-evidence`) — the same endpoints the
kit's AUDIT stage can call to check an authored claim against the corpus.

**Its contract (what the kit consumes) — this is the key seam.** A LocalEvidence
ledger entry (`ledger/answers.jsonl`) maps almost field-for-field onto the
`EvidencePack` contract in `contracts.ts`:

| LocalEvidence ledger field | `EvidencePack` field |
|----------------------------|----------------------|
| `question`                 | `question`           |
| `answer`                   | `answer`             |
| `reasoning`                | `reasoning`          |
| `confidence` (high/moderate/low) | `confidence`   |
| `evidence` (ranked passages, grouped by source) | `evidence: EvidencePassage[]` |
| `gaps` (DOIs wanted, not retrieved) | `gaps: SourceRef[]` |

Each passage carries its text, its source (→ `SourceRef`, with the triage stage's
evidence tier), and a fused retrieval score (→ `EvidencePassage.score`). A
freshly-retrieved entry may have null `answer`/`reasoning`/`confidence` (synthesis
happens after retrieval) — which is exactly why those fields are nullable in the
contract. **The `EvidencePack` is the curriculum SEED.** GENERATE consumes it;
AUDIT later re-checks each authored claim against the same evidence, producing
`GroundingResult` (`supported` / `contradicted` / `unsupported`, with `gap: true`
distinguishing a real defect from a corpus hole).

**How Claude Code runs it as a step.**
```bash
# One-shot grounding of a question -> evidence pack (the seed for cards).
python3 -m localevidence ask \
  "In anorexia nervosa with bradycardia, what HR threshold warrants admission?" \
  -q "eating disorder inpatient admission cardiovascular" --top-n 15 --passages 12
# -> projects/<slug>/runs/<run_id>/evidence-pack.md  (+ a ledger/answers.jsonl entry)

# Warm the corpus over a topic's worth of questions (async curriculum prep).
python3 -m localevidence load --topic eating-disorders --top-n 12

# Or run it as a warm service and hit the API (GROUND + AUDIT seams).
python3 -m localevidence serve            # http://127.0.0.1:8765
#   POST /api/ask              -> grounded answer + evidence (the EvidencePack shape)
#   POST /api/verify-evidence  -> faithfulness check (the GroundingResult shape)
```

The transform Claude Code performs across the boundary: run `ask` (or POST
`/api/ask`), read the ledger entry / pack JSON, coerce it into an `EvidencePack`,
hand it to the kit's GENERATE stage, then close the loop by POSTing each drafted
claim to `/api/verify-evidence` for the AUDIT stage.

---

## paperscope — source ingestion, extraction/chunking, and validity vetting

**What it is.** An AI-assisted toolkit for academic-paper analysis at both
manuscript and corpus scale. In this pipeline it plays two roles. First, it is the
**ingestion / text-extraction / chunking** layer the durable libraries are built
on: PaperLibrary is explicitly the permanent-library pattern sitting on top of
paperscope's acquisition, PDF text extraction (PyMuPDF), and embeddings (the
`examples/permanent-library/` skeleton is the reference for exactly this). Second,
it is the **validity layer** that vets a source before its claims are trusted in a
card:
- `forensic_stats` — 19 data-integrity checks (GRIM, GRIMMER, DEBIT, SPRITE,
  correlation bounds, p-value recalculation, Carlisle/Stouffer–Fisher, Benford,
  variance ratios, arithmetic consistency, …). A Python *library*, not a CLI:
  you transcribe a paper's summary statistics and feed them in; results classify
  as pass / flag / fail.
- `critical-read` (the **audit_router** and **overclaiming** analyses) — author /
  COI profiling, method-resolution mismatch detection, missing complementary
  methods, and overclaiming detection on an external paper's PDF.

**Where it lives.** `~/Projects/paperscope` (its own public git repo,
`todd866/paperscope`, MIT). Also vendored into this program's peer-review tree as a
submodule, but the canonical copy is `~/Projects/paperscope`.

**Its contract (what the kit consumes).** paperscope's output is not a card type —
it gates whether a source earns its place in a pack. Operationally it sharpens the
`SourceRef.tier` assigned during triage and flags sources whose statistics or
claims are unsound, so that GROUND does not seed a card from a paper that
forensics or overclaiming analysis would reject. Think of it as the quality filter
on the *inputs* to the pipeline, the mirror image of the kit's own
quality-gate/audit stages on the *outputs*.

**How Claude Code runs it as a step.**
```bash
# Vet a candidate source PDF before trusting its claims in a card.
python3 -m paperscope critical-read /path/to/source.pdf      # author COI, resolution, overclaiming

# Forensic checks on a table of summary statistics (Python, not CLI).
python3 -c "from paperscope.analysis.forensic_stats import grim; print(grim(mean=26.9, n=26, dp=1))"

# Ingest + extract text from a folder of open-access PDFs (feeds the corpus).
python3 -m paperscope ingest /path/to/literature/
```

---

## content_lake — transcript / textbook ingestion

**What it is.** A staging database for *non-paper* learning content before it
enters the authoring pipeline: lecture transcripts, textbook PDF extractions, Anki
decks, Canvas exports, and MDX. Its schema models `sources` (an `anki_deck`,
`pdf_extracted`, `transcript`, `canvas`, or `mdx` origin, tagged by rotation) and
`items` (individual `card` / `chunk` / `page` / `question` / `image` units within
a source, each with content, optional media refs, and a status as it moves
`discovered → indexed → processed → imported`). Where PaperLibrary holds the
peer-reviewed literature and ImageLibrary holds figures, content_lake holds the
course/teaching material — the raw text that becomes draft cards when no formal
evidence pack is involved.

**Where it lives.** `~/Projects/medicine-data/content_lake` (inside the
`medicine-data` data repo). Entry points include `discover.py`, `embed.py`, the
`indexers/`, and `generate_canvas_cards.py`; `content.db` is the SQLite staging
DB (`schema.sql` defines it).

**The hoard/gate pattern here.** content_lake is itself a staging hoard:
everything harvested lands with `status='discovered'` and a `quality`
(`unknown / verified / needs_review / rejected`) flag, and only material that has
moved through to `imported` (and is license-clear) is promoted into md3 — the
status/quality columns are the gate, the analogue of ImageLibrary's `usage_tier`.

**Its contract (what the kit consumes).** A content_lake `item` of subtype `cloze`
or `mcq` maps onto an `AuthoringCard` / `AuthoringQuestion`: `content` → cloze
`front` / mcq `stem`, `content_back` → `back`, `rotation` → a `topics` entry, and
the source row → a `cite`/`SourceRef`. Chunks (`type='chunk'`) are raw text the
GENERATE stage drafts cards *from* rather than already-formed cards. Either way,
the durable handoff to this repo is an item coerced into the contract types — the
exact same target shape that LocalEvidence's packs reach by a different route.

**How Claude Code runs it as a step.**
```bash
# Discover/index new teaching content into the staging DB.
python3 ~/Projects/medicine-data/content_lake/discover.py
python3 ~/Projects/medicine-data/content_lake/embed.py

# Generate draft cards from harvested course material (e.g. Canvas).
python3 ~/Projects/medicine-data/content_lake/generate_canvas_cards.py
```
The draft items/cards this produces are then handed to the kit's quality-gate and
structure stages for length-bias / format-asymmetry / guessability checks and
complexity/curriculum/citation structuring, exactly as a pack-derived card would
be.

---

## Putting it together: minting grounded curriculum ("spool up your own")

The end-to-end flow, and how the language boundary is crossed at each hop:

1. **SOURCE.** Material accumulates in the durable hoards — papers in
   **PaperLibrary**, figures in **ImageLibrary**, course content in
   **content_lake** — each ingesting permissively, each with a downstream gate
   (`--oa-only`, `usage_tier`, `status/quality`).
2. **GROUND.** **LocalEvidence** takes a clinical question, retrieves and (if
   needed) acquires evidence into PaperLibrary, and emits an `EvidencePack` — the
   curriculum seed. **paperscope** vets the sources feeding it (forensics +
   overclaiming) and supplies the ingestion/chunking the libraries stand on.
3. **GENERATE → QUALITY-GATE → STRUCTURE → AUDIT.** This repo's kit turns a pack
   (or a content_lake item) into `AuthoringCard`/`AuthoringQuestion`s, runs the
   quality gates, structures them (complexity, curriculum, citations), and AUDITs
   each claim back against LocalEvidence's `/api/verify-evidence`.

To stand up your own grounded card factory: clone md3-open, bring up Postgres and
the Next app, run **LocalEvidence as a service alongside it** (`/api/ask` and
`/api/verify-evidence` on `:8765`), warm a corpus (`localevidence load` over your
topics — slow once, fast forever after), and let the LocalEvidence → card
transform mint grounded curriculum. The libraries above are the reference
implementations of each upstream stage; because the durable API is the contract in
`contracts.ts`, you can rebuild any one of them — in any language — and the kit
will not notice, as long as the shapes still flow.
