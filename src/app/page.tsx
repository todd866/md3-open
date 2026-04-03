import Link from "next/link";

export default function Home() {
  return (
    <div className="space-y-8">
      <div className="text-center py-12">
        <h1 className="text-4xl font-bold text-[var(--md-on-surface)] mb-4">
          MD3 Open
        </h1>
        <p className="text-lg text-[var(--md-on-surface-variant)] max-w-xl mx-auto">
          Open-source medical education platform with spaced repetition scheduling,
          interactive cloze-deletion cards, and MCQ assessment.
        </p>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Link
          href="/content"
          className="block p-6 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] hover:border-[var(--md-primary)] transition-colors"
        >
          <h2 className="text-xl font-semibold text-[var(--md-on-surface)] mb-2">
            Study Content
          </h2>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Browse MDX-powered medical content with interactive cloze blanks,
            mnemonics, clinical pearls, and MCQs.
          </p>
        </Link>

        <Link
          href="/review"
          className="block p-6 rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] hover:border-[var(--md-primary)] transition-colors"
        >
          <h2 className="text-xl font-semibold text-[var(--md-on-surface)] mb-2">
            Review Cards
          </h2>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Spaced repetition review session with stability-based scheduling.
            Cards are due based on your memory decay curve.
          </p>
        </Link>
      </div>

      <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-6">
        <h2 className="text-xl font-semibold text-[var(--md-on-surface)] mb-3">
          Architecture
        </h2>
        <div className="text-sm text-[var(--md-on-surface-variant)] space-y-2">
          <p>
            <strong>Content Pipeline:</strong> MDX files with custom components
            (KeyPoint, Mnemonic, MCQ, ClinicalPearl, Danger) are parsed at seed
            time to extract cloze-deletion flashcards into the database.
          </p>
          <p>
            <strong>Scheduling:</strong> Stability-based spaced repetition using
            power-law memory decay. Four pure functions compute when each card
            should be reviewed next.
          </p>
          <p>
            <strong>Stack:</strong> Next.js + MDX + Prisma + PostgreSQL + Tailwind CSS.
          </p>
        </div>
      </div>
    </div>
  );
}
