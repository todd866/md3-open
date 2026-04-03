import type { MDXComponents } from 'mdx/types';
import { isValidElement, type ReactNode } from 'react';
import { transformClozeChildren } from '@/components/content/transformClozeChildren';
import { KeyPoint } from '@/components/content/KeyPoint';
import { ClinicalPearl } from '@/components/content/ClinicalPearl';
import { Danger } from '@/components/content/Danger';
import { Mnemonic } from '@/components/content/Mnemonic';
import { MCQ } from '@/components/content/MCQ';

function extractText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (isValidElement(node)) return extractText((node.props as { children?: ReactNode }).children);
  return '';
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
}

export function useMDXComponents(components: MDXComponents): MDXComponents {
  return {
    ...components,

    // Custom medical education components
    KeyPoint,
    ClinicalPearl,
    Danger,
    Mnemonic,
    MCQ,

    // Styled HTML element overrides
    h1: ({ children }) => (
      <h1 className="text-3xl font-bold text-[var(--md-on-surface)] mb-4 mt-8 first:mt-0 first:hidden">
        {children}
      </h1>
    ),
    h2: ({ children, id, ...props }) => {
      const headingId = id || slugify(extractText(children)) || undefined;
      return (
        <h2 id={headingId} className="text-2xl font-bold text-[var(--md-secondary)] mb-3 mt-8 border-l-4 border-[var(--md-tertiary)] pl-4 scroll-mt-28" {...props}>
          {children}
        </h2>
      );
    },
    h3: ({ children }) => (
      <h3 className="text-xl font-semibold text-[var(--md-on-surface)] mb-2 mt-6">{children}</h3>
    ),
    p: ({ children }) => (
      <p className="text-[var(--md-on-surface)] mb-4 leading-relaxed">
        {transformClozeChildren(children)}
      </p>
    ),
    ul: ({ children }) => (
      <ul className="list-disc list-inside mb-4 space-y-1 text-[var(--md-on-surface)]">{children}</ul>
    ),
    ol: ({ children }) => (
      <ol className="list-decimal list-inside mb-4 space-y-1 text-[var(--md-on-surface)]">{children}</ol>
    ),
    li: ({ children }) => (
      <li className="ml-4">{transformClozeChildren(children)}</li>
    ),
    table: ({ children }) => (
      <div className="overflow-x-auto mb-4">
        <table className="w-full border-collapse border border-[var(--md-outline-variant)] rounded-lg overflow-hidden">
          {children}
        </table>
      </div>
    ),
    thead: ({ children }) => (
      <thead className="bg-[var(--md-secondary)] text-[var(--md-on-secondary)]">{children}</thead>
    ),
    th: ({ children }) => (
      <th className="border border-[var(--md-outline-variant)] px-4 py-2 text-left font-semibold">
        {transformClozeChildren(children)}
      </th>
    ),
    td: ({ children }) => (
      <td className="border border-[var(--md-outline-variant)] px-4 py-2">
        {transformClozeChildren(children)}
      </td>
    ),
    tr: ({ children }) => (
      <tr className="even:bg-[var(--md-surface-container)]">{children}</tr>
    ),
    code: ({ children }) => (
      <code className="bg-[var(--md-surface-container-high)] px-1.5 py-0.5 rounded text-sm font-mono">{children}</code>
    ),
    strong: ({ children }) => (
      <strong className="font-semibold text-[var(--md-on-surface)]">{children}</strong>
    ),
    a: ({ children, href }) => (
      <a href={href} className="text-[var(--md-primary)] hover:underline" target={href?.startsWith('http') ? '_blank' : undefined} rel={href?.startsWith('http') ? 'noopener noreferrer' : undefined}>
        {children}
      </a>
    ),
  };
}
