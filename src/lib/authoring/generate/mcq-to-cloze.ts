/**
 * Derive a cloze reinforcement card from an MCQ.
 *
 * Ported from md3 production (`mcq-to-cloze.ts`). All pure string transformation:
 * no DB, no services. The production `mcqToCloze(stem, answer): string | null`
 * built the cloze *front* string; here `mcqToCloze(q: AuthoringQuestion):
 * AuthoringCard | null` wraps that logic into a contract `AuthoringCard`, carrying
 * over complexity/importance/topics/cite and trimming the answer into the SHORT
 * (1–2 word) `back` span the house rule wants.
 *
 * Returns null when the MCQ shouldn't spawn a cloze (list-type answers, negative
 * stems, answers too long for a blank, or a stem that won't convert cleanly).
 */

import type { AuthoringCard, AuthoringQuestion } from '@/lib/authoring/contracts';

// ─── skip / omit gates ───────────────────────────────────────────────────────

/**
 * MCQ stems that produce bad cloze cards and should stay MCQ-only:
 * "Which of the following" / list-or-set answers / negative stems / answers that
 * would be >2 words as a blank / very long stems.
 */
export function shouldSkipClozeConversion(stem: string, correctAnswerText: string): boolean {
  const s = stem.trim().toLowerCase();

  if (/which of the following/i.test(s)) return true;

  if (/\bwhich\s+(?:set|combination|list|grouping|profile|cluster|panel|triad|tetrad|pentad)\b/i.test(s)) return true;

  if (
    /what\s+is\s+a\s+(?:characteristic|common|typical|classic|frequent|recognised)\s+(?:symptom|feature|sign|finding|manifestation|complication|cause|side.?effect)\s+of/i.test(
      s,
    )
  )
    return true;

  if (/\bNOT\b/.test(stem) || /\bEXCEPT\b/.test(stem) || /\bLEAST\s+likely\b/i.test(s)) return true;

  const isListStem =
    /^(?:what\s+are\b|list\b|name(?:\s+three|\s+two|\s+the)?\b)/i.test(s) ||
    /\bmain\s+(?:risk\s+)?(?:factors?|causes?|organisms?|components?|features?|signs?|symptoms?|complications?|indications?|contraindications?)\b/i.test(
      s,
    ) ||
    /\bwhat\s+are\s+the\b/i.test(s);
  const answerIsList = (correctAnswerText.match(/,/g) ?? []).length >= 1 || /\band\b/i.test(correctAnswerText);
  if (isListStem && answerIsList) return true;

  const trimmed = trimAnswerForCloze(correctAnswerText);
  if (!trimmed) return true;
  if (trimmed.split(/\s+/).length > 2) return true;

  if (stem.length > 500) return true;

  return false;
}

/**
 * MCQs whose correct answer makes even a plain Q/A card low-value
 * ("all/none of the above", or a negative stem whose answer is "all").
 */
export function shouldOmitMcqCard(stem: string, correctAnswerText: string): boolean {
  const answer = correctAnswerText.trim().toLowerCase();
  const question = stem.trim().toLowerCase();

  if (/\b(?:all|none)\s+of\s+(?:the\s+)?above\b/.test(answer)) return true;
  if (/\ball\s+of\s+(?:the\s+)?listed\b/.test(answer)) return true;
  if (/\b(?:not|except|least likely|false)\b/.test(question) && /\ball\b/.test(answer)) return true;

  return false;
}

// ─── answer trimming ─────────────────────────────────────────────────────────

/**
 * Trim a multi-word MCQ answer down to a 1–2 word cloze blank where possible:
 * drop trailing parenthetical / em-dash elaboration / comma-list, then leading
 * articles and trailing punctuation. Returns null for empty or generic fillers.
 */
