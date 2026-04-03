'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { transformClozeChildren } from './transformClozeChildren';

interface MnemonicProps {
  children: ReactNode;
  title?: string;
}

export function Mnemonic({ children, title }: MnemonicProps) {
  return (
    <div className="my-4 rounded-r-lg border-l-4 border-l-[var(--mnemonic-border)] bg-[var(--mnemonic-bg)] p-4">
      <div className="float-right ml-2 mb-1">
        <ContentFlag targetType="component" targetId={`Mnemonic:${title || ''}`} componentType="Mnemonic" />
      </div>
      <span className="mb-1 block font-semibold text-[#805ad5] dark:text-[#a78bfa]">
        {title || 'Mnemonic'}
      </span>
      <div className="text-[var(--md-on-surface)] font-mono">{transformClozeChildren(children)}</div>
    </div>
  );
}
