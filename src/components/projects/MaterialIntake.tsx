'use client'

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { createIntakeScope } from '@/components/projects/material-intake-scope'
import { materialsCopy as c, tailoringCopy as t } from '@/content/zh-CN'
import { MAX_MATERIAL_LENGTH } from '@/domain/source-limits'
import { api } from '@/lib/api'
import { useUnsavedNavigation } from '@/lib/workspace-navigation'

type Stage = 'planned' | 'active' | 'done' | 'unknown'
type Fact = { id: string; text: string; sourceText: string; status: 'candidate' | 'confirmed' | 'rejected'; stage: Stage; revision: number }
type Material = { id: string; title: string | null; content: string; projectId: string | null; facts: Fact[] }
type Project = { id: string; title: string; factsMarkdown: string }
type Draft = { text: string; stage: Stage }
export type MaterialDraft = { selected: string; title: string; stage: Exclude<Stage, 'unknown'>; content: string }
type Props = {
  projectId?: string
  requireProject?: boolean
  blocked?: boolean
  initialDraft?: MaterialDraft
  onDraftChange?: (draft: MaterialDraft) => void
  onChanged?: () => void
  onPendingChange?: (pending: boolean) => void
}

export function MaterialIntake(props: Props) {
  return createElement(MaterialIntakeContext, { ...props, key: JSON.stringify(props.projectId ?? null) })
}

