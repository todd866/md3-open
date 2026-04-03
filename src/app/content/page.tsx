'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// Week metadata for the example rotation
const WEEKS = [
  { num: 1, title: 'Oxygen Therapy', desc: 'Delivery devices, physiology, toxicity' },
  { num: 2, title: 'Fluid Resuscitation', desc: 'Crystalloids, colloids, sepsis management' },
  { num: 3, title: 'Shock Management', desc: 'Shock types, vasopressors, monitoring' },
];

interface DueSummary {
  totalCards: number;
  dueCount: number;
  reviewedCount: number;
  coveragePercent: number;
}

interface DailyTarget {
  dailyTarget: number | null;
  coverage: {
    seen: number;
    total: number;
    percent: number;
    seenCards: number;
    totalCards: number;
    seenQuestions: number;
    totalQuestions: number;
  };
  daysToExam: number;
  todayReviewed: number;
}

export default function ContentPage() {
  const [dueSummary, setDueSummary] = useState<DueSummary | null>(null);
  const [dailyTarget, setDailyTarget] = useState<DailyTarget | null>(null);

  useEffect(() => {
    fetch('/api/study/due-summary?rotation=example-rotation')
      .then(r => r.json())
      .then(setDueSummary)
      .catch(() => {});

    fetch('/api/study/daily-target?rotation=example-rotation')
      .then(r => r.json())
      .then(setDailyTarget)
      .catch(() => {});
  }, []);

  const totalCards = dailyTarget?.coverage.totalCards ?? dueSummary?.totalCards ?? 0;
  const totalQuestions = dailyTarget?.coverage.totalQuestions ?? 0;
  const coveragePercent = dailyTarget?.coverage.percent ?? dueSummary?.coveragePercent ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-[var(--md-on-surface)] mb-1">Content</h1>
        <p className="text-sm text-[var(--md-on-surface-variant)]">
          Example Rotation — {totalCards} cards, {totalQuestions} MCQs
        </p>
      </div>

      {/* Coverage stats bar */}
      <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium text-[var(--md-on-surface)]">Coverage</span>
          <span className="text-sm text-[var(--md-on-surface-variant)]">{coveragePercent}%</span>
        </div>
        <div className="h-2 bg-[var(--md-surface-container-high)] rounded-full overflow-hidden">
          <div
            className="h-full bg-[var(--md-primary)] rounded-full transition-all duration-500"
            style={{ width: `${coveragePercent}%` }}
          />
        </div>
        {dailyTarget && (
          <div className="mt-2 flex gap-4 text-xs text-[var(--md-on-surface-variant)]">
            <span>{dailyTarget.coverage.seenCards}/{dailyTarget.coverage.totalCards} cards seen</span>
            <span>{dailyTarget.coverage.seenQuestions}/{dailyTarget.coverage.totalQuestions} MCQs seen</span>
            {dailyTarget.dailyTarget && (
              <span>Target: {dailyTarget.dailyTarget}/day</span>
            )}
          </div>
        )}
      </div>

      {/* Review tile + week grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Review button */}
        <Link
          href="/review"
          className="p-3 rounded-xl bg-[var(--md-primary)] text-[var(--md-on-primary)] transition-colors hover:brightness-110"
        >
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold">&#9654;</span>
            <span className="font-medium">Review</span>
          </div>
          <div className="text-xs mt-1 opacity-80">
            {dueSummary ? `${dueSummary.dueCount} due` : 'Start session'}
          </div>
        </Link>

        {/* Week tiles */}
        {WEEKS.map(week => (
          <Link
            key={week.num}
            href={`/example-rotation/week/${week.num}`}
            className="p-3 rounded-xl bg-[var(--md-surface-container)] hover:bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)] transition-colors"
          >
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold">{week.num}</span>
              <span className="font-medium text-sm">{week.title}</span>
            </div>
            <div className="text-xs mt-1 text-[var(--md-on-surface-variant)]">
              {week.desc}
            </div>
          </Link>
        ))}
      </div>

      {/* Exam countdown */}
      {dailyTarget && dailyTarget.daysToExam > 0 && (
        <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-4 text-center">
          <div className="text-3xl font-bold text-[var(--md-primary)]">{dailyTarget.daysToExam}</div>
          <div className="text-sm text-[var(--md-on-surface-variant)]">days to exam</div>
          {dailyTarget.todayReviewed > 0 && (
            <div className="text-xs text-[var(--md-on-surface-variant)] mt-1">
              {dailyTarget.todayReviewed} reviewed today
            </div>
          )}
        </div>
      )}
    </div>
  );
}
