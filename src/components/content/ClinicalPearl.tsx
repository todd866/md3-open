'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { transformClozeChildren } from './transformClozeChildren';

interface ClinicalPearlProps {
  children: ReactNode;
}

export function ClinicalPearl({ children }: ClinicalPearlProps) {
  return (
    <div className="my-4 rounded-r-lg border-l-4 border-l-[var(--pearl-border)] bg-[var(--pearl-bg)] p-4">
      <div className="float-right ml-2 mb-1">
        <ContentFlag targetType="component" targetId="ClinicalPearl" componentType="ClinicalPearl" />
      </div>
      <span className="mb-1 block font-semibold text-[var(--md-success)]">Clinical Pearl</span>
      <div className="text-[var(--md-on-surface)]">{transformClozeChildren(children)}</div>
    </div>
  );
}
