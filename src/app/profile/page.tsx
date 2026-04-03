'use client';

import { useEffect, useState } from 'react';

interface UserStats {
  totalReviews: number;
  totalMcqs: number;
  accuracy: number;
  streak: number;
  dailyActivity: Array<{ date: string; cards: number; mcqs: number }>;
}

interface ExamDateInfo {
  examDate: string;
  isDefault: boolean;
}

// ─── Stat Card ───────────────────────────────────────────────────

function StatCard({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div className="rounded-xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)] p-3 text-center">
      <div className="text-2xl font-bold text-[var(--md-on-surface)]">
        {value}{suffix && <span className="text-sm font-normal text-[var(--md-on-surface-variant)]">{suffix}</span>}
      </div>
      <div className="text-xs text-[var(--md-on-surface-variant)] mt-0.5">{label}</div>
    </div>
  );
}

// ─── Activity Bar Chart ──────────────────────────────────────────

function ActivityChart({ data }: { data: Array<{ date: string; cards: number; mcqs: number }> }) {
  const maxValue = Math.max(1, ...data.map(d => d.cards + d.mcqs));

  return (
    <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-4">
      <h3 className="text-sm font-medium text-[var(--md-on-surface)] mb-3">Last 7 Days</h3>
      <div className="flex items-end gap-2 h-24">
        {data.map(day => {
          const total = day.cards + day.mcqs;
          const height = total > 0 ? Math.max(8, (total / maxValue) * 100) : 4;
          const cardHeight = total > 0 ? (day.cards / total) * height : 0;
          const mcqHeight = height - cardHeight;
          const dayLabel = new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' });

          return (
            <div key={day.date} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex flex-col items-center" style={{ height: '96px' }}>
                <div className="flex-1" />
                {mcqHeight > 0 && (
                  <div
                    className="w-full rounded-t bg-[var(--md-secondary)] opacity-60"
                    style={{ height: `${mcqHeight}%` }}
                  />
                )}
                <div
                  className={`w-full ${mcqHeight > 0 ? '' : 'rounded-t'} rounded-b bg-[var(--md-primary)]`}
                  style={{ height: `${Math.max(cardHeight, total === 0 ? 4 : 0)}%`, opacity: total === 0 ? 0.2 : 1 }}
                />
              </div>
              <span className="text-[10px] text-[var(--md-on-surface-variant)]">{dayLabel}</span>
            </div>
          );
        })}
      </div>
      <div className="flex gap-4 mt-3 text-xs text-[var(--md-on-surface-variant)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-[var(--md-primary)]" /> Cards
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-[var(--md-secondary)] opacity-60" /> MCQs
        </span>
      </div>
    </div>
  );
}

// ─── Main Profile Page ───────────────────────────────────────────

export default function ProfilePage() {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [examInfo, setExamInfo] = useState<ExamDateInfo | null>(null);
  const [examInput, setExamInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetch('/api/user/stats').then(r => r.json()),
      fetch('/api/user/exam-date').then(r => r.json()),
    ])
      .then(([statsData, examData]) => {
        setStats(statsData);
        setExamInfo(examData);
        // Pre-fill the input with the current exam date (YYYY-MM-DD format)
        if (examData.examDate) {
          setExamInput(examData.examDate.slice(0, 10));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSaveExamDate = async () => {
    if (!examInput) return;
    setSaving(true);
    try {
      const res = await fetch('/api/user/exam-date', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ examDate: examInput }),
      });
      if (res.ok) {
        const data = await res.json();
        setExamInfo({ examDate: data.examDate, isDefault: false });
      }
    } catch {
      // Silently fail — user can retry
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-[var(--md-on-surface-variant)]">Loading profile...</div>
      </div>
    );
  }

  if (!stats) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-[var(--md-error)]">Failed to load profile</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-[var(--md-on-surface)]">Profile</h1>
        <p className="text-sm text-[var(--md-on-surface-variant)]">Your study statistics</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-3">
        <StatCard label="Reviews" value={stats.totalReviews} />
        <StatCard label="MCQs" value={stats.totalMcqs} />
        <StatCard label="Accuracy" value={stats.accuracy} suffix="%" />
        <StatCard label="Streak" value={stats.streak} suffix="d" />
      </div>

      {/* Activity chart */}
      <ActivityChart data={stats.dailyActivity} />

      {/* Exam date setting */}
      <div className="rounded-xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] p-4">
        <h3 className="text-sm font-medium text-[var(--md-on-surface)] mb-1">Exam Date</h3>
        <p className="text-xs text-[var(--md-on-surface-variant)] mb-3">
          Set your exam date to calculate daily study targets.
          {examInfo?.isDefault && ' Currently using default (30 days from now).'}
        </p>
        <div className="flex gap-2">
          <input
            type="date"
            value={examInput}
            onChange={e => setExamInput(e.target.value)}
            className="flex-1 px-3 py-2 rounded-lg bg-[var(--md-surface-container)] border border-[var(--md-outline)] text-sm text-[var(--md-on-surface)]"
          />
          <button
            onClick={handleSaveExamDate}
            disabled={saving || !examInput}
            className="px-4 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
