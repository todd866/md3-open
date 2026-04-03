'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';

const FLAG_REASONS = ['Context', 'Formatting', 'Giveaway', 'Rewrite', 'Other'] as const;
type FlagReason = (typeof FLAG_REASONS)[number];

interface ContentFlagProps {
  targetType: 'card' | 'question' | 'component' | 'page';
  targetId: string;
  componentType?: string;
  contentSnapshot?: string;
}

export function ContentFlag({ targetType, targetId, componentType, contentSnapshot }: ContentFlagProps) {
  const [open, setOpen] = useState(false);
  const [flagged, setFlagged] = useState(false);
  const [otherMode, setOtherMode] = useState(false);
  const [message, setMessage] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setOtherMode(false);
    setMessage('');
  }, []);

  const submitFlag = useCallback((reason: FlagReason, note?: string) => {
    setFlagged(true);
    closeMenu();
    fetch('/api/content/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: targetType, id: targetId, reason,
        context: { componentType, contentSnapshot },
        ...(note ? { message: note } : {}),
      }),
    }).catch(console.error);
  }, [targetType, targetId, componentType, contentSnapshot, closeMenu]);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) closeMenu();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeMenu();
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, closeMenu]);

  const handleMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (otherMode) return;
    const num = parseInt(e.key);
    if (num >= 1 && num <= FLAG_REASONS.length) {
      e.preventDefault();
      const reason = FLAG_REASONS[num - 1];
      if (reason === 'Other') { setOtherMode(true); return; }
      submitFlag(reason);
    }
  };

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        aria-label="Flag content"
        title={flagged ? 'Flag submitted' : 'Flag for improvement'}
        disabled={flagged}
        onClick={() => !flagged && setOpen(p => !p)}
        className={`p-1.5 rounded-md transition-colors ${
          flagged
            ? 'text-amber-600 bg-amber-100 dark:bg-amber-900/30'
            : 'text-[var(--md-on-surface-variant)] hover:bg-[var(--md-surface-container-high)]'
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill={flagged ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true">
          {flagged
            ? <path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6h-5.6z" />
            : <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /><line x1="4" y1="22" x2="4" y2="15" /></>
          }
        </svg>
      </button>

      {open && (
        <div
          ref={menuRef}
          tabIndex={-1}
          onKeyDown={handleMenuKeyDown}
          className="absolute right-0 mt-2 w-44 rounded-lg border border-[var(--md-outline-variant)] bg-[var(--md-surface)] shadow-lg z-20 p-2"
        >
          {!otherMode ? (
            <div className="space-y-1">
              {FLAG_REASONS.map((reason, i) => (
                <button
                  key={reason}
                  type="button"
                  onClick={() => reason === 'Other' ? setOtherMode(true) : submitFlag(reason)}
                  className="w-full text-left px-2 py-1.5 rounded-md text-sm text-[var(--md-on-surface)] hover:bg-[var(--md-surface-container-high)] flex items-center gap-2"
                >
                  <span className="text-xs font-medium w-4">{i + 1}</span>
                  {reason}
                </button>
              ))}
              <div className="text-[9px] text-[var(--md-on-surface-variant)] text-center pt-1">esc to cancel</div>
            </div>
          ) : (
            <div className="space-y-2">
              <textarea
                value={message}
                onChange={e => setMessage(e.target.value)}
                onKeyDown={e => {
                  e.stopPropagation();
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitFlag('Other', message); }
                }}
                rows={3}
                className="w-full rounded-md border border-[var(--md-outline-variant)] bg-[var(--md-surface-container-high)] p-2 text-sm resize-none"
                placeholder="Describe the issue..."
                autoFocus
              />
              <div className="flex gap-2">
                <button onClick={closeMenu} className="flex-1 py-1.5 rounded-md bg-[var(--md-surface-container-high)] text-xs">Cancel</button>
                <button onClick={() => submitFlag('Other', message)} className="flex-1 py-1.5 rounded-md bg-[var(--md-primary)] text-[var(--md-on-primary)] text-xs">Submit</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
