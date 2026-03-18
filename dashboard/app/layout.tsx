import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CKG Dashboard',
  description: 'Context Knowledge Graph — grep finds what code does, we record why it was written that way',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
      </head>
      <body className="antialiased">
        <div className="min-h-screen">
          <nav className="border-b border-[--color-border] px-6 py-4">
            <div className="max-w-6xl mx-auto flex items-center justify-between">
              <a href="/" className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-[--color-accent] flex items-center justify-center text-white font-bold text-sm">CK</div>
                <div>
                  <div className="font-semibold text-sm">Context Knowledge Graph</div>
                  <div className="text-xs text-[--color-text-muted]">Decision Graph Manager</div>
                </div>
              </a>
            </div>
          </nav>
          <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
        </div>
      </body>
    </html>
  )
}
