'use client'

import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'

interface ScanResult {
  name: string; path: string; language: string; type: string
  src_dirs: string[]; exclude_dirs: string[]; has_db_code: boolean; db_dirs: string[]
  file_count: number; warnings: string[]
}
interface BrowseDir { name: string; path: string; hasChildren: boolean; isRepo: boolean }
interface BrowseResult { current: string; parent: string | null; dirs: BrowseDir[] }

type Step = 'info' | 'repos' | 'confirm'

const LANG: Record<string, string> = { typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go', rust: 'Rust', java: 'Java', ruby: 'Ruby', unknown: 'Unknown' }
const TYPE: Record<string, string> = { frontend: 'Frontend', backend: 'Backend', 'shared-lib': 'Shared Lib', infra: 'Infra', unknown: 'Unknown' }

export default function NewProjectPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>('info')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [scanning, setScanning] = useState(false)
  const [repos, setRepos] = useState<ScanResult[]>([])
  const [scanError, setScanError] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [browseData, setBrowseData] = useState<BrowseResult | null>(null)
  const [browseLoading, setBrowseLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  async function browseTo(dirPath?: string) {
    setBrowseLoading(true)
    try {
      const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : ''
      const res = await fetch(`/api/browse${params}`)
      const data = await res.json()
      if (data.error) setScanError(data.error)
      else setBrowseData(data)
    } catch (err: any) { setScanError(err.message) }
    finally { setBrowseLoading(false) }
  }

  function selectAndScan(dirPath: string) {
    setRepoPath(dirPath); setShowBrowser(false); doScan(dirPath)
  }

  async function doScan(pathToScan?: string) {
    const p = (pathToScan || repoPath).trim()
    if (!p) return
    setScanning(true); setScanError('')
    try {
      const res = await fetch('/api/repos/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }) })
      const result: ScanResult = await res.json()
      if (result.warnings.some(w => w.includes('不存在') || w.includes('not exist'))) setScanError('Path does not exist')
      else { if (!repos.find(r => r.path === result.path)) setRepos(prev => [...prev, result]); setRepoPath('') }
    } catch (err: any) { setScanError(err.message) }
    finally { setScanning(false) }
  }

  async function createProject() {
    setCreating(true)
    try {
      const res = await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) })
      const project = await res.json()
      if (repos.length > 0) {
        await fetch('/api/repos', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project_id: project.id, repos: repos.map(r => ({ name: r.name, path: r.path, type: r.type, language: r.language, src_dirs: r.src_dirs, exclude_dirs: r.exclude_dirs, has_db_code: r.has_db_code, db_dirs: r.db_dirs })) })
        })
      }
      router.push(`/project/${project.id}`)
    } catch (err: any) { setScanError(err.message); setCreating(false) }
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold mb-2">New Project</h1>
      <p className="text-sm text-[--color-text-muted] mb-8">Add your repositories and the system will auto-detect their structure</p>

      {/* Steps */}
      <div className="flex items-center gap-2 mb-8">
        {(['info', 'repos', 'confirm'] as Step[]).map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
              step === s ? 'bg-[--color-accent] text-white' : i < ['info', 'repos', 'confirm'].indexOf(step) ? 'bg-[--color-success] text-white' : 'bg-[--color-surface-2] text-[--color-text-muted]'
            }`}>{i + 1}</div>
            <span className={`text-sm ${step === s ? 'text-[--color-text]' : 'text-[--color-text-muted]'}`}>
              {['Info', 'Repositories', 'Confirm'][i]}
            </span>
            {i < 2 && <div className="w-8 h-px bg-[--color-border]" />}
          </div>
        ))}
      </div>

      {/* Step 1 */}
      {step === 'info' && (
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium mb-1.5">Project Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. bite, my-saas-app"
              className="w-full px-3 py-2 rounded-lg bg-[--color-surface] border border-[--color-border] text-[--color-text] placeholder:text-[--color-text-muted] focus:outline-none focus:border-[--color-accent]" />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1.5">Description (optional)</label>
            <input type="text" value={description} onChange={e => setDescription(e.target.value)} placeholder="Brief project description"
              className="w-full px-3 py-2 rounded-lg bg-[--color-surface] border border-[--color-border] text-[--color-text] placeholder:text-[--color-text-muted] focus:outline-none focus:border-[--color-accent]" />
          </div>
          <div className="flex justify-end">
            <button onClick={() => setStep('repos')} disabled={!name.trim()}
              className="px-5 py-2 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors">Next</button>
          </div>
        </div>
      )}

      {/* Step 2 */}
      {step === 'repos' && (
        <div className="space-y-5">
          {repos.length > 0 && (
            <div>
              <div className="text-sm font-medium mb-2 text-[--color-text-muted]">{repos.length} {repos.length === 1 ? 'repository' : 'repositories'} added</div>
              <div className="space-y-3">
                {repos.map(r => (
                  <div key={r.path} className="border border-[--color-border] rounded-xl p-4 bg-[--color-surface]">
                    <div className="flex items-start justify-between mb-2">
                      <div>
                        <div className="font-semibold">{r.name}</div>
                        <div className="text-xs text-[--color-text-muted] font-mono mt-0.5">{r.path}</div>
                      </div>
                      <button onClick={() => setRepos(repos.filter(x => x.path !== r.path))} className="text-xs text-[--color-text-muted] hover:text-[--color-danger] px-2 py-1 rounded hover:bg-[--color-danger]/10 transition-colors">Remove</button>
                    </div>
                    <div className="flex flex-wrap gap-2 mb-2">
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400">{LANG[r.language] || r.language}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/15 text-purple-400">{TYPE[r.type] || r.type}</span>
                      <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/15 text-gray-400">{r.file_count} code files</span>
                      {r.has_db_code && <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-yellow-500/15 text-yellow-400">🗄 Has DB code</span>}
                    </div>
                    {r.src_dirs.length > 0 && <div className="text-xs text-[--color-text-muted]"><span className="font-medium text-[--color-text]">Logic dirs: </span>{r.src_dirs.join(', ')}</div>}
                    {r.db_dirs.length > 0 && <div className="text-xs text-yellow-400 mt-1"><span className="font-medium">DB code: </span>{r.db_dirs.join(', ')}</div>}
                    {r.warnings.map((w, i) => <div key={i} className="text-xs text-[--color-warning] mt-1">⚠ {w}</div>)}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="border border-dashed border-[--color-border] rounded-xl p-5 bg-[--color-surface]/50">
            <div className="text-sm font-medium mb-3">{repos.length === 0 ? 'Add a repository' : 'Add more repositories'}</div>
            <div className="flex gap-2">
              <input type="text" value={repoPath} onChange={e => { setRepoPath(e.target.value); setScanError('') }}
                onKeyDown={e => e.key === 'Enter' && doScan()} placeholder="Enter path or click Browse..."
                className="flex-1 px-3 py-2 rounded-lg bg-[--color-bg] border border-[--color-border] text-[--color-text] placeholder:text-[--color-text-muted] focus:outline-none focus:border-[--color-accent] font-mono text-sm" />
              <button onClick={() => { setShowBrowser(true); browseTo() }}
                className="px-3 py-2 rounded-lg bg-[--color-surface-2] border border-[--color-border] hover:border-[--color-accent] text-sm font-medium transition-colors whitespace-nowrap">📂 Browse</button>
              <button onClick={() => doScan()} disabled={scanning || !repoPath.trim()}
                className="px-4 py-2 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] disabled:opacity-40 text-white text-sm font-medium transition-colors whitespace-nowrap">
                {scanning ? 'Scanning...' : 'Add'}</button>
            </div>
            {scanError && <p className="text-sm text-[--color-danger] mt-2">{scanError}</p>}
          </div>

          <div className="flex justify-between">
            <button onClick={() => setStep('info')} className="px-4 py-2 rounded-lg border border-[--color-border] text-sm font-medium hover:bg-[--color-surface-2] transition-colors">Back</button>
            <button onClick={() => setStep('confirm')} disabled={repos.length === 0}
              className="px-5 py-2 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] disabled:opacity-40 disabled:cursor-not-allowed text-white font-medium text-sm transition-colors">
              Next ({repos.length} repos)</button>
          </div>
        </div>
      )}

      {/* Step 3 */}
      {step === 'confirm' && (
        <div className="space-y-5">
          <div className="border border-[--color-border] rounded-xl p-5 bg-[--color-surface]">
            <h3 className="font-semibold mb-4">Summary</h3>
            <div className="space-y-3 text-sm">
              <div className="flex justify-between"><span className="text-[--color-text-muted]">Project name</span><span className="font-medium">{name}</span></div>
              {description && <div className="flex justify-between"><span className="text-[--color-text-muted]">Description</span><span>{description}</span></div>}
              <div className="flex justify-between"><span className="text-[--color-text-muted]">Repositories</span><span className="font-medium">{repos.length}</span></div>
              <div className="flex justify-between"><span className="text-[--color-text-muted]">Code files</span><span className="font-medium">{repos.reduce((s, r) => s + r.file_count, 0)}</span></div>
              {repos.some(r => r.has_db_code) && <div className="flex justify-between"><span className="text-[--color-text-muted]">DB code</span><span className="text-yellow-400">Detected, will be processed separately</span></div>}
            </div>
            <div className="mt-4 pt-4 border-t border-[--color-border] space-y-2">
              {repos.map(r => (
                <div key={r.path} className="flex items-center gap-2 text-sm">
                  <span className="px-1.5 py-0.5 rounded text-xs font-medium bg-blue-500/15 text-blue-400">{LANG[r.language]}</span>
                  <span className="font-medium">{r.name}</span>
                  <span className="text-[--color-text-muted]">— {r.file_count} files</span>
                </div>
              ))}
            </div>
          </div>
          <div className="flex justify-between">
            <button onClick={() => setStep('repos')} className="px-4 py-2 rounded-lg border border-[--color-border] text-sm font-medium hover:bg-[--color-surface-2] transition-colors">Back</button>
            <button onClick={createProject} disabled={creating}
              className="px-5 py-2 rounded-lg bg-[--color-success] hover:brightness-110 disabled:opacity-40 text-white font-medium text-sm transition-all">
              {creating ? 'Creating...' : 'Create Project'}</button>
          </div>
        </div>
      )}

      {/* File Browser Modal */}
      {showBrowser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowBrowser(false)}>
          <div className="w-[560px] max-h-[70vh] border border-[--color-border] rounded-2xl bg-[--color-surface] shadow-2xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-[--color-border] flex items-center justify-between">
              <div className="font-semibold">Select Repository Directory</div>
              <button onClick={() => setShowBrowser(false)} className="text-[--color-text-muted] hover:text-[--color-text] text-lg leading-none">×</button>
            </div>
            {browseData && (
              <div className="px-5 py-2 border-b border-[--color-border] bg-[--color-bg]">
                <div className="font-mono text-xs text-[--color-text-muted] truncate">{browseData.current}</div>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-2 py-2">
              {browseLoading ? <div className="text-center py-8 text-[--color-text-muted] text-sm">Loading...</div> : browseData ? (
                <>
                  {browseData.parent && (
                    <button onClick={() => browseTo(browseData.parent!)} className="w-full text-left px-3 py-2 rounded-lg hover:bg-[--color-surface-2] flex items-center gap-2 text-sm transition-colors">
                      <span className="text-[--color-text-muted]">📁</span><span className="text-[--color-text-muted]">..</span>
                    </button>
                  )}
                  {browseData.dirs.length === 0 ? <div className="text-center py-6 text-[--color-text-muted] text-sm">No subdirectories</div> : browseData.dirs.map(d => (
                    <div key={d.path} className="flex items-center group">
                      <button onClick={() => browseTo(d.path)} className="flex-1 text-left px-3 py-2 rounded-lg hover:bg-[--color-surface-2] flex items-center gap-2 text-sm transition-colors">
                        <span>{d.isRepo ? '📦' : '📁'}</span>
                        <span className={d.isRepo ? 'font-medium text-[--color-accent]' : ''}>{d.name}</span>
                        {d.isRepo && <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[--color-accent]/15 text-[--color-accent]">repo</span>}
                      </button>
                      <button onClick={() => selectAndScan(d.path)} className="opacity-0 group-hover:opacity-100 px-2 py-1 rounded text-xs font-medium text-[--color-accent] hover:bg-[--color-accent]/10 transition-all mr-1">Select</button>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
            {browseData && (
              <div className="px-5 py-3 border-t border-[--color-border] flex items-center justify-between">
                <div className="text-xs text-[--color-text-muted]">Or select current directory</div>
                <button onClick={() => selectAndScan(browseData.current)} className="px-4 py-1.5 rounded-lg bg-[--color-accent] hover:bg-[--color-accent-hover] text-white text-sm font-medium transition-colors">Select This Directory</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
