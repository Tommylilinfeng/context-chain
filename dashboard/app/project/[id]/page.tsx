'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'

// ── Types ────────────────────────────────────

interface RepoInfo {
  id: string; name: string; path: string; type: string; language: string
  src_dirs: string[]; exclude_dirs: string[]; has_db_code: number; db_dirs: string[]
  owner: string; last_ingested_at: string | null
}
interface ProjectDetail {
  id: string; name: string; description: string
  memgraph_port: number; lab_port: number; status: string; repos: RepoInfo[]
}
interface ProgressEvent {
  step: string; status: 'running' | 'done' | 'error' | 'skipped'; message: string; progress?: number
}
interface Stats {
  entities: { type: string; count: number }[]
  edges: { type: string; count: number }[]
  decisions: { total: number; auto: number; business: number; anchored: number }
}
interface Decision {
  id: string; summary: string; content: string; keywords: string[]; source: string
  confidence: string; owner: string; scope: string[]; created_at: string; anchors: string[]
}
interface CoverageData {
  repos: { repo: string; entities: number }[]
  files: { name: string; path: string; decisions: number }[]
  selectedRepo: string
}

type Tab = 'overview' | 'decisions' | 'coverage' | 'settings'

const STEP_LABELS: Record<string, string> = {
  docker: 'Start Memgraph', schema: 'Initialize Schema', cpg: 'Generate Code Structure',
  coldstart: 'Cold Start (Extract Decisions)', sessions: 'AI Session Ingestion', complete: 'Done',
}
const STEP_ORDER = ['docker', 'schema', 'cpg', 'coldstart', 'sessions', 'complete']
const LANG: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', unknown: 'Unknown' }
const TYPE: Record<string, string> = { frontend: 'Frontend', backend: 'Backend', 'shared-lib': 'Shared Lib', infra: 'Infra', unknown: 'Unknown' }