function MaterialIntakeContext({ projectId, requireProject, blocked, initialDraft, onDraftChange, onChanged, onPendingChange }: Props) {
  const scope = useRef(createIntakeScope()).current
  const [projects, setProjects] = useState<Project[]>([])
  const [intake, setIntake] = useState<MaterialDraft>(() => initialDraft ?? {
    selected: projectId ?? (requireProject ? '__new' : ''), title: '', stage: 'active', content: '',
  })
  const { selected, title, stage: projectStage, content } = intake
  const [materials, setMaterials] = useState<Material[]>([])
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [extracting, setExtracting] = useState(false)
  const lock = useRef(false)
  const reading = useRef<AbortController | null>(null)
  const extractingRequest = useRef<AbortController | null>(null)
  const busy = blocked || pending
  const sourceTooLong = content.length > MAX_MATERIAL_LENGTH
  useUnsavedNavigation(() => !requireProject && Boolean(content))

  function changeIntake(patch: Partial<MaterialDraft>) {
    const next = { ...intake, ...patch }
    setIntake(next)
    onDraftChange?.(next)
  }

  const refresh = useCallback(async () => {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    const signal = controller.signal
    const token = scope.beginRefresh()
    try {
      const [rows, projectRows] = await Promise.all([
        api<Material[]>(projectId ? `/api/materials?projectId=${encodeURIComponent(projectId)}` : '/api/materials', { signal }),
        api<Project[]>('/api/projects', { signal }),
      ])
      if (signal.aborted || !scope.current(token)) return
      setMaterials(rows)
      setProjects(projectRows)
    } catch (error) {
      if (!signal.aborted) throw error
    } finally {
      if (reading.current === controller) reading.current = null
    }
  }, [projectId, scope])

  useEffect(() => {
    scope.activate()
    void refresh().catch(() => { if (scope.active()) setError(c.loadError) })
    return () => {
      scope.dispose()
      reading.current?.abort()
      extractingRequest.current?.abort()
    }
  }, [refresh, scope])

  async function run(action: () => Promise<void>) {
    if (lock.current || blocked) return
    lock.current = true
    setPending(true)
    onPendingChange?.(true)
    setMessage('')
    setError('')
    try {
      await action()
      if (!scope.active()) return
      try {
        await refresh()
      } finally {
        if (scope.active()) onChanged?.()
      }
    } catch (error) {
      if (scope.active()) setError(error instanceof Error ? error.message : c.requestError)
    } finally {
      lock.current = false
      if (scope.active()) {
        setPending(false)
        onPendingChange?.(false)
      }
    }
  }

  function save(text: string, imported = false) {
    if (text.length > MAX_MATERIAL_LENGTH) {
      setError(t.materialLimit)
      return
    }
    return run(async () => {
      const link = selected === '__new' ? { createProject: true, title, stage: projectStage } : selected ? { projectId: selected } : {}
      const created = await api<Material>('/api/materials', { method: 'POST', body: JSON.stringify({ content: text, ...link }) })
      if (!scope.active()) return
      changeIntake({
        ...(selected === '__new' && created.projectId ? { selected: created.projectId } : {}),
        ...(!imported ? { content: '' } : {}),
      })
      setMessage(c.saved)
    })
  }

  function extract(material: Material) {
    return run(async () => {
      const controller = new AbortController()
      extractingRequest.current = controller
      setExtracting(true)
      try {
        await api(`/api/materials/${material.id}/extract`, { method: 'POST', signal: controller.signal })
      } catch (error) {
        if (!controller.signal.aborted) throw error
        if (scope.active()) setMessage(t.cancelled)
      } finally {
        if (extractingRequest.current === controller) extractingRequest.current = null
        if (scope.active()) setExtracting(false)
      }
    })
  }

  function change(fact: Fact, patch: Partial<Draft>) {
    setDrafts(old => ({ ...old, [fact.id]: { ...(old[fact.id] ?? { text: fact.text, stage: fact.stage }), ...patch } }))
  }

  function update(material: Material, fact: Fact, status: Fact['status']) {
    return run(async () => {
      const draft = drafts[fact.id] ?? { text: fact.text, stage: fact.stage }
      await api(`/api/materials/${material.id}/facts`, {
        method: 'PATCH',
        body: JSON.stringify({ expectedRevision: fact.revision, facts: [{ id: fact.id, status, ...draft }] }),
      })
      if (!scope.active()) return
      setDrafts(old => {
        const next = { ...old }
        delete next[fact.id]
        return next
      })
    })
  }

  const selectedProject = projects.find(project => project.id === selected)
  const importTooLong = (selectedProject?.factsMarkdown.length ?? 0) > MAX_MATERIAL_LENGTH
  const visibleMaterials = materials.filter(material => material.projectId === (selected || null))

  return (
    <section aria-label={c.title} className="space-y-3 text-[12px]">
      {requireProject && <p className="cd-muted">{t.materialHelp}</p>}
      {!projectId && <label className="block">{c.project}
        <select className="cd-input mt-1" value={selected} onChange={event => changeIntake({ selected: event.target.value })} disabled={busy}>
          {!requireProject && <option value="">{c.noProject}</option>}
          <option value="__new">{c.createProject}</option>
          {projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}
        </select>
      </label>}
      {selected === '__new' && <div className="grid grid-cols-2 gap-2">
        <label>{c.projectTitle}<input className="cd-input mt-1" value={title} onChange={event => changeIntake({ title: event.target.value })} disabled={busy} /></label>
        <label>{c.projectStage}
          <select className="cd-input mt-1" value={projectStage} onChange={event => changeIntake({ stage: event.target.value as typeof projectStage })} disabled={busy}>
            <option value="active">{c.active}</option><option value="done">{c.done}</option><option value="planned">{c.planned}</option>
          </select>
        </label>
      </div>}
      <label className="block">{c.content}
        <textarea className="cd-input mt-1 min-h-28" value={content} aria-invalid={sourceTooLong} disabled={busy}
          onChange={event => changeIntake({ content: event.target.value })} />
      </label>
      <p className={sourceTooLong ? 'cd-error' : 'cd-muted'} role={sourceTooLong ? 'alert' : undefined}>
        {sourceTooLong && `${t.materialLimit} `}{t.sourceLength(content.length, MAX_MATERIAL_LENGTH)}
      </p>
      <p className="cd-muted">{c.sourceHint}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="cd-button cd-primary" disabled={busy || sourceTooLong || !content.trim() || (selected === '__new' && !title.trim())} onClick={() => void save(content)}>{c.save}</button>
        {selectedProject && <button type="button" className="cd-button" disabled={busy || importTooLong || !selectedProject.factsMarkdown.trim()} onClick={() => void save(selectedProject.factsMarkdown, true)}>{c.importFacts}</button>}
        <button type="button" className="cd-button" disabled={busy} onClick={() => void run(async () => {})}>{c.refresh}</button>
      </div>
      {importTooLong && <p role="alert" className="cd-error">{t.materialLimit}</p>}
      {pending && <div className="flex items-center gap-2"><p role="status">{c.pending}</p>
        {extracting && <button type="button" className="cd-button" onClick={() => extractingRequest.current?.abort()}>{t.cancelTask}</button>}
      </div>}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert" className="cd-error">{error}</p>}
      {!visibleMaterials.length && <p className="cd-muted">{c.empty}</p>}
      {visibleMaterials.map((material, index) => <article key={material.id} className="cd-card space-y-2">
        <details>
          <summary className="font-medium">{material.title || t.sourceMaterial(visibleMaterials.length - index)} · {c.source}</summary>
          <blockquote className="cd-quote">{material.content}</blockquote>
        </details>
        {material.facts.length === 0 && <button type="button" className="cd-button" disabled={busy} onClick={() => void extract(material)}>{c.extract}</button>}
        {material.facts.map(fact => {
          const draft = drafts[fact.id] ?? { text: fact.text, stage: fact.stage }
          return <div key={fact.id} className="space-y-2 border-t border-[#e9edf4] pt-2">
            <p className="cd-muted">{c[fact.status]}</p>
            <details>
              <summary>{c.source}</summary>
              <blockquote className="cd-quote">{fact.sourceText}</blockquote>
            </details>
            <label className="block">{c.wording}
              <textarea className="cd-input mt-1" value={draft.text} disabled={busy} onChange={event => change(fact, { text: event.target.value })} />
            </label>
            <div className="flex flex-wrap items-end gap-2">
              <label>{c.stage}
                <select className="cd-input mt-1" value={draft.stage} disabled={busy} onChange={event => change(fact, { stage: event.target.value as Stage })}>
                  <option value="unknown">{c.unknown}</option><option value="planned">{c.planned}</option>
                  <option value="active">{c.active}</option><option value="done">{c.done}</option>
                </select>
              </label>
              <button type="button" className="cd-button cd-primary" disabled={busy || !draft.text.trim() || (fact.status === 'confirmed' && !drafts[fact.id])} onClick={() => void update(material, fact, 'confirmed')}>{c.confirm}</button>
              <button type="button" className="cd-button" disabled={busy || !draft.text.trim() || fact.status === 'rejected'} onClick={() => void update(material, fact, 'rejected')}>{c.reject}</button>
            </div>
            {draft.stage === 'unknown' && <p className="cd-muted">{c.unknownHint}</p>}
          </div>
        })}
      </article>)}
    </section>
  )
}
