# md3: An Open-Source Spaced Repetition Platform for Clinical Medical Education

**Ian Todd**
Year 3 Medical Student, Sydney Medical School
University of Sydney

---

## Abstract

Medical students face a volume problem: thousands of clinical facts across concurrent rotations, with limited time before high-stakes exams. md3 is an open-source platform built by a student using AI coding tools that combines spaced repetition scheduling with structured active recall, organised by clinical rotation and week. Content is authored in MDX with purpose-built components (clinical pearls, mnemonics, vignette-based MCQs with per-option explanations), then compiled into a scheduler-driven review feed that adapts to exam proximity. Over 74 days of use across two clinical rotations, the platform has served 8,483 review interactions to 68 active users from 95 accounts. This paper describes the system's design, the AI-assisted development process, and early usage patterns. The full source code is publicly available.

---

## 1. Introduction

Clinical medical education demands the acquisition of a large volume of factual knowledge under time pressure. Year 3 students at the University of Sydney rotate through four 7-week clinical blocks (Critical Care, Psychiatry, Child & Adolescent Health, Perinatal & Women's Health), each culminating in a knowledge assessment exam. The combination of breadth (hundreds of topics per rotation), depth (exam-level clinical reasoning), and time constraint (7 weeks from first lecture to exam) creates a study challenge that passive methods — re-reading notes, watching lectures — handle poorly.

Spaced repetition systems (SRS) address this by scheduling reviews at increasing intervals calibrated to the forgetting curve (Ebbinghaus, 1885; Pimsleur, 1967). Platforms like Anki have demonstrated effectiveness in medical education (Deng et al., 2015), but require substantial manual effort to create cards and lack awareness of curriculum structure, exam timing, or the relationships between concepts.

md3 was built to solve three specific problems:

1. **Content creation bottleneck.** Writing high-quality flashcards and MCQs is time-consuming. md3 uses a structured content pipeline where lecture material is synthesised into MDX files with purpose-built components, and cards are compiled automatically.

2. **Curriculum-unaware scheduling.** Generic SRS tools treat all material equally. md3's scheduler is aware of rotation structure, exam dates, and topic coverage, allowing it to prioritise weak areas and adjust daily targets to time remaining.

3. **Single-format testing.** Cloze-deletion cards test recognition, not application. md3 combines cloze cards, vignette-based MCQs with per-option explanations, clinical scenarios, and mnemonics — the principle being that a concept isn't truly known until it's been tested from multiple angles.

The platform was developed over approximately 10 weeks using Claude Code (Anthropic's AI coding assistant) as the primary development tool, with the author having no prior production web development experience.

---

## 2. System Design

### 2.1 Architecture

md3 is a Next.js application deployed on Vercel with a Neon Postgres database. The core data flow is:

```
Source material (lectures, guidelines)
    ↓
MDX content files (structured components)
    ↓
Seed pipeline (card + question extraction)
    ↓
Database (cards, questions, progress)
    ↓
Scheduler (what to review next)
    ↓
Feed (daily review session)
```

### 2.2 Content Pipeline

Content is authored in MDX (Markdown with JSX components). The system provides five core components:

- **KeyPoint**: A cloze-deletion card with a `context` attribute containing the teaching explanation shown after review. Example: `The first-line vasopressor in septic shock is [___].` with context explaining the mechanism.
- **MCQ**: A vignette-based multiple-choice question with 5 options, each containing an `explanation` field. Options are shuffled on every encounter.
- **Mnemonic**: A structured memory aid (e.g., DIG FAST for mania criteria) that generates cloze cards from its bold elements.
- **ClinicalPearl** and **Danger**: Teaching content that generates simpler recall cards for scaffolding.

A seed script extracts cards and questions from MDX files and upserts them into the database. Separately, a curated question bank (JSON files per rotation per week) provides higher-quality MCQs authored with clinical scenarios and per-option explanations.

### 2.3 Scaffolding Principle

Every test item (cloze card, MCQ) needs a simpler teaching companion. When a student fails a question about Murphy's sign, the scheduler needs a complexity-1 card that explains what Murphy's sign *is* and why it works. Without these scaffolding cards, students are simply re-tested on material they don't understand.

### 2.4 Scheduling Algorithm

The scheduler combines spaced repetition with exam-awareness:

1. **Daily target**: `ceil(unseen_items / effective_days_to_exam)` where effective days accounts for a 5-day consolidation buffer before the exam.

2. **Review priority**: Cards are scored by a combination of time since last review, past performance (quality ratings 1-4), and topic coverage gaps.

3. **Multi-format probing**: A concept is not considered mastered until tested via multiple formats. A student who recalls "noradrenaline" in a cloze deletion may fail to apply it in a clinical vignette. The scheduler tracks format coverage and introduces new formats for apparently-mastered concepts.

4. **Consolidation buffer**: New cards stop being introduced 5 days before the exam, allowing the final days for pure review of previously-seen material.

### 2.5 Quality Assurance

Content quality is enforced at multiple levels:

- **Seed-time validation**: Cards with answers that are too short, too long, or grammatically broken are rejected.
- **Form opacity checks**: MCQs where the correct answer is conspicuously longer than distractors are flagged (test-taking cue elimination).
- **User flagging**: Students can flag cards during review. Flags are triaged with pattern clustering (e.g., "giveaway answer", "context restates the answer", "broken grammar").
- **Complexity calibration**: Card difficulty is scored against real exam questions to ensure appropriate challenge levels.

---

## 3. Development Process

### 3.1 AI-Assisted Development

md3 was built using Claude Code as the primary development tool. The author's prior programming experience was limited to scripting and data analysis — no production web development, no React, no database design.

The development process involved:

- **Conversational architecture**: Describing the desired system behaviour in natural language, iterating on implementation through conversation.
- **Test-driven development**: Claude Code wrote failing tests first, then implemented code to pass them. The codebase has 3,006 tests across 240 test files.
- **Documentation as context**: A set of design documents (`docs/ARCHITECTURE.md`, `docs/PHILOSOPHY.md`, `docs/REVIEW_SYSTEM.md`, etc.) provided persistent context across sessions, allowing the AI to make architecturally consistent decisions.
- **Multi-agent coordination**: Multiple Claude Code sessions working in parallel on independent tasks (content authoring, bug fixes, feature development), coordinated through git and a shared agent guide.

### 3.2 Development Timeline

| Week | Milestone |
|------|-----------|
| 1-2 | Core app scaffold, MDX pipeline, first cards |
| 3-4 | Spaced repetition scheduler, review UI |
| 5-6 | Question bank, MCQ system, per-option explanations |
| 7-8 | Feed algorithm, daily targets, progress tracking |
| 9-10 | Quality assurance, content auditing, flag triage |
| Ongoing | Content authoring, flag fixes, user feedback |

### 3.3 Iteration Speed

The AI-assisted development approach enabled rapid iteration: the median time from bug report to deployed fix was under 30 minutes. Content quality issues identified through user flags were typically resolved in the same session — the AI reads the flagged card, understands the clinical context, rewrites the content, updates the source file, re-seeds the database, and resolves the flag.

---

## 4. Results

### 4.1 Platform Scale

After 74 days of operation (19 January to 3 April 2026):

| Metric | Value |
|--------|-------|
| Total flashcards | 15,170 |
| Total MCQs | 11,750 |
| Content source files | 197 |
| Clinical rotations covered | 4 (USyd Year 3) + supplementary |
| Card reviews completed | 3,086 |
| MCQ responses completed | 5,397 |
| Total review interactions | 8,483 |
| Registered users | 95 |
| Users with activity | 68 |

### 4.2 Usage Patterns

The platform was used across two clinical rotation blocks:

- **Block 1 (Critical Care)**: Primary development period. Two consistent daily users, with 10+ additional users trying the platform.
- **Block 2 (Psychiatry)**: Expanded content, refined scheduling. Consistent daily use from 2-4 users, with guest traffic from shared links.

Peak daily usage reached 280 minutes of active review time across all users. The two primary users completed an average of 80-120 review items per day during active study periods.

### 4.3 Content Quality Evolution

User flagging drove continuous content improvement. The author flagged 2,556 cards during normal study sessions — a single tap during review whenever something was wrong. Common patterns included: giveaway answers (cloze where the blank was deducible from context), lazy contexts (explanation restated the answer rather than teaching), garbled stems from automated import processes, and factual errors. Flags were clustered by pattern and resolved in batches, with each fix informing rules that prevented the same pattern in future content. This flag-fix loop was the primary quality mechanism — far more impactful than any automated check.

### 4.4 MCQ Shuffle Validation

Option position bias is a known issue in computer-based testing. md3 shuffles options on every encounter and tracks the position of the selected answer. A chi-squared test across 2,599 responses with position data showed no significant position bias (chi-squared = 7.4, df = 4, p > 0.05), confirming the shuffle implementation is uniform.

---

## 5. Discussion

### 5.1 AI as Development Accelerator

The most significant finding is that a medical student with no web development experience could build and deploy a production-quality learning platform in approximately 10 weeks using AI coding tools. The resulting codebase includes 3,006 passing tests, handles concurrent users, and has been stable in production for over two months.

This suggests that the barrier to building custom educational technology is substantially lower than previously assumed. Domain experts (students, clinicians, educators) who understand the pedagogical problem are now capable of building the technical solution, with AI handling the implementation complexity.

### 5.2 Curriculum-Aware Scheduling

Generic spaced repetition tools (Anki, Quizlet) are agnostic to curriculum structure. md3's awareness of rotation weeks, exam dates, and topic relationships allows it to make scheduling decisions that a generic tool cannot: prioritising weak topics within the current rotation, adjusting daily load to exam proximity, and ensuring multi-format coverage of high-yield concepts.

### 5.3 Content as Code

Authoring content in MDX (version-controlled, structured, diffable) rather than a GUI card editor has significant advantages for quality assurance. Content can be reviewed in pull requests, validated by automated checks, and systematically improved through scripted audits. The tradeoff is a higher authoring barrier — you need to write MDX, not click buttons — but this is mitigated by AI tools that can author content from lecture transcripts.

### 5.4 Limitations

- **Content creation is not solved.** This is the most important limitation. While AI tools accelerate development of the *platform*, the content itself still requires extensive manual curation. Of 156 git commits over the project's lifetime, 122 (78%) were content fixes — rewriting garbled card stems, replacing lazy contexts that restated the answer, fixing factual errors, and resolving user flags. The author raised 2,556 content flags during normal study sessions — tapping a flag button whenever a card had a broken stem, wrong answer, giveaway cloze, or unhelpful context. Each flag required manual triage and a source file edit. AI can generate draft content from lecture transcripts, but a human with clinical knowledge must review every card for accuracy, pedagogical value, and format quality. The "last mile" of content — turning a technically correct fact into a well-constructed test item — remains stubbornly manual.
- **Small user base**: 68 active users is insufficient for statistical claims about learning outcomes. The platform is primarily a tool for the author's own study, with sharing as a secondary benefit.
- **No controlled comparison**: There is no control group studying without the platform. Exam performance data exists but confounds with study effort, prior knowledge, and other study methods.
- **Single institution**: The rotation structure, exam format, and content are specific to the University of Sydney's Year 3 curriculum. Generalisation to other programs requires the same content authoring effort described above.

### 5.5 Future Directions

- **Knowledge inference**: Using semantic similarity between cards to infer mastery of untested concepts from tested neighbours.
- **Multi-institution support**: Allowing other medical schools to create their own rotation content while sharing the platform infrastructure.
- **Collaborative content authoring**: Enabling students and educators to contribute content through a structured review process.

---

## 6. Conclusion

md3 demonstrates that a student with domain expertise and AI coding tools can build a curriculum-aware spaced repetition platform that addresses real gaps in clinical medical education. The combination of structured content authoring, exam-aware scheduling, and multi-format testing creates a study tool that is more than the sum of its parts. The platform is open source and available for adaptation by other medical education programs.

---

## References

- Deng, F., Gluckstein, J. A., & Larsen, D. P. (2015). Student-directed retrieval practice is a predictor of medical licensing examination performance. *Perspectives on Medical Education*, 4(6), 308-313.
- Ebbinghaus, H. (1885). *Memory: A Contribution to Experimental Psychology*. (H. A. Ruger & C. E. Bussenius, Trans., 1913). Teachers College, Columbia University.
- Pimsleur, P. (1967). A memory schedule. *Modern Language Journal*, 51(2), 73-75.
- Schmidmaier, R., Ebersbach, R., Schiller, M., Hege, I., Holzer, M., & Fischer, M. R. (2011). Using electronic flashcards to promote learning in medical students: retesting versus restudying. *Medical Education*, 45(11), 1101-1110.

---

*Source code: github.com/todd866/md3-open*
*Live platform: md3.info*