export default function ProjectDetailPage() {
  const params = useParams()
  const router = useRouter()
  const id = params.id as string
  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [statsError, setStatsError] = useState('')

  // Init progress
  const [initializing, setInitializing] = useState(false)
  const [steps, setSteps] = useState<Record<string, ProgressEvent>>({})
  const [currentStep, setCurrentStep] = useState('')

  // Data tabs
  const [stats, setStats] = useState<Stats | null>(null)
  const [decisions, setDecisions] = useState<Decision[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [coverage, setCoverage] = useState<CoverageData | null>(null)
  const [covRepo, setCovRepo] = useState('')

  const load = useCallback(() => {
    fetch(`/api/projects/${id}`)
      .then(r => { if (!r.ok) throw new Error('not found'); return r.json() })
      .then(setProject)
      .catch(() => router.push('/'))
      .finally(() => setLoading(false))
  }, [id, router])

  useEffect(() => { load() }, [load])

  // Load stats — validate response shape
  useEffect(() => {
    if (tab === 'overview' && project?.status === 'running') {
      setStatsError('')
      fetch(`/api/projects/${id}/stats`)
        .then(r => r.json())
        .then(data => {
          if (data.entities && data.edges && data.decisions) {
            setStats(data)
          } else if (data.error) {
            setStatsError(data.error)
          }
        })
        .catch(() => setStatsError('Failed to connect to Memgraph'))
    }
  }, [tab, id, project?.status])

  // Load decisions — validate response is array
  useEffect(() => {
    if (tab === 'decisions' && project?.status === 'running') {
      const p = searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''
      fetch(`/api/projects/${id}/decisions${p}`)
        .then(r => r.json())
        .then(data => { if (Array.isArray(data)) setDecisions(data) })
        .catch(() => {})
    }
  }, [tab, id, project?.status, searchQuery])

  // Load coverage — validate response shape
  useEffect(() => {
    if (tab === 'coverage' && project?.status === 'running') {
      const p = covRepo ? `?repo=${encodeURIComponent(covRepo)}` : ''
      fetch(`/api/projects/${id}/coverage${p}`)
        .then(r => r.json())
        .then(data => {
          if (data.repos && data.files) {
            setCoverage(data)
            if (!covRepo && data.selectedRepo) setCovRepo(data.selectedRepo)
          }
        })
        .catch(() => {})
    }
  }, [tab, id, project?.status, covRepo])

  // ── Init (SSE) ─────────────────────────────

  async function startInit() {
    setInitializing(true); setSteps({}); setCurrentStep('')
    try {
      const res = await fetch(`/api/projects/${id}/init`, { method: 'POST' })
      const reader = res.body?.getReader()
      if (!reader) return
      const decoder = new TextDecoder()
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n'); buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event: ProgressEvent = JSON.parse(line.slice(6))
              setSteps(prev => ({ ...prev, [event.step]: event }))
              setCurrentStep(event.step)
            } catch {}
          }
        }
      }
    } catch (err: any) {
      setSteps(prev => ({ ...prev, error: { step: 'error', status: 'error', message: err.message } }))
    } finally { setInitializing(false); load() }
  }

  async function doAction(action: string) {
    setActionLoading(action)
    try {
      await fetch(`/api/projects/${id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action }) })
      if (action === 'start') await new Promise(r => setTimeout(r, 3000))
      load()
    } finally { setActionLoading('') }
  }

  async function deleteProject() {
    if (!confirm(`Delete project "${project?.name}"? Containers will be stopped.`)) return
    await fetch(`/api/projects/${id}`, { method: 'DELETE' })
    router.push('/')
  }

  if (loading || !project) return <div className="text-center py-24 text-[--color-text-muted]">Loading...</div>

  const running = project.status === 'running'
  const hasProgress = Object.keys(steps).length > 0
  const srcLabel = (s: string) => ({ cold_start: 'Cold Start', claude_code_session: 'Session', manual_business_context: 'Business' }[s] || s)
  const srcBadge = (s: string) => ({ cold_start: 'bg-yellow-500/15 text-yellow-400', claude_code_session: 'bg-blue-500/15 text-blue-400', manual_business_context: 'bg-green-500/15 text-green-400' }[s] || 'bg-gray-500/15 text-gray-400')

  const tabList: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'decisions', label: `Decisions${stats ? ` (${stats.decisions.total})` : ''}` },
    { id: 'coverage', label: 'Coverage' },
    { id: 'settings', label: 'Settings' },
  ]

  return (
    <div>
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <a href="/" className="text-[--color-text-muted] hover:text-[--color-text] text-sm">← Projects</a>
          <h1 className="text-2xl font-bold flex items-center gap-3 mt-1">
            {project.name}
            <span className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-medium ${running ? 'bg-green-500/15 text-green-400' : 'bg-gray-500/15 text-gray-400'}`}>
              {running ? '● Running' : '○ Stopped'}
            </span>
          </h1>
          {project.description && <p className="text-sm text-[--color-text-muted] mt-1">{project.description}</p>}
        </div>
        <div className="flex gap-2">
          {!initializing && (
            <>
              {running ? (
                <button onClick={() => doAction('stop')} disabled={!!actionLoading} className="px-4 py-2 rounded-lg border border-[--color-border] text-sm font-medium hover:bg-[--color-surface-2] disabled:opacity-40 transition-colors">
                  {actionLoading === 'stop' ? 'Stopping...' : 'Stop'}
                </button>
              ) : (
                <button onClick={() => doAction('start')} disabled={!!actionLoading} className="px-4 py-2 rounded-lg border border-[--color-border] text-sm font-medium hover:bg-[--color-surface-2] disabled:opacity-40 transition-colors">
                  {actionLoading === 'start' ? 'Starting...' : 'Start'}
                </button>
              )}
              <button onClick={startInit} disabled={!!actionLoading} className="px-4 py-2 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] text-white text-sm font-medium disabled:opacity-40 transition-colors">
                🚀 Initialize
              </button>
            </>
          )}
          {initializing && <span className="px-4 py-2 text-sm text-[--color-text-muted]">Initializing...</span>}
        </div>
      </div>

      {/* Progress panel */}
      {(initializing || hasProgress) && (
        <div className="border border-[--color-border] rounded-xl bg-[--color-surface] mb-6 overflow-hidden">
          <div className="px-5 py-3 border-b border-[--color-border] flex items-center justify-between">
            <div className="font-semibold text-sm">
              {initializing ? '🔄 Initializing...' : steps.complete?.status === 'done' ? '✅ Complete' : '⚠️ Incomplete'}
            </div>
            {!initializing && hasProgress && (
              <button onClick={() => setSteps({})} className="text-xs text-[--color-text-muted] hover:text-[--color-text]">Clear</button>
            )}
          </div>
          <div className="p-5 space-y-1">
            {STEP_ORDER.filter(s => s !== 'complete').map(stepId => {
              const event = steps[stepId]
              const isActive = currentStep === stepId && initializing
              let icon = '○', tc = 'text-[--color-text-muted]'
              if (event?.status === 'done') { icon = '✓'; tc = 'text-green-400' }
              else if (event?.status === 'error') { icon = '✗'; tc = 'text-[--color-danger]' }
              else if (event?.status === 'skipped') { icon = '—'; tc = 'text-[--color-text-muted]' }
              else if (event?.status === 'running' || isActive) { icon = '◌'; tc = 'text-[--color-accent]' }
              return (
                <div key={stepId} className="py-2">
                  <div className="flex items-center gap-3">
                    <span className={`w-5 text-center font-mono text-sm ${tc}`}>{icon}</span>
                    <span className={`text-sm font-medium ${event ? 'text-[--color-text]' : 'text-[--color-text-muted]'}`}>{STEP_LABELS[stepId]}</span>
                    {isActive && <span className="inline-block w-1.5 h-1.5 rounded-full bg-[--color-accent] animate-pulse" />}
                  </div>
                  {event && (
                    <div className="ml-8 mt-1">
                      <div className={`text-xs ${tc}`}>{event.message}</div>
                      {event.progress !== undefined && event.status === 'running' && (
                        <div className="mt-1.5 h-1.5 rounded-full bg-[--color-surface-2] overflow-hidden w-64">
                          <div className="h-full rounded-full bg-[--color-accent] transition-all duration-500" style={{ width: `${event.progress}%` }} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-6 border-b border-[--color-border] mb-6">
        {tabList.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`pb-3 text-sm font-medium transition-colors ${tab === t.id ? 'border-b-2 border-[--color-accent] text-[--color-accent]' : 'text-[--color-text-muted] hover:text-[--color-text]'}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ═══════ Overview Tab ═══════ */}
      {tab === 'overview' && (
        <div>
          <div className="grid grid-cols-3 gap-4 mb-8">
            <div className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
              <div className="text-xs text-[--color-text-muted] mb-1">Memgraph Bolt</div>
              <div className="font-mono text-sm">bolt://localhost:{project.memgraph_port}</div>
            </div>
            <div className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
              <div className="text-xs text-[--color-text-muted] mb-1">Memgraph Lab</div>
              <a href={`http://localhost:${project.lab_port}`} target="_blank" rel="noopener noreferrer" className="font-mono text-sm text-[--color-accent] hover:underline">
                http://localhost:{project.lab_port}
              </a>
            </div>
            <div className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
              <div className="text-xs text-[--color-text-muted] mb-1">Repositories</div>
              <div className="font-semibold text-lg">{project.repos.length}</div>
            </div>
          </div>

          {/* Stats */}
          {statsError && (
            <div className="border border-[--color-warning]/30 rounded-xl p-4 bg-[--color-warning]/5 mb-8 text-sm text-[--color-warning]">
              Could not load stats: {statsError}
            </div>
          )}

          {stats && stats.entities && (
            <div className="grid grid-cols-4 gap-4 mb-8">
              {[
                ['Code Entities', (stats.entities || []).reduce((s, e) => s + e.count, 0), 'text-blue-400'],
                ['Decisions', stats.decisions?.total ?? 0, 'text-green-400'],
                ['Anchored', stats.decisions?.anchored ?? 0, 'text-yellow-400'],
                ['Edges', (stats.edges || []).reduce((s, e) => s + e.count, 0), 'text-purple-400'],
              ].map(([label, val, color]) => (
                <div key={label as string} className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
                  <div className={`text-2xl font-bold ${color}`}>{val}</div>
                  <div className="text-xs text-[--color-text-muted] mt-1">{label}</div>
                </div>
              ))}
            </div>
          )}

          {!running && !stats && (
            <div className="border border-dashed border-[--color-border] rounded-xl p-8 text-center text-[--color-text-muted] text-sm mb-8">
              Start Memgraph to see graph statistics
            </div>
          )}

          <h2 className="text-lg font-semibold mb-4">Repositories</h2>
          <div className="space-y-3 mb-8">
            {project.repos.map(r => (
              <div key={r.id} className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
                <div className="flex items-start justify-between mb-2">
                  <div>
                    <div className="font-semibold">{r.name}</div>
                    <div className="text-xs text-[--color-text-muted] font-mono">{r.path}</div>
                  </div>
                  <div className="flex gap-2">
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400">{LANG[r.language] || r.language}</span>
                    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/15 text-purple-400">{TYPE[r.type] || r.type}</span>
                  </div>
                </div>
                {r.src_dirs.length > 0 && <div className="text-xs text-[--color-text-muted]"><span className="font-medium text-[--color-text]">Logic dirs: </span>{r.src_dirs.join(', ')}</div>}
                {r.has_db_code === 1 && <div className="text-xs text-yellow-400 mt-1"><span className="font-medium">DB code: </span>{r.db_dirs.join(', ')}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ═══════ Decisions Tab ═══════ */}
      {tab === 'decisions' && (
        <div>
          <div className="flex gap-3 mb-6">
            <input type="text" value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search decisions..."
              className="flex-1 px-3 py-2 rounded-lg bg-[--color-surface] border border-[--color-border] text-[--color-text] placeholder:text-[--color-text-muted] focus:outline-none focus:border-[--color-accent] text-sm" />
          </div>
          {!running ? (
            <div className="text-center py-12 text-[--color-text-muted]">Start Memgraph to view decisions</div>
          ) : decisions.length === 0 ? (
            <div className="text-center py-12 text-[--color-text-muted]">No decisions found. Run initialization first.</div>
          ) : (
            <>
              <div className="text-sm text-[--color-text-muted] mb-3">{decisions.length} decisions</div>
              <div className="space-y-3">
                {decisions.map(d => (
                  <div key={d.id} className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
                    <div className="flex items-start justify-between mb-2">
                      <div className="font-medium text-sm">{d.summary}</div>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${srcBadge(d.source)} whitespace-nowrap ml-3`}>
                        {srcLabel(d.source)}
                      </span>
                    </div>
                    <div className="text-xs text-[--color-text-muted] mb-2">{d.content}</div>
                    <div className="flex gap-1.5 flex-wrap">
                      {d.keywords?.map(k => <span key={k} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-500/15 text-blue-400">{k}</span>)}
                      {d.anchors?.filter(Boolean).map(a => <span key={a} className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-yellow-500/15 text-yellow-400">📎 {a}</span>)}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════ Coverage Tab ═══════ */}
      {tab === 'coverage' && (
        <div>
          {!running ? (
            <div className="text-center py-12 text-[--color-text-muted]">Start Memgraph to view coverage</div>
          ) : coverage && coverage.files ? (
            <>
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold">Knowledge Coverage Map</h2>
                {coverage.repos.length > 0 && (
                  <select value={covRepo} onChange={e => setCovRepo(e.target.value)}
                    className="px-3 py-1.5 rounded-lg bg-[--color-surface] border border-[--color-border] text-sm">
                    {coverage.repos.map(r => <option key={r.repo} value={r.repo}>{r.repo}</option>)}
                  </select>
                )}
              </div>
              {coverage.files.length === 0 ? (
                <div className="text-center py-12 text-[--color-text-muted]">No code entities found. Run initialization first.</div>
              ) : (
                <>
                  <div className="space-y-1.5">
                    {coverage.files.map(f => {
                      const max = Math.max(...coverage.files.map(x => x.decisions), 1)
                      return (
                        <div key={f.name} className="flex items-center gap-3">
                          <div className="w-44 text-xs font-mono truncate text-[--color-text-muted]">{f.name}</div>
                          <div className="flex-1 h-1.5 rounded-full bg-[--color-surface-2] overflow-hidden">
                            <div className="h-full rounded-full transition-all" style={{
                              width: `${Math.max((f.decisions / max) * 100, f.decisions > 0 ? 4 : 0)}%`,
                              background: f.decisions === 0 ? '#ef4444' : f.decisions < 2 ? '#f59e0b' : '#22c55e',
                            }} />
                          </div>
                          <div className="w-6 text-right text-xs font-mono text-[--color-text-muted]">{f.decisions}</div>
                        </div>
                      )
                    })}
                  </div>
                  <div className="mt-4 text-xs text-[--color-text-muted]">
                    {coverage.files.filter(f => f.decisions === 0).length} files with no coverage
                  </div>
                </>
              )}
            </>
          ) : <div className="text-center py-12 text-[--color-text-muted]">Loading...</div>}
        </div>
      )}

      {/* ═══════ Settings Tab ═══════ */}
      {tab === 'settings' && (
        <div className="space-y-8">
          <div>
            <h2 className="text-lg font-semibold mb-4">MCP Configuration</h2>
            <div className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
              <p className="text-sm text-[--color-text-muted] mb-3">
                Add to your repo&apos;s <code className="font-mono bg-[--color-surface-2] px-1.5 py-0.5 rounded">.mcp.json</code>:
              </p>
              <pre className="text-xs font-mono bg-[--color-bg] p-3 rounded-lg overflow-x-auto">
{JSON.stringify({
  mcpServers: {
    'context-knowledge-graph': {
      command: '/bin/bash',
      args: ['~/dev/context-knowledge-graph/mcp-start.sh'],
      env: { CKG_MEMGRAPH_PORT: String(project.memgraph_port) },
    }
  }
}, null, 2)}
              </pre>
            </div>
          </div>

          <div className="border border-[--color-danger]/30 rounded-xl p-5 bg-[--color-danger]/5">
            <h2 className="text-lg font-semibold mb-3 text-[--color-danger]">Danger Zone</h2>
            <div className="flex gap-3">
              <button onClick={() => doAction('reset')} disabled={!!actionLoading || initializing}
                className="px-4 py-2 rounded-lg border border-[--color-danger]/30 text-[--color-danger] text-sm font-medium hover:bg-[--color-danger]/10 disabled:opacity-40 transition-colors">
                {actionLoading === 'reset' ? 'Resetting...' : 'Reset Graph Data'}
              </button>
              <button onClick={deleteProject} disabled={initializing}
                className="px-4 py-2 rounded-lg bg-[--color-danger] text-white text-sm font-medium hover:brightness-110 disabled:opacity-40 transition-all">
                Delete Project
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
