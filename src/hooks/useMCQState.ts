'use client';

import { useState, useCallback } from 'react';

// ─── Types ──────────────────────────────────────────────────────

export interface UseMCQStateOptions {
  correctLabel: string;
  /** Called when the user selects an answer */
  onSubmit?: (data: { label: string; correct: boolean }) => void;
}

export interface UseMCQStateReturn {
  selectedAnswer: string | null;
  showResult: boolean;
  hasAnswered: boolean;
  isCorrect: boolean;
  handleOptionClick: (label: string) => void;
  handleReset: () => void;
}

// ─── Hook ───────────────────────────────────────────────────────

/**
 * Shared MCQ answer state management.
 *
 * Manages the core selected/answered/result state that both the
 * content MCQ component and the review page need. Keeps UI components
 * focused on rendering rather than duplicating state logic.
 */
export function useMCQState({
  correctLabel,
  onSubmit,
}: UseMCQStateOptions): UseMCQStateReturn {
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [showResult, setShowResult] = useState(false);
  const [hasAnswered, setHasAnswered] = useState(false);

  const isCorrect = selectedAnswer === correctLabel;

  const handleOptionClick = useCallback(
    (label: string) => {
      if (hasAnswered) return;

      setSelectedAnswer(label);
      setShowResult(true);
      setHasAnswered(true);

      onSubmit?.({ label, correct: label === correctLabel });
    },
    [hasAnswered, correctLabel, onSubmit],
  );

  const handleReset = useCallback(() => {
    setSelectedAnswer(null);
    setShowResult(false);
    setHasAnswered(false);
  }, []);

  return {
    selectedAnswer,
    showResult,
    hasAnswered,
    isCorrect,
    handleOptionClick,
    handleReset,
  };
}
