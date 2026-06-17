/**
 * Curriculum docs loader (file I/O, DB-free).
 *
 * The production md3 `curriculum/index.ts` was a calendar engine: hard-coded
 * `USYD_MD1_2026` / `USYD_MD2_2026` definitions plus date-math that mapped a
 * `Date` to the current academic week / assessment period. None of that ports
 * — it is institution-specific data, not reusable logic.
 *
 * What this kit keeps is the part that is genuinely reusable for authoring:
 * loading curriculum documents (week topics + learning objectives) from
 * markdown files, plus the pure tag/topic helpers that turned a deck tag into
 * a module path. No database, no scheduler, no bundled program data.
 */

import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";

/** A curriculum unit parsed from one markdown doc. */
export interface CurriculumDoc {
  /** Source file path, when loaded from disk. */
  sourceFile?: string;
  program?: string;
  block?: string;
  /** Academic week number, if declared in frontmatter. */
  week?: number;
  title: string;
  topics: string[];
  learningObjectives: string[];
  /** Raw markdown body with frontmatter stripped. */
  body: string;
}

// ─── Markdown parsing ────────────────────────────────────────────────────────

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[;,]/)
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
  }
  return [];
}

/**
 * Extract learning objectives from a markdown body. Recognises either an
 * explicit `## Learning Objectives` section (collecting its list items) or a
 * `- LO:` / `- Objective:` prefixed bullet anywhere in the body.
 */
export function extractLearningObjectives(body: string): string[] {
  const objectives: string[] = [];
  const lines = body.split("\n");

  let inLoSection = false;
  for (const line of lines) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      inLoSection = /learning objectives?|objectives?/i.test(heading[1]);
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    const text = bullet[1].trim();

    const prefixed = text.match(/^(?:LO|Objective)\s*[:.-]\s*(.+)$/i);
    if (prefixed) {
      objectives.push(prefixed[1].trim());
    } else if (inLoSection && text.length > 0) {
      objectives.push(text);
    }
  }

  return [...new Set(objectives)];
}

/** Derive topic slugs from `## ` / `### ` headings in a markdown body. */
export function extractTopicsFromHeadings(body: string): string[] {
  const topics: string[] = [];
  const pattern = /^#{2,4}\s+(.+?)\s*$/gm;
  for (const match of body.matchAll(pattern)) {
    const text = (match[1] ?? "").trim();
    if (!/learning objectives?|objectives?/i.test(text) && text.length > 0) {
      topics.push(text);
    }
  }
  return [...new Set(topics)];
}

/** Parse a single curriculum markdown string (frontmatter + body). */
export function parseCurriculumDoc(content: string, sourceFile?: string): CurriculumDoc {
  const { data, content: body } = matter(content);

  const fmTopics = asStringArray(data.topics);
  const topics = fmTopics.length > 0 ? fmTopics : extractTopicsFromHeadings(body);

  const fmObjectives = asStringArray(
    data.learningObjectives ?? data.learning_objectives ?? data.objectives,
  );
  const learningObjectives =
    fmObjectives.length > 0 ? fmObjectives : extractLearningObjectives(body);

  const title =
    (typeof data.title === "string" && data.title.trim()) ||
    (sourceFile ? path.basename(sourceFile, path.extname(sourceFile)) : "Untitled");

  const week =
    typeof data.week === "number"
      ? data.week
      : typeof data.week === "string" && data.week.trim() !== ""
        ? Number(data.week)
        : undefined;

  return {
    sourceFile,
    program: typeof data.program === "string" ? data.program : undefined,
    block: typeof data.block === "string" ? data.block : undefined,
    week: Number.isFinite(week) ? (week as number) : undefined,
    title,
    topics,
    learningObjectives,
    body,
  };
}

/** Load and parse a single curriculum markdown file from disk. */
export function loadCurriculumDoc(filePath: string): CurriculumDoc {
  const content = fs.readFileSync(filePath, "utf8");
  return parseCurriculumDoc(content, filePath);
}

/**
 * Load every `.md` / `.mdx` file under a directory (recursively) as a
 * curriculum doc. Returns them in stable, path-sorted order.
 */
export function loadCurriculumDir(dir: string): CurriculumDoc[] {
  const files: string[] = [];

  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.mdx?$/i.test(entry.name)) {
        files.push(full);
      }
    }
  };

  walk(dir);
  files.sort();
  return files.map((file) => loadCurriculumDoc(file));
}

/** Union the topics for a week across many docs that target that week. */
export function getWeekTopics(docs: CurriculumDoc[], weekNumber: number): string[] {
  const collected: string[] = [];
  for (const doc of docs) {
    if (doc.week === weekNumber) {
      collected.push(...doc.topics);
    }
  }
  return [...new Set(collected)];
}

// ─── Pure tag → curriculum helpers (ported intact) ───────────────────────────

/**
 * Map a deck tag to curriculum info. Parses tags like
 * "AnkiHub_Subdeck::A1_Deck::SMP_YEAR_1::KAT1::MSK::ANAT".
 */
export function parseTagToCurriculum(tag: string): {
  program: "md1" | "md2" | null;
  kat: number | null;
  block: string | null;
  type: string | null;
} {
  const parts = tag.toUpperCase().split("::");

  let program: "md1" | "md2" | null = null;
  let kat: number | null = null;
  let block: string | null = null;
  let type: string | null = null;

  const blockMapping: Record<string, string> = {
    MSK: "msk",
    MUSCULOSKELETAL: "msk",
    RESP: "resp",
    RESPIRATORY: "resp",
    CARDIO: "cardio",
    CARDIOVASCULAR: "cardio",
    RENAL: "renal",
    ENDO: "endo",
    ENDOCRINE: "endo",
    GASTRO: "gastro",
    GASTROINTESTINAL: "gastro",
    NEURO: "neuro",
    NEUROSCIENCE: "neuro",
    NEUROSCIENCES: "neuro",
    FOUNDATION: "foundation",
    FOUNDATIONS: "foundation",
  };

  const typeMapping: Record<string, string> = {
    ANAT: "anatomy",
    ANATOMY: "anatomy",
    PHARM: "pharmacology",
    PHARMACOLOGY: "pharmacology",
    PATH: "pathology",
    PATHOLOGY: "pathology",
    PHYSIO: "physiology",
    PHYSIOLOGY: "physiology",
  };

  for (const part of parts) {
    if (part.includes("YEAR_1") || part.includes("YEAR1")) {
      program = "md1";
    } else if (part.includes("YEAR_2") || part.includes("YEAR2")) {
      program = "md2";
    }

    const katMatch = part.match(/KAT(\d)/);
    if (katMatch) {
      kat = parseInt(katMatch[1], 10);
      // Infer program from KAT number
      if (kat <= 4) program = "md1";
      else program = "md2";
    }

    if (blockMapping[part]) block = blockMapping[part];
    if (typeMapping[part]) type = typeMapping[part];
  }

  return { program, kat, block, type };
}

/**
 * Build module node paths for a card based on curriculum coordinates.
 * `institution` defaults to "usyd" to match the production behaviour.
 */
export function getCurriculumModuleNodes(
  program: "md1" | "md2",
  kat: number | null,
  block: string | null,
  type: string | null,
  institution = "usyd",
): string[] {
  const nodes: string[] = [];
  nodes.push(`${institution}/${program}`);

  if (kat !== null) {
    nodes.push(`${institution}/${program}/kat${kat}`);
    if (block) {
      nodes.push(`${institution}/${program}/kat${kat}/${block}`);
    }
  }

  if (type === "anatomy") {
    nodes.push(`${institution}/${program}/anatomy`);
  }

  return nodes;
}
