'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { normalizeAngleBracketEscapes } from '@/lib/normalize-angle-bracket-escapes';
import { useMCQState } from '@/hooks/useMCQState';

// ─── Types ────────────────────────────────────────────────────────

interface ReviewCard {
  id: string;
  type: 'card';
  front: string;
  back: string;
  backs?: string[];
  context?: string;
}

interface ReviewQuestion {
  id: string;
  type: 'question';
  stem: string;
  options: Array<{ label: string; text: string; isCorrect: boolean; explanation?: string }>;
  context?: string;
}

type ReviewItem = ReviewCard | ReviewQuestion;

interface DailyTargetData {
  dailyTarget: number | null;
  daysToExam: number;
  examDate: string | null;
  todayReviewed: number;
  coverage: {
    seenCards: number;
    totalCards: number;
    seenQuestions: number;
    totalQuestions: number;
  };
}

// ─── Card Text Component ──────────────────────────────────────────

function CardText({ text, answers, revealedCount }: { text: string; answers?: string[]; revealedCount: number }) {
  const parts = useMemo(() => {
    const segments: Array<{ type: 'text' | 'blank'; content: string; index?: number }> = [];
    let blankIndex = 0;
    let remaining = normalizeAngleBracketEscapes(text);

    while (remaining.length > 0) {
      const blankMatch = remaining.match(/\[_{2,}\]/);
      if (!blankMatch) {
        segments.push({ type: 'text', content: remaining });
        break;
      }
      const before = remaining.slice(0, blankMatch.index);
      if (before) segments.push({ type: 'text', content: before });
      segments.push({ type: 'blank', content: normalizeAngleBracketEscapes(answers?.[blankIndex] || '???'), index: blankIndex });
      blankIndex++;
      remaining = remaining.slice((blankMatch.index || 0) + blankMatch[0].length);
    }
    return segments;
  }, [text, answers]);

  return (
    <span className="whitespace-pre-wrap">
      {parts.map((part, i) => {
        if (part.type === 'text') return <span key={i}>{part.content}</span>;
        const isRevealed = part.index !== undefined && part.index < revealedCount;
        return (
          <span key={i} className={`inline-block px-2 py-0.5 mx-0.5 rounded transition-all ${
            isRevealed
              ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-medium'
              : 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 min-w-[60px] text-center'
          }`}>
            {isRevealed ? part.content : '?'}
          </span>
        );
      })}
    </span>
  );
}

// ─── Progress Pill (clickable to toggle drawer) ──────────────────

function ProgressPill({ reviewed, total, onClick }: { reviewed: number; total: number; onClick: () => void }) {
  const pct = total > 0 ? Math.min(100, (reviewed / total) * 100) : 0;
  return (
    <button
      onClick={onClick}
      aria-label={`Progress: ${reviewed} of ${total}. Click for details.`}
      className="relative overflow-hidden rounded-full px-3 py-1 text-xs bg-[var(--md-primary)]/15 cursor-pointer"
    >
      <div className="absolute inset-y-0 left-0 bg-[var(--md-primary)]/20 transition-all duration-500" style={{ width: `${pct}%` }} />
      <span className="relative text-[var(--md-on-surface)]">{reviewed}/{total}</span>
    </button>
  );
}

// ─── Progress Drawer ─────────────────────────────────────────────

function ProgressDrawer({ open, data }: { open: boolean; data: DailyTargetData | null }) {
  if (!data) return null;

  return (
    <div className={`overflow-hidden transition-all duration-300 ease-out ${
      open ? 'max-h-40 opacity-100 mt-2' : 'max-h-0 opacity-0'
    }`}>
      <div className="rounded-lg bg-[var(--md-surface-container)] p-3 text-xs text-[var(--md-on-surface-variant)] space-y-1.5">
        {data.daysToExam > 0 && (
          <div>{data.daysToExam} days to exam</div>
        )}
        <div>{data.todayReviewed} reviewed today</div>
        <div>
          {data.coverage.seenCards}/{data.coverage.totalCards} cards &middot; {data.coverage.seenQuestions}/{data.coverage.totalQuestions} MCQs
        </div>
        {data.dailyTarget && (
          <div>Daily target: {data.dailyTarget}</div>
        )}
      </div>
    </div>
  );
}

