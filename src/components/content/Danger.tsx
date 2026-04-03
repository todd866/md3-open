'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { transformClozeChildren } from './transformClozeChildren';

interface DangerProps {
  children: ReactNode;
  title?: string;
}

export function Danger({ children, title = 'Warning' }: DangerProps) {
  return (
    <div className="my-4 rounded-r-lg border-l-4 border-l-[var(--danger-border)] bg-[var(--danger-bg)] p-4">
      <div className="float-right ml-2 mb-1">
        <ContentFlag targetType="component" targetId={`Danger:${title}`} componentType="Danger" />
      </div>
      <span className="mb-1 block font-semibold text-[var(--md-error)]">{title}</span>
      <div className="text-[var(--md-on-surface)]">{transformClozeChildren(children)}</div>
    </div>
  );
}
