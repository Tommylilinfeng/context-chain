'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'

interface Project {
  id: string; name: string; description: string
  memgraph_port: number; lab_port: number; status: string; created_at: string
}

export default function HomePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(setProjects).finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="flex items-center justify-center py-24 text-[--color-text-muted]">Loading...</div>

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Projects</h1>
          <p className="text-sm text-[--color-text-muted] mt-1">Each project has its own Memgraph instance and decision graph</p>
        </div>
        <Link href="/project/new" className="px-4 py-2 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] text-white font-medium text-sm transition-colors">
          + New Project
        </Link>
      </div>

      {projects.length === 0 ? (
        <div className="border border-dashed border-[--color-border] rounded-xl p-16 text-center">
          <div className="text-4xl mb-4">📦</div>
          <div className="text-lg font-medium mb-2">No projects yet</div>
          <div className="text-sm text-[--color-text-muted] mb-6">Create a project, add repos, and start building your decision graph</div>
          <Link href="/project/new" className="inline-block px-5 py-2.5 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] text-white font-medium text-sm transition-colors">
            Create Your First Project
          </Link>
        </div>
      ) : (
        <div className="grid gap-4">
          {projects.map(p => (
            <Link key={p.id} href={`/project/${p.id}`} className="block border border-[--color-border] rounded-xl p-5 hover:border-[--color-accent] transition-colors bg-[--color-surface]">
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h2 className="font-semibold text-lg">{p.name}</h2>
                    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${p.status === 'running' ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'}`}>
                      {p.status === 'running' ? '● Running' : '○ Stopped'}
                    </span>
                  </div>
                  {p.description && <p className="text-sm text-[--color-text-muted]">{p.description}</p>}
                </div>
                <div className="text-right text-xs text-[--color-text-muted]">
                  <div>Port {p.memgraph_port}</div>
                  <div>Lab {p.lab_port}</div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