// ─── Card Feedback Buttons ───────────────────────────────────────

function CardFeedback({ itemId, itemType }: { itemId: string; itemType: 'card' | 'question' }) {
  const [flagged, setFlagged] = useState(false);
  const [showReasons, setShowReasons] = useState(false);

  const reasons = ['Incorrect', 'Confusing', 'Too easy', 'Other'];

  const handleFlag = async (reason: string) => {
    setFlagged(true);
    setShowReasons(false);
    try {
      await fetch('/api/content/flag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: itemType,
          id: itemId,
          reason,
        }),
      });
    } catch {
      // Silently fail — flag is a best-effort action
    }
  };

  if (flagged) {
    return (
      <span className="text-xs text-[var(--md-on-surface-variant)]">Flagged — thanks!</span>
    );
  }

  return (
    <div className="relative inline-flex items-center gap-2">
      <button
        onClick={() => setShowReasons(!showReasons)}
        className="text-xs px-2 py-1 rounded-lg border border-[var(--md-outline-variant)] text-[var(--md-on-surface-variant)] hover:border-[var(--md-error)] hover:text-[var(--md-error)] transition-colors"
        aria-label="Flag this content"
      >
        Flag
      </button>
      {showReasons && (
        <div className="absolute bottom-full left-0 mb-1 bg-[var(--md-surface-container-high)] border border-[var(--md-outline-variant)] rounded-lg shadow-lg p-1 z-10">
          {reasons.map(reason => (
            <button
              key={reason}
              onClick={() => handleFlag(reason)}
              className="block w-full text-left text-xs px-3 py-1.5 rounded hover:bg-[var(--md-surface-container)] text-[var(--md-on-surface)] whitespace-nowrap"
            >
              {reason}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main Review Page ─────────────────────────────────────────────

export default function ReviewPage() {
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [dailyTarget, setDailyTarget] = useState<DailyTargetData | null>(null);

  // Card state
  const [revealedBlanks, setRevealedBlanks] = useState(0);

  const startTimeRef = useRef(Date.now());
  const currentItem = items[currentIndex];

  // MCQ state via shared hook
  const mcqCorrectLabel = currentItem?.type === 'question'
    ? (currentItem.options.find(o => o.isCorrect)?.label ?? '')
    : '';

  const {
    selectedAnswer: selectedOption,
    hasAnswered: mcqAnswered,
    handleOptionClick: mcqOptionClick,
    handleReset: resetMcqState,
  } = useMCQState({ correctLabel: mcqCorrectLabel });

  // Fetch session items
  useEffect(() => {
    async function fetchSession() {
      try {
        const res = await fetch('/api/study/unified-session?rotation=example-rotation&limit=20');
        if (!res.ok) throw new Error(`Failed to load: ${res.status}`);
        const data = await res.json();
        setItems(data.items || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setLoading(false);
      }
    }
    fetchSession();
  }, []);

  // Fetch daily target on mount
  useEffect(() => {
    fetch('/api/study/daily-target?rotation=example-rotation')
      .then(r => r.json())
      .then(setDailyTarget)
      .catch(() => {});
  }, []);

  const blankCount = useMemo(() => {
    if (!currentItem || currentItem.type !== 'card') return 0;
    return currentItem.front.match(/\[_{2,}\]/g)?.length || 0;
  }, [currentItem]);

  const cardFullyRevealed = revealedBlanks >= (blankCount > 0 ? blankCount : 1);

  const advanceToNext = useCallback(() => {
    setCurrentIndex(prev => prev + 1);
    setRevealedBlanks(0);
    resetMcqState();
    setReviewed(prev => prev + 1);
    startTimeRef.current = Date.now();
  }, [resetMcqState]);

  const handleReveal = useCallback(() => {
    setRevealedBlanks(prev => Math.min(prev + 1, blankCount > 0 ? blankCount : 1));
  }, [blankCount]);

  const handleCardGrade = useCallback(async (quality: number) => {
    if (!currentItem || currentItem.type !== 'card' || saving) return;
    setSaving(true);
    const responseTimeMs = Date.now() - startTimeRef.current;

    let failed = false;
    try {
      const res = await fetch('/api/cards/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cardId: currentItem.id, quality, responseTimeMs }),
      });
      if (!res.ok) failed = true;
    } catch {
      failed = true;
    }

    setSaving(false);

    if (failed) {
      // Stay on the card so the user can retry — don't advance
      setSaveError(true);
      setTimeout(() => setSaveError(false), 5000);
      return;
    }

    advanceToNext();
  }, [currentItem, advanceToNext, saving]);

  const handleMcqSelect = useCallback(async (label: string) => {
    if (mcqAnswered || !currentItem || currentItem.type !== 'question') return;
    mcqOptionClick(label);

    const responseTimeMs = Date.now() - startTimeRef.current;

    try {
      const res = await fetch('/api/questions/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: currentItem.id,
          selectedOption: label,
          responseTimeMs,
        }),
      });
      if (!res.ok) console.error('MCQ response save failed:', res.status);
    } catch (err) {
      console.error('MCQ response save failed:', err);
    }
  }, [mcqAnswered, currentItem, mcqOptionClick]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      if (!currentItem) return;

      if (currentItem.type === 'card') {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (!cardFullyRevealed) handleReveal();
        }
        if (cardFullyRevealed && !saving) {
          if (e.key === '1') { e.preventDefault(); handleCardGrade(0); }
          if (e.key === '2') { e.preventDefault(); handleCardGrade(1); }
          if (e.key === '3') { e.preventDefault(); handleCardGrade(3); }
          if (e.key === '4') { e.preventDefault(); handleCardGrade(5); }
        }
      }

      if (currentItem.type === 'question') {
        if (!mcqAnswered) {
          const num = parseInt(e.key);
          if (num >= 1 && num <= currentItem.options.length) {
            e.preventDefault();
            handleMcqSelect(String.fromCharCode(64 + num));
          }
        } else {
          if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); advanceToNext(); }
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [currentItem, cardFullyRevealed, mcqAnswered, saving, handleReveal, handleCardGrade, handleMcqSelect, advanceToNext]);

  // ─── Render ────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-[var(--md-on-surface-variant)]">Loading review session...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <p className="text-[var(--md-error)] mb-2">{error}</p>
          <p className="text-sm text-[var(--md-on-surface-variant)]">
            Make sure you have seeded the database: <code className="bg-[var(--md-surface-container-high)] px-1 rounded">npm run seed</code>
          </p>
        </div>
      </div>
    );
  }

  if (!currentItem || currentIndex >= items.length) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <p className="text-2xl font-bold text-[var(--md-on-surface)] mb-2">Session Complete</p>
          <p className="text-[var(--md-on-surface-variant)]">You reviewed {reviewed} items.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      {/* Save error toast */}
      {saveError && (
        <div className="fixed top-4 right-4 z-50 bg-[var(--md-error)] text-[var(--md-on-error)] text-sm px-4 py-2 rounded-lg shadow-lg animate-pulse">
          Review save failed — progress may be lost
        </div>
      )}

      {/* Header with progress pill and drawer */}
      <div className="mb-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-[var(--md-on-surface)]">Review Session</h1>
          <ProgressPill reviewed={reviewed} total={items.length} onClick={() => setDrawerOpen(prev => !prev)} />
        </div>
        <ProgressDrawer open={drawerOpen} data={dailyTarget} />
      </div>

      {/* Card Review */}
      {currentItem.type === 'card' && (
        <div className="rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] overflow-hidden">
          {/* Front */}
          <div className="px-6 py-8 text-lg text-[var(--md-on-surface)]">
            <CardText
              text={currentItem.front}
              answers={currentItem.backs || [currentItem.back]}
              revealedCount={revealedBlanks}
            />
          </div>

          {/* Context (shown after all blanks revealed) */}
          {cardFullyRevealed && currentItem.context && (
            <div className="px-6 py-4 border-t border-[var(--md-outline-variant)] bg-[var(--md-surface-container)]">
              <p className="text-sm text-[var(--md-on-surface-variant)]">{currentItem.context}</p>
            </div>
          )}

          {/* Actions */}
          <div className="px-6 py-4 border-t border-[var(--md-outline-variant)]">
            {!cardFullyRevealed ? (
              <div className="text-center">
                <button onClick={handleReveal} className="px-6 py-2 rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)] font-medium">
                  Reveal
                </button>
                <p className="text-xs text-[var(--md-on-surface-variant)] mt-2">Space or Enter to reveal</p>
              </div>
            ) : (
              <div>
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-[var(--md-on-surface-variant)]">How well did you know this?</p>
                  <CardFeedback itemId={currentItem.id} itemType="card" />
                </div>
                <div className="flex gap-2 justify-center">
                  {[
                    { label: 'Again', quality: 0, key: '1', color: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 border-red-300 dark:border-red-700' },
                    { label: 'Hard', quality: 1, key: '2', color: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-700' },
                    { label: 'Good', quality: 3, key: '3', color: 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-700' },
                    { label: 'Easy', quality: 5, key: '4', color: 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 border-green-300 dark:border-green-700' },
                  ].map(btn => (
                    <button
                      key={btn.quality}
                      onClick={() => handleCardGrade(btn.quality)}
                      disabled={saving}
                      className={`flex-1 py-2 rounded-lg border text-sm font-medium ${btn.color} ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <span className="text-xs opacity-60">{btn.key}</span> {btn.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* MCQ Review */}
      {currentItem.type === 'question' && (
        <div className="rounded-2xl border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-low)] overflow-hidden">
          <div className="px-6 py-5 text-[var(--md-on-surface)] whitespace-pre-wrap">{currentItem.stem}</div>

          <div className="px-6 pb-6 space-y-3">
            {currentItem.options.map((opt, idx) => {
              const isSelected = selectedOption === opt.label;
              const isCorrectOpt = opt.isCorrect;

              let style = 'w-full flex items-start gap-3 px-4 py-3 rounded-xl border text-left transition-all ';
              if (!mcqAnswered) {
                style += 'border-[var(--md-outline-variant)] hover:border-[var(--md-primary)] cursor-pointer';
              } else if (isCorrectOpt) {
                style += 'border-green-500 bg-green-50 dark:bg-green-900/20';
              } else if (isSelected) {
                style += 'border-red-500 bg-red-50 dark:bg-red-900/20';
              } else {
                style += 'border-[var(--md-outline-variant)] opacity-60';
              }

              return (
                <button key={opt.label} onClick={() => handleMcqSelect(opt.label)} disabled={mcqAnswered} className={style}>
                  <span className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold bg-[var(--md-surface-container-high)]">
                    {mcqAnswered ? opt.label : idx + 1}
                  </span>
                  <div className="pt-1 flex-1">
                    <span>{opt.text}</span>
                    {/* Per-option explanation shown after answering */}
                    {mcqAnswered && opt.explanation && (
                      <p className="text-xs text-[var(--md-on-surface-variant)] mt-1">{opt.explanation}</p>
                    )}
                  </div>
                </button>
              );
            })}
          </div>

          {!mcqAnswered && (
            <div className="px-6 pb-4 text-xs text-[var(--md-on-surface-variant)] text-center">
              Press 1-{currentItem.options.length} to answer
            </div>
          )}

          {mcqAnswered && (
            <div className={`px-6 py-5 border-t ${
              selectedOption && currentItem.options.find(o => o.label === selectedOption)?.isCorrect
                ? 'bg-green-50 dark:bg-green-900/20 border-green-200'
                : 'bg-red-50 dark:bg-red-900/20 border-red-200'
            }`}>
              {currentItem.context && (
                <p className="text-[var(--md-on-surface)] mb-3">{currentItem.context}</p>
              )}
              <div className="flex items-center justify-between">
                <div>
                  <button onClick={advanceToNext} className="px-4 py-2 text-sm font-medium rounded-lg bg-[var(--md-primary)] text-[var(--md-on-primary)]">
                    Continue
                  </button>
                  <span className="text-xs text-[var(--md-on-surface-variant)] ml-3">Space or Enter</span>
                </div>
                <CardFeedback itemId={currentItem.id} itemType="question" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
