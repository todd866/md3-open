import { notFound } from 'next/navigation';

// Map week numbers to their MDX content modules
// Paths are relative from project root via dynamic import
const weekModules: Record<number, () => Promise<{ default: React.ComponentType }>> = {
  1: () => import('../../../../../content/example-rotation/week1-oxygen-therapy.mdx'),
  2: () => import('../../../../../content/example-rotation/week2-fluid-resuscitation.mdx'),
  3: () => import('../../../../../content/example-rotation/week3-shock-management.mdx'),
};

export default async function WeekPage({ params }: { params: Promise<{ num: string }> }) {
  const { num } = await params;
  const weekNum = parseInt(num, 10);

  if (!weekModules[weekNum]) {
    notFound();
  }

  const { default: Content } = await weekModules[weekNum]();

  return (
    <article className="prose-custom">
      <Content />
    </article>
  );
}

export function generateStaticParams() {
  return Object.keys(weekModules).map(num => ({ num }));
}
