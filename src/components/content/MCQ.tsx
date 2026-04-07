'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { ContentFlag } from './ContentFlag';
import { shuffleWithSeed, displaceFirst } from '@/lib/utils/shuffle';
import { useMCQState } from '@/hooks/useMCQState';

// ─── Types ────────────────────────────────────────────────────────

interface MCQOption {
  label: string;
  text: string;
  isCorrect?: boolean;
  explanation?: string;
}

interface MCQProps {
  stem?: string;
  question?: string;
  options?: MCQOption[] | string[];
  correctAnswer?: string | number;
  answer?: string;
  distractors?: string[];
  context?: string;
  type?: string;
  difficulty?: string;
  topics?: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────

function optionLabel(i: number): string {
  return String.fromCharCode(65 + i);
}

function normalizeInput(props: MCQProps) {
  const stem = (props.stem ?? props.question ?? '').trim();
  const context = props.context ?? '';
  const opts: MCQOption[] = [];

  if (Array.isArray(props.options)) {
    for (let i = 0; i < props.options.length; i++) {
      const raw = props.options[i];
      if (typeof raw === 'string') {
        opts.push({ label: optionLabel(i), text: raw });
      } else if (raw && typeof raw === 'object' && 'text' in raw) {
        opts.push({
          label: raw.label ?? optionLabel(i),
          text: raw.text,
          isCorrect: raw.isCorrect,
          explanation: raw.explanation,
        });
      }
    }
  }

  // Legacy format: answer + distractors
  if (opts.length === 0 && typeof props.answer === 'string' && Array.isArray(props.distractors)) {
    const combined = [props.answer, ...props.distractors.filter(d => typeof d === 'string')];
    for (let i = 0; i < combined.length; i++) {
      opts.push({ label: optionLabel(i), text: combined[i], isCorrect: i === 0 });
    }
  }

  // Determine correct answer
  let correctLabel: string | undefined;
  if (typeof props.correctAnswer === 'string') {
    correctLabel = props.correctAnswer.trim().toUpperCase();
  } else if (typeof props.correctAnswer === 'number') {
    correctLabel = optionLabel(props.correctAnswer);
  }
  if (!correctLabel) {
    const explicit = opts.find(o => o.isCorrect);
    if (explicit) correctLabel = explicit.label.toUpperCase();
  }

  return { stem, options: opts, correctLabel, context };
}

const difficultyColors: Record<string, string> = {
  easy: 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300',
  medium: 'bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300',
  hard: 'bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300',
};

// ─── Component ────────────────────────────────────────────────────

export function MCQ(props: MCQProps) {
  const { type = 'SBA', difficulty = 'medium', topics = [] } = props;
  const { stem, options: staticOptions, correctLabel: staticCorrectLabel, context: explanation } = normalizeInput(props);
  const [expandedOptions, setExpandedOptions] = useState<Set<string>>(new Set());
  const [shuffleEpoch] = useState(() => Date.now());
  const containerRef = useRef<HTMLDivElement>(null);

  // Shuffle options deterministically per mount
  const { shuffledOptions, correctLabel } = useMemo(() => {
    const seed = `${stem}-${shuffleEpoch}`;
    const correctOpt = staticCorrectLabel
      ? staticOptions.find(o => o.label === staticCorrectLabel)
      : staticOptions.find(o => o.isCorrect);

    const shuffled = displaceFirst(
      shuffleWithSeed(staticOptions, seed),
      o => o === correctOpt,
      seed,
    );

    const newCorrectIndex = correctOpt ? shuffled.indexOf(correctOpt) : 0;
    return {
      shuffledOptions: shuffled.map((opt, idx) => ({
        ...opt,
        originalLabel: opt.label,
        label: optionLabel(idx),
      })),
      correctLabel: optionLabel(newCorrectIndex),
    };
  }, [staticOptions, staticCorrectLabel, stem, shuffleEpoch]);

  const {
    selectedAnswer,
    showResult,
    hasAnswered,
    isCorrect,
    handleOptionClick,
    handleReset: resetMCQState,
  } = useMCQState({ correctLabel });

  const handleReset = () => {
    resetMCQState();
    setExpandedOptions(new Set());
  };

  // Keyboard: 1-5 to select options
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) return;

      const keyNum = parseInt(e.key);
      if (!hasAnswered && keyNum >= 1 && keyNum <= shuffledOptions.length) {
        e.preventDefault();
        handleOptionClick(optionLabel(keyNum - 1));
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [hasAnswered, shuffledOptions.length, handleOptionClick]);