export function trimAnswerForCloze(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;

  s = s.replace(/\s*\([^)]*\)\s*$/g, '').trim();
  s = s.replace(/\s+[—–-]\s+.*$/, '').trim();
  if ((s.match(/,/g) ?? []).length >= 2) {
    s = s.split(',')[0].trim();
  }
  s = s.replace(/[.,;:!?]+$/, '').trim();
  s = s.replace(/^(?:the|a|an)\s+/i, '').trim();

  if (!s) return null;
  const generics = new Set([
    'yes',
    'no',
    'all',
    'none',
    'true',
    'false',
    'all of the above',
    'none of the above',
    'either',
    'neither',
    'any',
    'some',
  ]);
  if (generics.has(s.toLowerCase())) return null;

  return s;
}

// ─── stem → cloze statement ──────────────────────────────────────────────────

/**
 * Convert an MCQ stem into a cloze statement carrying a `[___]` blank.
 * Returns null when the conversion produces garbage (still a question, or a
 * verbless "[noun]: [___]." fragment).
 */
export function stemToClozeStatement(stem: string): string | null {
  const { scenario, question } = splitStemQuestion(stem);
  const clozeStatement = questionToStatement(question);

  if (/^(?:What|Which|How|When|Why|Where|Who)\s/i.test(clozeStatement)) return null;
  if (
    /^[^.]+:\s*\[___\]\.$/.test(clozeStatement) &&
    !/\b(?:is|are|was|were|has|have|means|requires)\b/i.test(clozeStatement)
  )
    return null;

  if (scenario) return `${scenario}\n\n${clozeStatement}`;
  return clozeStatement;
}

function splitStemQuestion(stem: string): { scenario: string; question: string } {
  const trimmed = stem.trim();
  const lastQ = trimmed.lastIndexOf('?');
  if (lastQ === -1) return { scenario: '', question: trimmed };

  let splitIndex = -1;
  for (let i = lastQ - 1; i >= 0; i--) {
    const ch = trimmed[i];
    if (ch === '\n') {
      splitIndex = i;
      break;
    }
    if (ch === '.') {
      const after = trimmed[i + 1];
      if (after && (after === ' ' || after === '\n')) {
        const before = i > 0 ? trimmed[i - 1] : '';
        const afterChar = trimmed[i + 2] ?? '';
        if (/\d/.test(before) && /\d/.test(after === ' ' ? afterChar : after)) continue;
        const wordBefore = trimmed.slice(Math.max(0, i - 5), i);
        if (/(?:Dr|Mr|Ms|vs|etc|e\.g|i\.e|St|Hb|pH|No|Lt|Rt|mL|mg|mmHg)$/i.test(wordBefore)) continue;
        splitIndex = i;
        break;
      }
    }
  }

  if (splitIndex === -1) return { scenario: '', question: trimmed };

  const scenario = trimmed.slice(0, splitIndex + 1).trim();
  const question = trimmed.slice(splitIndex + 1).trim();
  if (question.length < 10) return { scenario: '', question: trimmed };
  return { scenario, question };
}

function questionToStatement(question: string): string {
  const q = question.trim();

  const directResult = patternMatch(q);
  const directIsFallback = /:\s*\[___\]\.$/.test(directResult);
  if (!directIsFallback) return directResult;

  let prefix = '';
  let inner = q;
  const prefixMatch = q.match(
    /^((?:In|During|After|Following|Before|On|With)\s+[^,?]{4,80}),\s+((?:Which|What|Why|When|How|Where|Who|Identify|Select|Name|List)\b.*)$/i,
  );
  if (prefixMatch) {
    prefix = prefixMatch[1].trim();
    inner = prefixMatch[2].trim();
    if (!inner.endsWith('?')) inner += '?';
  }
  if (!prefix) return directResult;

  const result = patternMatch(inner);
  if (/:\s*\[___\]\.$/.test(result)) return directResult;

  if (result.toLowerCase().includes(prefix.toLowerCase())) return result;
  const lcResult = result.charAt(0).toLowerCase() + result.slice(1);
  return `${prefix}, ${lcResult}`;
}

