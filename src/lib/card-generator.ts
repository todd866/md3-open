/**
 * Card Generator — Parses MDX content and extracts cloze-deletion cards
 *
 * Extraction policy: EXPLICIT Q&A ONLY
 * - <Mnemonic> -> One card per bold term in list items
 * - <KeyPoint> -> Card from **Q:** / **A:** format only
 * - <Danger> -> Card from **Q:** / **A:** format only
 * - <ClinicalPearl> -> Card from **Q:** / **A:** format only
 *
 * Components without Q&A format are teaching-only and produce no card.
 */

import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

export interface GeneratedCard {
  cardType: 'cloze';
  rotation: string;
  week: number | null;
  sourceFile?: string;
  sourceComponent: 'Mnemonic' | 'KeyPoint' | 'Danger' | 'ClinicalPearl';
  front: string;
  back: string;
  backs?: string[];
  context?: string;
  topics: string[];
  complexity: 1 | 2 | 3;
}

// ─── Heading Extraction ───────────────────────────────────────────

type Heading = { index: number; level: number; text: string; topics: string[] };

function extractHeadings(content: string): Heading[] {
  const headings: Heading[] = [];
  const pattern = /^(#{1,6})\s+(.+?)\s*$/gm;
  for (const match of content.matchAll(pattern)) {
    const level = match[1]?.length ?? 0;
    const rawText = match[2] ?? '';
    const index = match.index ?? 0;
    const topics = rawText.split(/[^A-Za-z0-9]+/).filter(w => w.length >= 3);
    headings.push({ index, level, text: rawText.trim(), topics });
  }
  return headings.sort((a, b) => a.index - b.index);
}

function topicsForIndex(headings: Heading[], index: number): string[] {
  const collected: string[] = [];
  let currentLevel = Infinity;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.index >= index) continue;
    if (h.level >= currentLevel) continue;
    currentLevel = h.level;
    collected.push(...h.topics);
    if (currentLevel <= 1) break;
  }
  return [...new Set(collected)];
}

function contextForIndex(headings: Heading[], index: number): string | undefined {
  const pathParts: string[] = [];
  let currentLevel = Infinity;
  for (let i = headings.length - 1; i >= 0; i--) {
    const h = headings[i];
    if (h.index >= index) continue;
    if (h.level >= currentLevel) continue;
    currentLevel = h.level;
    pathParts.unshift(h.text);
    if (currentLevel <= 1) break;
  }
  return pathParts.length > 0 ? pathParts.join(' > ') : undefined;
}

// ─── Utility Functions ────────────────────────────────────────────

function stripMdxComponents(text: string): string {
  return text
    .replace(/<[A-Z][a-zA-Z]*[^>]*>([^<]*)<\/[A-Z][a-zA-Z]*>/g, '$1')
    .replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '')
    .replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

function extractStringAttr(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
  const match = attrs.match(pattern);
  return match?.[1] ?? match?.[2] ?? undefined;
}