  return (
    <div ref={containerRef} className="my-8 rounded-2xl bg-[var(--md-surface-container-low)] border border-[var(--md-outline-variant)] overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-[var(--md-surface-container)] border-b border-[var(--md-outline-variant)]">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-3 py-1 text-xs font-bold rounded-full bg-[var(--md-primary)] text-[var(--md-on-primary)]">{type}</span>
            <span className={`px-3 py-1 text-xs font-medium rounded-full ${difficultyColors[difficulty] || difficultyColors.medium}`}>{difficulty}</span>
            {topics.map(topic => (
              <span key={topic} className="px-3 py-1 text-xs font-medium rounded-full bg-[var(--md-secondary-container)] text-[var(--md-on-secondary-container)]">{topic}</span>
            ))}
          </div>
          <ContentFlag targetType="component" targetId={`MCQ:${stem.slice(0, 50)}`} componentType="MCQ" />
        </div>
      </div>

      {/* Stem */}
      <div className="px-6 py-5 text-[var(--md-on-surface)] whitespace-pre-wrap">{stem}</div>

      {/* Options */}
      <div className="px-6 pb-6 space-y-3">
        {shuffledOptions.map((option, idx) => {
          const hasExplanation = hasAnswered && !!option.explanation;
          const isExpanded = expandedOptions.has(option.label);
          const isSelected = selectedAnswer === option.label;
          const isCorrectOption = option.label === correctLabel;

          let style = 'w-full flex items-start gap-3 px-4 py-3 rounded-xl border text-left transition-all ';
          if (!hasAnswered) {
            style += 'border-[var(--md-outline-variant)] hover:border-[var(--md-primary)] hover:bg-[var(--md-primary-container)]/30 cursor-pointer';
          } else if (isCorrectOption) {
            style += 'border-green-500 bg-green-50 dark:bg-green-900/20';
          } else if (isSelected) {
            style += 'border-red-500 bg-red-50 dark:bg-red-900/20';
          } else {
            style += 'border-[var(--md-outline-variant)] opacity-60';
          }

          let labelStyle = 'flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ';
          if (!hasAnswered) {
            labelStyle += 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface)]';
          } else if (isCorrectOption) {
            labelStyle += 'bg-green-500 text-white';
          } else if (isSelected) {
            labelStyle += 'bg-red-500 text-white';
          } else {
            labelStyle += 'bg-[var(--md-surface-container-high)] text-[var(--md-on-surface-variant)]';
          }

          return (
            <div key={option.label}>
              <button
                onClick={() => {
                  if (!hasAnswered) handleOptionClick(option.label);
                  else if (hasExplanation) setExpandedOptions(prev => {
                    const next = new Set(prev);
                    next.has(option.label) ? next.delete(option.label) : next.add(option.label);
                    return next;
                  });
                }}
                disabled={hasAnswered && !hasExplanation}
                className={style}
              >
                <span className={labelStyle}>{!hasAnswered ? idx + 1 : option.label}</span>
                <span className="text-[var(--md-on-surface)] pt-1 flex-1">{option.text}</span>
                {hasAnswered && isCorrectOption && (
                  <span className="ml-auto text-green-600 dark:text-green-400 flex-shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6L9 17l-5-5" /></svg>
                  </span>
                )}
                {hasAnswered && isSelected && !isCorrectOption && (
                  <span className="ml-auto text-red-600 dark:text-red-400 flex-shrink-0">
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M18 6L6 18M6 6l12 12" /></svg>
                  </span>
                )}
                {hasExplanation && (
                  <span className={`ml-auto text-[var(--md-on-surface-variant)] flex-shrink-0 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 9l6 6 6-6" /></svg>
                  </span>
                )}
              </button>
              {hasExplanation && isExpanded && (
                <div className="mt-1 ml-11 mr-4 px-3 py-2 text-sm text-[var(--md-on-surface-variant)] bg-[var(--md-surface-container)] rounded-lg leading-relaxed">
                  {option.explanation}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Keyboard hint */}
      {!hasAnswered && (
        <div className="px-6 pb-4 text-xs text-[var(--md-on-surface-variant)] text-center">
          Press 1-{shuffledOptions.length} to answer
        </div>
      )}

      {/* Result */}
      {showResult && (
        <div className={`px-6 py-5 border-t ${isCorrect ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800' : 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'}`}>
          <div className="flex items-center gap-2 mb-3">
            {isCorrect ? (
              <span className="font-bold text-green-700 dark:text-green-300">Correct!</span>
            ) : (
              <span className="font-bold text-red-700 dark:text-red-300">Incorrect — The answer is {correctLabel}</span>
            )}
          </div>
          {explanation && (
            <div className="text-[var(--md-on-surface)] leading-relaxed">{explanation}</div>
          )}
          <button onClick={handleReset} className="mt-4 px-4 py-2 text-sm font-medium rounded-lg border border-[var(--md-outline)] text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container)]">
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
