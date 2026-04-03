import type { Metadata } from "next";
import "./globals.css";
import Link from "next/link";

export const metadata: Metadata = {
  title: "MD3 Open",
  description: "Open-source medical education platform with spaced repetition",
};

function Navigation() {
  return (
    <nav className="sticky top-0 z-10 border-b border-[var(--md-outline-variant)] bg-[var(--md-surface)]">
      <div className="max-w-4xl mx-auto px-4 h-14 flex items-center justify-between">
        <Link href="/" className="text-lg font-bold text-[var(--md-primary)]">
          MD3 Open
        </Link>
        <div className="flex items-center gap-4">
          <Link href="/content" className="text-sm text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]">
            Content
          </Link>
          <Link href="/review" className="text-sm text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]">
            Review
          </Link>
          <Link href="/profile" className="text-sm text-[var(--md-on-surface-variant)] hover:text-[var(--md-primary)]">
            Profile
          </Link>
        </div>
      </div>
    </nav>
  );
}

function ThemeScript() {
  // Inline script to prevent flash of wrong theme on page load.
  // This is safe because the content is a static string, not user input.
  const themeJs = `try{var t=localStorage.getItem('theme');if(t==='dark'||(!t&&window.matchMedia('(prefers-color-scheme:dark)').matches))document.documentElement.classList.add('dark')}catch(e){}`;
  return <script dangerouslySetInnerHTML={{ __html: themeJs }} />;
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body className="antialiased min-h-screen">
        <Navigation />
        <main className="max-w-4xl mx-auto px-4 py-8">
          {children}
        </main>
      </body>
    </html>
  );
}