function patternMatch(question: string): string {
  const q = question.trim();

  // N1: "What [noun] is (most|least|best|first-line) [adj] for [target]?"
  {
    const m = q.match(
      /^What\s+(.+?)\s+is\s+(?:the\s+)?(most|least|best|first[ -]?line|primary|main)\s+(.+?)\s+for\s+(.+?)\s*\?$/i,
    );
    if (m) {
      const noun = m[1].trim();
      const quantifier = m[2].trim().replace(/\s+/g, '-');
      const adj = m[3].trim();
      const target = m[4].trim();
      return `The ${quantifier} ${adj} ${noun} for ${target} is [___].`;
    }
  }

  // N2: "What [noun] is the (best|most|first-line) [adj]?" — without "for"
  {
    const m = q.match(/^What\s+(.+?)\s+is\s+the\s+(best|most|least|first[ -]?line|primary|main)\s+(.+?)\s*\?$/i);
    if (m) {
      const noun = m[1].trim();
      const quantifier = m[2].trim().replace(/\s+/g, '-');
      const adj = m[3].trim();
      return `The ${quantifier} ${adj} ${noun} is [___].`;
    }
  }

  // N3: "X is/are characteristic of which Y?"
  {
    const m = q.match(
      /^(.+?)\s+(is|are)\s+(characteristic|typical|suggestive|pathognomonic|diagnostic|specific)\s+of\s+which\s+(.+?)\s*\?$/i,
    );
    if (m) return `${cap(m[1])} ${m[2]} ${m[3]} of [___].`;
  }

  // N4: stem ends with colon — declarative completion
  if (q.endsWith(':') && q.length <= 120 && !/^(?:What|Which|How|When|Why|Where|Who)\b/i.test(q)) {
    const stripped = q.replace(/:$/, '').trim();
    return `${stripped} [___].`;
  }

  // 12: "In X, what does Y represent?" / "In X, what is the Y?"
  {
    const m = q.match(/^In\s+(.*?),\s+what\s+does\s+(.*?)\s+(represent|stand for|mean|indicate|signify)\s*\?$/i);
    if (m) {
      const verb = m[3] === 'stand for' ? 'stands for' : `${m[3]}s`;
      return `In ${m[1]}, ${m[2]} ${verb} [___].`;
    }
  }
  {
    const m = q.match(/^In\s+(.*?),\s+what\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) return `In ${m[1]}, the ${m[3]} ${m[2]} [___].`;
  }

  // 11: "For X, which/what Y is Z?"
  {
    const m = q.match(/^For\s+(.*?),\s+which\s+(.*?)\s+is\s+(.*?)\s*\?$/i);
    if (m) return `The ${m[2]} ${m[3]} for ${m[1]} is [___].`;
  }
  {
    const m = q.match(/^For\s+(.*?),\s+what\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) return `The ${m[3]} for ${m[1]} ${m[2]} [___].`;
  }

  // "Which of the following" patterns
  {
    const m = q.match(/^Which of the following\s+(.*?)\s*\?$/i);
    if (m) {
      const rest = m[1];
      const verbMatch = rest.match(/^(.+?)\s+(is|are|requires|was|should|can|has|would)\s+(.*)/i);
      if (verbMatch) return `The ${verbMatch[1]} that ${verbMatch[2]} ${verbMatch[3]} is [___].`;
      return `The following ${rest}: [___].`;
    }
  }

  // "Which statement/set/combination about X is Y?"
  {
    const m = q.match(/^Which\s+(statement|set|combination|description)\s+(?:about|regarding)\s+(.*?)\s+is\s+(.*?)\s*\?$/i);
    if (m) return `Regarding ${m[2]}: [___] (${m[3].toLowerCase()}).`;
  }

  // "Which is/are the X?"
  {
    const m = q.match(/^Which\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) return `The ${m[2]} ${m[1]} [___].`;
  }

  // "Which [noun] is contraindicated [in Y]?"
  {
    const m = q.match(/^Which\s+(.+?)\s+is\s+contraindicated(?:\s+in\s+(.+?))?\s*\?$/i);
    if (m) {
      const noun = m[1].trim();
      const target = m[2]?.trim();
      return target ? `The contraindicated ${noun} in ${target} is [___].` : `The contraindicated ${noun} is [___].`;
    }
  }

  // "Which scenario is a contraindication to X?"
  {
    const m = q.match(/^Which\s+(?:scenario|situation|condition)\s+is\s+a\s+contraindication\s+to\s+(.+?)\s*\?$/i);
    if (m) return `A contraindication to ${m[1].trim()} is [___].`;
  }

  // "Which [noun] is/are/does [rest]?"
  {
    const m = q.match(
      /^Which\s+([\w\s]+?)\s+(is|are|does|was|were|has|have|had|would be|should be|can|could|may|might|will|best (?:reflects|describes|matches|explains|fits|predicts)|MOST (?:likely|accurately|commonly|appropriately)|confirms?|treats?|causes?|produces?|prevents?|reduces?|increases?|decreases?|reverses?|stops?|starts?|triggers?|inhibits?|activates?|blocks?|antagoni[sz]es?|stimulates?|requires?|indicates?|suggests?|distinguishes?|differentiates?|results? in|leads? to)\s+(.*?)\s*\?$/i,
    );
    if (m) return `The ${m[1].trim()} that ${m[2].trim()} ${m[3].trim()} is [___].`;
  }

  // Simple "Which X?" without a clear verb
  {
    const m = q.match(/^Which\s+(.*?)\s*\?$/i);
    if (m) {
      const rest = m[1];
      const verbMatch = rest.match(/^(.*?)\s+(is|are|does)\s+(.*)/i);
      if (verbMatch) return `The ${verbMatch[1]} that ${verbMatch[2]} ${verbMatch[3]} is [___].`;
      return `The ${rest}: [___].`;
    }
  }

  // 7: "What should you do FIRST?"
  {
    const m = q.match(/^What\s+should\s+you\s+do\s+FIRST\s*\?$/i);
    if (m) return 'The first step is [___].';
  }

  // 8: "What distinguishes X from Y?"
  {
    const m = q.match(/^What\s+distinguishes\s+(.*?)\s+from\s+(.*?)\s*\?$/i);
    if (m) return `The finding that distinguishes ${m[1]} from ${m[2]} is [___].`;
  }

  // "What (best|most likely) explains X?"
  {
    const m = q.match(
      /^What\s+(?:best|most\s+likely|most|best\s+(?:explains|accounts\s+for))\s+(?:explains|accounts\s+for)\s+(.*?)\s*\?$/i,
    );
    if (m) return `${cap(m[1])} is best explained by [___].`;
  }
  {
    const m = q.match(/^What\s+explains\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} is explained by [___].`;
  }

  // "In which X is/are Y [adj]?"
  {
    const m = q.match(/^In\s+which\s+(?:\w+\s+){0,4}(?:is|are)\s+(.+?)\s+(considered\s+.+?|.+?)\s*\?$/i);
    if (m) return `${cap(m[1].trim())} is ${m[2].trim()} in [___].`;
  }

  // 9: "What does X stand for (in Y)?"
  {
    const m = q.match(/^What\s+does\s+(.*?)\s+stand\s+for\s+in\s+(.*?)\s*\?$/i);
    if (m) return `In ${m[2]}, ${m[1]} stands for [___].`;
  }
  {
    const m = q.match(/^What\s+does\s+(.*?)\s+stand\s+for\s*\?$/i);
    if (m) return `${m[1]} stands for [___].`;
  }

  // 1: "What [noun] is characteristic/typical/suggestive of X?"
  {
    const m = q.match(
      /^What\s+(.*?)\s+is\s+(characteristic|typical|suggestive|indicative|pathognomonic|diagnostic|predictive)\s+of\s+(.*?)\s*\?$/i,
    );
    if (m) return `The ${m[1]} ${m[2]} of ${m[3]} is [___].`;
  }

  // 2: "What [noun] defines/confirms/diagnoses X?"
  {
    const m = q.match(/^What\s+(.*?)\s+(defines|confirms|diagnoses|identifies|establishes|determines)\s+(.*?)\s*\?$/i);
    if (m) return `The ${m[1]} that ${m[2]} ${m[3]} is [___].`;
  }

  // 10: "What [noun] does/should/best X verb Y?"
  {
    const m = q.match(
      /^What\s+(.*?)\s+(should be|should|best fits|best describes|best explains|best matches|does)\s+(.*?)\s*\?$/i,
    );
    if (m) return `The ${m[1]} that ${m[2]} ${m[3]} is [___].`;
  }

  // "What is/are the X?"
  {
    const m = q.match(/^What\s+(is|are)\s+the\s+(.*?)\s*\?$/i);
    if (m) return `The ${m[2]} ${m[1]} [___].`;
  }

  // N5: "What [noun] must/should/can be [past-participle]?"
  {
    const m = q.match(
      /^What\s+(.+?)\s+(?:must|should|can|could|may|might|will|would)\s+be\s+(\w+ed|\w+en|done|started|stopped|given|ordered|excluded|included|considered|avoided|continued|discontinued|initiated)\s*\?$/i,
    );
    if (m) {
      const noun = m[1].trim();
      const pastParticiple = m[2].trim().toLowerCase();
      const infinitives: Record<string, string> = {
        excluded: 'exclude',
        included: 'include',
        considered: 'consider',
        avoided: 'avoid',
        given: 'give',
        ordered: 'order',
        done: 'do',
        started: 'start',
        stopped: 'stop',
        continued: 'continue',
        discontinued: 'discontinue',
        initiated: 'initiate',
      };
      const verb = infinitives[pastParticiple] ?? pastParticiple.replace(/(ed|en)$/, '');
      return `The ${noun} to ${verb} is [___].`;
    }
  }

  // "What is X?" (without "the")
  {
    const m = q.match(/^What\s+is\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} is [___].`;
  }

  // "What are X?" (without "the")
  {
    const m = q.match(/^What\s+are\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} are [___].`;
  }

  // "What does X indicate/suggest/tell?"
  {
    const m = q.match(/^What\s+does\s+(.*?)\s+(indicate|suggest|tell you|mean|cause|show|reveal)\s*\?$/i);
    if (m) {
      const verb = m[2] === 'tell you' ? 'tells you' : `${m[2]}s`;
      return `${cap(m[1])} ${verb} [___].`;
    }
  }

  // "What [noun] does the result suggest?"
  {
    const m = q.match(/^What\s+(.*?)\s+does\s+(.*?)\s+(suggest|indicate|cause|show|predict)\s*\?$/i);
    if (m) return `The ${m[1]} ${m[2]} ${m[3]}s is [___].`;
  }

  // 3: "How long before X should Y be stopped/held/withheld?"
  {
    const m = q.match(/^How\s+long\s+before\s+(.*?)\s+should\s+(.*?)\s+be\s+(stopped|held|withheld|discontinued|paused|ceased)\s*\?$/i);
    if (m) return `${cap(m[2])} should be ${m[3]} [___] before ${m[1]}.`;
  }

  // "How much/many X does Y verb?"
  {
    const m = q.match(/^(?:Approximately )?[Hh]ow (?:much|many)\s+(.*?)\s+does\s+(.*?)\s+(bind|contain|require|need|deliver|produce)\s*\?$/i);
    if (m) return `${cap(m[2])} ${m[3]}s [___] ${m[1]}.`;
  }

  // "X begins/develops within how many hours of Y?"
  {
    const m = q.match(
      /^(.+?)\s+(begin|begins|develop|develops|onsets|present|presents|appear|appears|occur|occurs|peak|peaks)\s+within\s+how\s+many\s+(hours|days|minutes|weeks)\s+(?:after|of)\s+(.+?)\s*\?$/i,
    );
    if (m) {
      const subj = m[1].trim();
      const verb = m[2].trim();
      const ref = m[4].trim();
      return `${cap(subj)} ${verb} within [___] of ${ref}.`.replace(/ {2,}/g, ' ');
    }
  }

  // "How much/many X?" simple
  {
    const m = q.match(/^(?:Approximately )?[Hh]ow (?:much|many)\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])}: [___].`;
  }

  // 4: "Why can't X be Y?"
  {
    const m = q.match(/^Why\s+can'?t\s+(.*?)\s+be\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} can't be ${m[2]} because [___].`;
  }

  // 5: "Why does X not verb Y?"
  {
    const m = q.match(/^Why\s+does\s+(.*?)\s+not\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} doesn't ${m[2]} because [___].`;
  }

  // "Why is X [adjective]?"
  {
    const m = q.match(/^Why\s+is\s+(.*?)\s+(misleading|dangerous|important|significant|wrong|incorrect|deceptive)\s*\?$/i);
    if (m) return `${cap(m[1])} is ${m[2]} because [___].`;
  }

  // "Why is X?"
  {
    const m = q.match(/^Why\s+is\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} because [___].`;
  }

  // 6: "When is X indicated (in Y)?"
  {
    const m = q.match(/^When\s+is\s+(.*?)\s+indicated(?:\s+in\s+(.*?))?\s*\?$/i);
    if (m) {
      if (m[2]) return `${cap(m[1])} is indicated in ${m[2]} when [___].`;
      return `${cap(m[1])} is indicated when [___].`;
    }
  }

  // 6 variant: "When should X be given/administered (in Y)?"
  {
    const m = q.match(/^When\s+should\s+(.*?)\s+be\s+(?:given|administered)(?:\s+in\s+(.*?))?\s*\?$/i);
    if (m) {
      if (m[2]) return `${cap(m[1])} should be given in ${m[2]} when [___].`;
      return `${cap(m[1])} should be given when [___].`;
    }
  }

  // "When should X be [verb]ed?"
  {
    const m = q.match(/^When\s+should\s+(.*?)\s+be\s+(\w+)\s*\?$/i);
    if (m) return `${cap(m[1])} should be ${m[2]} when [___].`;
  }

  // "When should X?" (catch-all)
  {
    const m = q.match(/^When\s+should\s+(.*?)\s*\?$/i);
    if (m) return `${cap(m[1])} should occur when [___].`;
  }

  // Compound questions "What is X and what does Y?" — take the first part
  {
    const m = q.match(/^(.*?)\s+and\s+what\s+(?:does|is|are)\s+(.*?)\s*\?$/i);
    if (m) {
      const first = m[1].trim() + '?';
      const converted = questionToStatement(first);
      if (!converted.endsWith(': [___].')) return converted;
    }
  }

  // Fallback: strip the question mark, make it a statement
  const stripped = q.replace(/\?$/, '').replace(/[.:;,]+$/, '').trim();
  return `${stripped}: [___].`;
}

function cap(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ─── public entry point ──────────────────────────────────────────────────────

/**
 * Derive a cloze `AuthoringCard` from an MCQ, reinforcing the same fact in
 * recall form. Returns null when the MCQ shouldn't produce a cloze (see
 * `shouldSkipClozeConversion` / `shouldOmitMcqCard` and the conversion guards).
 *
 * The cloze `front` carries a `[___]` blank derived from the stem; `back` is the
 * trimmed 1–2 word answer span; `context` reuses the question explanation as the
 * post-miss teaching note. Complexity/importance/topics/cite carry over.
 */
export function mcqToCloze(q: AuthoringQuestion): AuthoringCard | null {
  const correct = q.options.find((o) => o.isCorrect);
  if (!correct) return null;

  const stem = q.stem.trim();
  const answerText = correct.text;

  if (shouldOmitMcqCard(stem, answerText)) return null;
  if (shouldSkipClozeConversion(stem, answerText)) return null;

  const back = trimAnswerForCloze(answerText);
  if (!back) return null;

  const front = stemToClozeStatement(stem);
  if (!front) return null;

  const context = (correct.explanation ?? q.explanation)?.trim() || undefined;

  return {
    cardType: 'cloze',
    front,
    back,
    context,
    complexity: q.complexity,
    importance: q.importance,
    topics: q.topics,
    cite: q.cite,
    stableId: q.stableId ? `${q.stableId}:cloze` : undefined,
  };
}
