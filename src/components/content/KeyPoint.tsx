'use client';

import { type ReactNode } from 'react';
import { ContentFlag } from './ContentFlag';
import { transformClozeChildren } from './transformClozeChildren';

interface KeyPointProps {
  children: ReactNode;
  title?: string;
}

export function KeyPoint({ children, title }: KeyPointProps) {
  return (
    <div className="my-4 rounded-r-lg border-l-4 border-l-[var(--keypoint-border)] bg-[var(--keypoint-bg)] p-4">
      <div className="float-right ml-2 mb-1">
        <ContentFlag targetType="component" targetId={`KeyPoint:${title || ''}`} componentType="KeyPoint" />
      </div>
      {title && (
        <span className="mb-2 block font-semibold text-[var(--md-primary)]">{title}</span>
      )}
      <div className="text-[var(--md-on-surface)]">{transformClozeChildren(children)}</div>
    </div>
  );
}