function extractWeekFromFilename(filename: string): number | null {
  const match = filename.match(/week(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

// ─── Q&A Pair Extraction ──────────────────────────────────────────

function parseQAPairs(content: string): Array<{ question: string; answer: string }> {
  const qaRegex = /\*\*Q:\*\*\s*([\s\S]*?)\s*\*\*A:\*\*\s*([\s\S]*?)(?=\s*\*\*Q:\*\*|\s*$)/gi;
  const pairs: Array<{ question: string; answer: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = qaRegex.exec(content)) !== null) {
    pairs.push({ question: m[1].trim(), answer: m[2].trim() });
  }
  return pairs;
}

// ─── Complexity Calculation ───────────────────────────────────────

function calculateComplexity(
  sourceComponent: string,
  answer: string,
  front: string
): 1 | 2 | 3 {
  const answerWordCount = answer.trim().split(/\s+/).length;
  const hasNumbers = /\d/.test(answer);

  if (sourceComponent === 'Mnemonic') {
    if (/stands for \[___\]/.test(front) && answerWordCount <= 3) return 1;
    return answerWordCount <= 3 && !hasNumbers ? 1 : 2;
  }

  if (sourceComponent === 'KeyPoint') {
    if (answerWordCount <= 2 && !hasNumbers) return 1;
    return 2;
  }

  return 2;
}

// ─── Multi-Cloze Splitting ────────────────────────────────────────

function splitListAnswerToMultiCloze(
  card: GeneratedCard
): { front: string; back: string; backs: string[] } | null {
  if (card.cardType !== 'cloze') return null;
  if (card.backs && card.backs.length > 1) return null;

  const blankCount = (card.front.match(/\[___\]/g) ?? []).length;
  if (blankCount !== 1) return null;

  const items = card.back.split(/[,;]/).map(s => s.trim()).filter(s => s.length > 0);
  if (items.length < 3) return null;

  const allShort = items.every(item => item.split(/\s+/).length <= 4);
  if (!allShort) return null;

  const blanks = items.map(() => '[___]').join(', ');
  const front = card.front.replace('[___]', blanks);

  return { front, back: card.back, backs: items };
}

// ─── Component Extractors ─────────────────────────────────────────

function extractComponentBlocks(content: string, tag: string): Array<{ index: number; attrs: string; body: string }> {
  const pattern = new RegExp(`<${tag}([^>]*)>([\\s\\S]*?)<\\/${tag}>|<${tag}([^>]*?)\\s*\\/>`, 'g');
  const blocks: Array<{ index: number; attrs: string; body: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    blocks.push({
      index: m.index,
      attrs: m[1] ?? m[3] ?? '',
      body: m[2] ?? '',
    });
  }
  return blocks;
}

function extractMnemonicCards(content: string, rotation: string, week: number | null, headings: Heading[]): GeneratedCard[] {
  const cards: GeneratedCard[] = [];
  const blocks = extractComponentBlocks(content, 'Mnemonic');

  for (const block of blocks) {
    const title = extractStringAttr(block.attrs, 'title');
    const context = title || contextForIndex(headings, block.index);
    const topics = topicsForIndex(headings, block.index);
    const body = stripMdxComponents(block.body);

    // Try Q&A pairs first
    const qaPairs = parseQAPairs(body);
    if (qaPairs.length > 0) {
      for (const qa of qaPairs) {
        cards.push({
          cardType: 'cloze',
          rotation, week,
          sourceComponent: 'Mnemonic',
          front: qa.question,
          back: qa.answer,
          context,
          topics,
          complexity: calculateComplexity('Mnemonic', qa.answer, qa.question),
        });
      }
      continue;
    }

    // Mnemonic list items: "- **Bold** = rest"
    const listPattern = /[-*]\s+\*\*(.+?)\*\*\s*(?:[:=\u2013\u2014-]\s*)?(.+)/g;
    let lm: RegExpExecArray | null;
    while ((lm = listPattern.exec(body)) !== null) {
      const answer = lm[1].trim();
      const description = lm[2].trim();
      cards.push({
        cardType: 'cloze',
        rotation, week,
        sourceComponent: 'Mnemonic',
        front: `${title ? title + ': ' : ''}[___] \u2014 ${description}`,
        back: answer,
        context,
        topics,
        complexity: calculateComplexity('Mnemonic', answer, description),
      });
    }
  }

  return cards;
}

/**
 * Generic extractor for Q&A-based components (KeyPoint, Danger, ClinicalPearl).
 * All three share the same extraction logic -- only the tag name, source component
 * label, and complexity calculation differ.
 */
interface ComponentCardConfig {
  tagName: string;
  sourceComponent: 'KeyPoint' | 'Danger' | 'ClinicalPearl';
  getComplexity: (answer: string, question: string) => 1 | 2 | 3;
}

function extractComponentCards(
  content: string,
  rotation: string,
  week: number | null,
  headings: Heading[],
  config: ComponentCardConfig,
): GeneratedCard[] {
  const cards: GeneratedCard[] = [];
  const blocks = extractComponentBlocks(content, config.tagName);

  for (const block of blocks) {
    const body = stripMdxComponents(block.body);
    const qaPairs = parseQAPairs(body);
    if (qaPairs.length === 0) continue; // Teaching-only, no card

    const title = extractStringAttr(block.attrs, 'title');
    const context = title || contextForIndex(headings, block.index);
    const topics = topicsForIndex(headings, block.index);

    for (const qa of qaPairs) {
      cards.push({
        cardType: 'cloze',
        rotation, week,
        sourceComponent: config.sourceComponent,
        front: qa.question,
        back: qa.answer,
        context,
        topics,
        complexity: config.getComplexity(qa.answer, qa.question),
      });
    }
  }

  return cards;
}

// ─── Public API ───────────────────────────────────────────────────

/**
 * Parse a single MDX file and extract all cloze cards
 */
export function parseContentFile(filePath: string, rotation: string): GeneratedCard[] {
  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const { data, content } = matter(rawContent);
  const filename = path.basename(filePath);
  const sourceFile = path.basename(filePath, path.extname(filePath));
  const week = extractWeekFromFilename(filename);
  const headings = extractHeadings(content);

  const cards: GeneratedCard[] = [];

  cards.push(...extractMnemonicCards(content, rotation, week, headings));
  cards.push(...extractComponentCards(content, rotation, week, headings, {
    tagName: 'KeyPoint',
    sourceComponent: 'KeyPoint',
    getComplexity: (answer, question) => calculateComplexity('KeyPoint', answer, question),
  }));
  cards.push(...extractComponentCards(content, rotation, week, headings, {
    tagName: 'Danger',
    sourceComponent: 'Danger',
    getComplexity: () => 2,
  }));
  cards.push(...extractComponentCards(content, rotation, week, headings, {
    tagName: 'ClinicalPearl',
    sourceComponent: 'ClinicalPearl',
    getComplexity: () => 2,
  }));

  // Post-process: split list answers + add sourceFile + title context
  const fileTitle = typeof data.title === 'string' ? data.title : undefined;
  return cards.map(card => {
    const split = splitListAnswerToMultiCloze(card);
    const processed = split ? { ...card, front: split.front, back: split.back, backs: split.backs } : card;
    return {
      ...processed,
      sourceFile,
      context: processed.context || fileTitle || undefined,
    };
  });
}

/**
 * Parse all MDX files in a rotation directory
 */
export function parseRotationContent(contentDir: string, rotation: string): GeneratedCard[] {
  if (!fs.existsSync(contentDir)) return [];
  const files = fs.readdirSync(contentDir).filter(f => f.endsWith('.mdx'));
  const cards: GeneratedCard[] = [];
  for (const file of files) {
    cards.push(...parseContentFile(path.join(contentDir, file), rotation));
  }
  return cards;
}
