'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { ResumeSheet, type SheetProject } from '@/components/resume/ResumeSheet'
import { TailoringReview, type TailoringState } from '@/components/resume/TailoringReview'
import { createResumeSaveQueue, type ResumeEdit } from '@/components/resume/resume-save-queue'
import { copy, tailoringCopy as c } from '@/content/zh-CN'
import type { ApplyProposalInput, ResumeProfile, TailoringProposal } from '@/domain/tailoring'
import { api, ApiError, notifyChanged, statusLabel } from '@/lib/api'
import { useUnsavedNavigation } from '@/lib/workspace-navigation'

interface Version {
  id: string
  type: 'master' | 'targeted'
  title: string
}

interface ResumeProject extends SheetProject {
  status: 'planned' | 'active' | 'done'
  included: boolean
}

interface ResumeDetail {
  id: string
  type: Version['type']
  jobId: string | null
  revision: number | null
  pageTarget: 1 | 2
  summary: string
  job: { company: string; role: string } | null
  profile: ResumeProfile | null
  projects: ResumeProject[]
  availableProjects: { projectId: string; title: string; status: string }[]
}

interface RevisionSummary {
  id: string
  revision: number
  kind: 'working' | 'submitted'
  createdAt: string
}

type ProfilePatch = Partial<ResumeProfile> & { summary?: string }
type ResumePatch = { summary?: string; profile?: ResumeProfile; pageTarget?: 1 | 2; includedProjectIds?: string[]; overrides?: { projectId: string; bulletOverride: string }[] }
type Decision = ApplyProposalInput['decisions'][number]

const A4_HEIGHT = 297 * 96 / 25.4
const A4_WIDTH = 210 * 96 / 25.4
const errorMessage = (error: unknown) => error instanceof Error ? error.message : c.requestFailed
const isConflict = (error: unknown) => error instanceof ApiError && error.status === 409

export function ResumeWorkspace() {
  const requested = useSearchParams().get('id')
  const [versions, setVersions] = useState<Version[]>([])
  const [selected, setSelected] = useState<string | null>(requested)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void api<Version[]>('/api/resumes', { signal: controller.signal }).then(rows => {
      if (controller.signal.aborted) return
      setVersions(rows)
      setSelected(requested ?? rows.find(row => row.type === 'master')?.id ?? rows[0]?.id ?? null)
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    return () => controller.abort()
  }, [requested, reload])

  if (error) return <main className="flex-1 p-6"><LoadError message={error} onRetry={() => setReload(n => n + 1)} /></main>
  if (!selected) return <main className="flex-1 p-6 text-[13px]" role="status">{c.loadResume}</main>
  return <ResumeLoader key={selected} id={selected} versions={versions} onSelect={setSelected} />
}

function ResumeLoader({ id, versions, onSelect }: { id: string; versions: Version[]; onSelect: (id: string) => void }) {
  const [resume, setResume] = useState<ResumeDetail | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void api<ResumeDetail>(`/api/resumes/${id}`, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setResume(result)
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)) })
    return () => controller.abort()
  }, [id, reload])

  if (error) return <main className="flex-1 p-6"><LoadError message={error} onRetry={() => setReload(n => n + 1)} />
    {versions.map(version => <button key={version.id} className="cd-button mr-2 mt-3" onClick={() => onSelect(version.id)}>{version.title}</button>)}
  </main>
  if (!resume) return <main className="flex-1 p-6 text-[13px]" role="status">{c.loadResume}</main>
  return <ResumeEditor initial={resume} versions={versions} onSelect={onSelect} />
}

function ResumeEditor({ initial, versions, onSelect }: { initial: ResumeDetail; versions: Version[]; onSelect: (id: string) => void }) {
  const route = `/api/resumes/${initial.id}`
  const [, redraw] = useState(0)
  const [queue] = useState(() => createResumeSaveQueue(initial, () => redraw(n => n + 1)))
  const { base, draft: resume, pending, error: saveError } = queue.snapshot()
  const [profileOpen, setProfileOpen] = useState(false)
  const [profileDirty, setProfileDirty] = useState(false)
  const [editing, setEditing] = useState(false)
  const [photoPending, setPhotoPending] = useState(false)
  const [commandPending, setCommandPending] = useState(false)
  const [commandError, setCommandError] = useState('')
  const [outOfDate, setOutOfDate] = useState(false)
  const [status, setStatus] = useState('')
  const [tailoring, setTailoring] = useState<TailoringState | null>(null)
  const [reviewError, setReviewError] = useState('')
  const [history, setHistory] = useState<RevisionSummary[] | null>(null)
  const [historyError, setHistoryError] = useState('')
  const [sideRefresh, setSideRefresh] = useState(0)
  const exclusive = useRef(false)
  const targeted = resume.type === 'targeted'
  const included = resume.projects.filter(project => project.included)
  const hasLocalWork = Boolean(pending || editing || profileDirty || photoPending)
  const blocked = hasLocalWork || commandPending || outOfDate

  useEffect(() => {
    if (!targeted) return
    const controller = new AbortController()
    const signal = controller.signal
    if (resume.jobId) {
      setReviewError('')
      void api<TailoringState>(`/api/jobs/${resume.jobId}/tailoring`, { signal }).then(result => {
        if (!signal.aborted) setTailoring(result)
      }).catch(error => { if (!signal.aborted) setReviewError(errorMessage(error)) })
    }
    setHistoryError('')
    void api<RevisionSummary[]>(`${route}/revisions`, { signal }).then(rows => {
      if (!signal.aborted) setHistory(rows.filter(row => row.kind === 'submitted'))
    }).catch(error => { if (!signal.aborted) setHistoryError(errorMessage(error)) })
    return () => controller.abort()
  }, [targeted, resume.jobId, base.revision, route, sideRefresh])

  const navigationBlocked = hasLocalWork || commandPending
  useUnsavedNavigation(() => Boolean(queue.snapshot().pending || editing || profileDirty || photoPending))

  function patch(patchFor: (draft: ResumeDetail) => ResumePatch, preview: ResumeEdit<ResumeDetail>['preview']) {
    setStatus('')
    queue.enqueue({
      preview,
      async save(current) {
        const expectedRevision = current.revision
        const changes = patchFor(current)
        const response = await api<ResumeDetail>(route, {
          method: 'PATCH',
          body: JSON.stringify(expectedRevision === null ? changes : { ...changes, expectedRevision }),
        })
        notifyChanged()
        return response
      },
    })
  }

  function toggleProject(projectId: string, checked: boolean) {
    patch(current => {
      const ids = current.projects.filter(project => project.included && project.projectId !== projectId).map(project => project.projectId)
      if (checked) ids.push(projectId)
      return { includedProjectIds: ids }
    }, current => ({
      ...current,
      projects: current.projects.map(project => project.projectId === projectId ? { ...project, included: checked } : project),
    }))
  }

  function editBullet(projectId: string, bulletOverride: string) {
    const project = queue.snapshot().draft.projects.find(project => project.projectId === projectId)
    if (!project || bulletOverride === project.bullet) return
    patch(() => ({ overrides: [{ projectId, bulletOverride }] }), current => ({
      ...current,
      projects: current.projects.map(project => project.projectId === projectId ? { ...project, bullet: bulletOverride } : project),
    }))
  }

  function editProfile({ summary, ...person }: ProfilePatch) {
    if (targeted) {
      patch(current => ({ summary, ...(current.profile ? { profile: { ...current.profile, ...person } } : {}) }), current => ({
        ...current, summary: summary ?? current.summary, profile: current.profile && { ...current.profile, ...person },
      }))
    } else {
      setStatus('')
      queue.enqueue({
        preview: current => ({ ...current, summary: summary ?? current.summary, profile: current.profile && { ...current.profile, ...person } }),
        async save() {
          await api('/api/profile', { method: 'PATCH', body: JSON.stringify({ ...person, summary }) })
          const next = await api<ResumeDetail>(route)
          notifyChanged()
          return next
        },
      })
    }
  }

  async function runCommand(action: () => Promise<void>, requireReloadOnConflict = true) {
    if (exclusive.current) return
    exclusive.current = true
    setCommandPending(true)
    setCommandError('')
    setStatus('')
    try {
      await action()
    } catch (error) {
      if (requireReloadOnConflict && isConflict(error)) setOutOfDate(true)
      setCommandError(errorMessage(error))
    } finally {
      exclusive.current = false
      setCommandPending(false)
    }
  }

  function retrySave() {
    if (isConflict(saveError)) {
      void runCommand(async () => {
        const latest = await api<ResumeDetail>(route)
        setOutOfDate(false)
        queue.retry(latest)
      }, false)
    } else {
      queue.retry()
    }
  }

  function decide(proposalId: string, decision: Decision) {
    const current = queue.snapshot()
    if (blocked || current.pending || current.base.revision === null) return
    const input: ApplyProposalInput = { expectedRevision: current.base.revision, decisions: [decision] }
    void runCommand(async () => {
      const result = await api<{ resume: ResumeDetail; proposal: TailoringProposal }>(`${route}/proposals/${proposalId}/apply`, { method: 'POST', body: JSON.stringify(input) })
      queue.replace(result.resume)
      setTailoring(state => state && { ...state, proposal: result.proposal })
      notifyChanged()
    })
  }

  function submit() {
    const current = queue.snapshot()
    if (blocked || current.pending || current.base.revision === null) return
    const expectedRevision = current.base.revision
    void runCommand(async () => {
      const snapshot = await api<RevisionSummary>(`${route}/submit`, { method: 'POST', body: JSON.stringify({ expectedRevision }) })
      setHistory(rows => [snapshot, ...(rows ?? [])])
      setSideRefresh(n => n + 1)
      setStatus(c.submitted)
    })
  }

  return (
    <main className="resume-workspace flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex flex-wrap items-center gap-3 px-5 py-3">
        <div>
          <h1 className="text-[19px] font-semibold">{copy.resumeTitle}</h1>
          <p className="text-[11.5px] text-[#627086]">{copy.resumeLead}</p>
        </div>
        <button className="cd-button ml-auto" disabled={commandPending || profileDirty || !resume.profile} aria-expanded={profileOpen} onClick={() => setProfileOpen(value => !value)}>{targeted ? c.targetProfile : copy.profile}</button>
      </header>
      {profileOpen && resume.profile && <ProfileForm
        initial={resume.profile}
        summary={resume.summary}
        targeted={targeted}
        disabled={commandPending}
        onDirty={setProfileDirty}
        onCancel={() => { setProfileDirty(false); setProfileOpen(false) }}
        onSave={changes => { editProfile(changes); setProfileDirty(false); setProfileOpen(false) }}
      />}
      {(status || commandError || saveError || commandPending || pending || editing || profileDirty) && <div className="mx-5 mb-2 flex flex-wrap items-center gap-2 text-[12px]" aria-live="polite">
        {saveError ? <>
          <p className="cd-error">{isConflict(saveError) ? c.conflict : `${c.saveFailed} ${saveError.message}`}</p>
          <button className="cd-button" disabled={commandPending || editing || photoPending} onClick={retrySave}>{isConflict(saveError) ? c.reloadAndRetry : c.retry}</button>
        </> : <p className="cd-muted">{pending || commandPending ? c.saving : editing ? c.editing : profileDirty ? c.unsavedProfile : status}</p>}
        {commandError && <p role="alert" className="cd-error">{commandError}</p>}
        {outOfDate && <button className="cd-button" disabled={commandPending || hasLocalWork} onClick={() => void runCommand(async () => {
          queue.replace(await api<ResumeDetail>(route))
          setSideRefresh(n => n + 1)
          setOutOfDate(false)
        })}>{c.reload}</button>}
      </div>}
      <div className="resume-columns min-h-0 flex-1 gap-3 px-5 pb-4">
        <aside className="min-w-0 overflow-y-auto rounded-xl border border-[#e6eaf1] bg-white">
          <h2 className="border-b px-3 py-3 text-[12px] font-semibold">{copy.versions}</h2>
          <div className="space-y-1 p-2">
            {versions.map(version => <button key={version.id} aria-current={version.id === resume.id} disabled={navigationBlocked} className={`w-full break-words rounded-lg px-2.5 py-2 text-left text-[12px] disabled:opacity-50 ${version.id === resume.id ? 'border border-[#2f6bff] bg-[#eef3ff]' : 'hover:bg-[#f7f9fc]'}`} onClick={() => onSelect(version.id)}>
              {version.type === 'master' ? copy.master : version.title}
            </button>)}
          </div>
        </aside>
        <aside className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-[#e6eaf1] bg-white">
          <div className="border-b px-4 py-3">
            <h2 className="text-[13px] font-semibold">{targeted ? copy.targeted : copy.master}</h2>
            <p className="cd-muted mt-1">{copy.selectedCount(included.length)}{base.revision !== null && ` · ${c.currentRevision(base.revision)}`}</p>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 py-3">
            {targeted && <TailoringReview state={tailoring} resumeId={resume.id} revision={base.revision} disabled={blocked} error={reviewError} onRetry={() => setSideRefresh(n => n + 1)} onDecision={decide} />}
            <section className="space-y-2">
              <h3 className="text-[13px] font-semibold">{copy.navProjects}</h3>
              {resume.projects.map(project => <label key={project.projectId} className="flex items-baseline gap-2 rounded-lg border border-[#e8ecf3] p-2 text-[12px]">
                <input type="checkbox" checked={project.included} disabled={commandPending || outOfDate} onChange={event => toggleProject(project.projectId, event.target.checked)} />
                <span className="min-w-0 break-words">{project.title} <span className="cd-muted">{statusLabel(project.status)}</span></span>
              </label>)}
              {targeted && resume.availableProjects.length > 0 && <details className="cd-details">
                <summary className="text-[12px] font-medium">{c.addFromLibrary}</summary>
                <div className="mt-2 space-y-1">
                  {resume.availableProjects.map(project => <label key={project.projectId} className="flex items-baseline gap-2 text-[12px]">
                    <input type="checkbox" checked={false} disabled={Boolean(pending || commandPending || outOfDate)}
                      onChange={event => toggleProject(project.projectId, event.target.checked)} />
                    <span className="min-w-0 break-words">{project.title} <span className="cd-muted">{statusLabel(project.status)}</span></span>
                  </label>)}
                </div>
              </details>}
            </section>
            {targeted && <section className="space-y-2 border-t pt-3">
              <h3 className="text-[13px] font-semibold">{c.history}</h3>
              {historyError && <LoadError message={historyError} onRetry={() => setSideRefresh(n => n + 1)} />}
              {!historyError && <p className="cd-muted">{!history ? c.loading : history.length === 0 && c.noHistory}</p>}
              {history?.map(row => <div key={row.id} className="space-y-1.5 rounded-lg border p-2">
                <p className="text-[12px] font-medium">{c.revision(row.revision)}</p>
                <p className="cd-muted"><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></p>
                <ExportLinks id={resume.id} revision={row.revision} disabled={blocked} />
              </div>)}
            </section>}
          </div>
        </aside>
        <section className="flex min-h-[400px] min-w-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 px-1 pb-2 text-[12px] text-[#546074]">
            <h2 className="mr-auto">{copy.preview} <span className="cd-muted">A4</span></h2>
            {targeted && <label className="flex items-center gap-2">{c.pageTarget}
              <select className="cd-input py-1" value={resume.pageTarget} disabled={commandPending || outOfDate} onChange={event => {
                const pageTarget = event.target.value === '2' ? 2 : 1
                patch(() => ({ pageTarget }), current => ({ ...current, pageTarget }))
              }}>
                <option value={1}>{c.pages(1)}</option><option value={2}>{c.pages(2)}</option>
              </select>
            </label>}
          </div>
          <ScaledResume pageTarget={resume.pageTarget}>
            {resume.profile && <ResumeSheet
              profile={resume.profile}
              job={resume.job}
              projects={included}
              summary={resume.summary}
              editable={targeted && !commandPending && !outOfDate}
              onBullet={editBullet}
              onEditing={setEditing}
              onPhoto={!commandPending && !outOfDate && !photoPending ? photo => editProfile({ photo }) : undefined}
              onPhotoPending={setPhotoPending}
              onPhotoError={() => setCommandError(c.photoError)}
            />}
          </ScaledResume>
          <p className="cd-muted px-1 pt-1 text-center">{targeted ? copy.editTip : copy.masterReadonly}</p>
          <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
            <ExportLinks id={resume.id} revision={base.revision} disabled={blocked} />
            {targeted && <button className="cd-button cd-primary" disabled={blocked || base.revision === null} onClick={submit}>{c.submit}</button>}
          </div>
          {targeted && <p className="cd-muted mt-1 text-right">{c.submitHint}</p>}
        </section>
      </div>
    </main>
  )
}

function LoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <div role="alert" className="space-y-1"><p className="cd-error">{message}</p><button className="cd-button" onClick={onRetry}>{c.retry}</button></div>
}

function ExportLinks({ id, revision, disabled }: { id: string; revision: number | null; disabled: boolean }) {
  const query = revision === null ? '' : `revision=${revision}`
  return disabled ? <>
    <button className="cd-button" disabled>{copy.exportMd}</button>
    <button className="cd-button" disabled>{copy.exportPdf}</button>
  </> : <>
    <a className="cd-button" href={`/api/resumes/${id}/markdown${query ? `?${query}` : ''}`}>{copy.exportMd}</a>
    <a className="cd-button" href={`/resume/${id}/print?autoprint=1${query ? `&${query}` : ''}`} target="_blank" rel="noopener">{copy.exportPdf}</a>
  </>
}

function ScaledResume({ children, pageTarget }: { children: ReactNode; pageTarget: 1 | 2 }) {
  const frame = useRef<HTMLDivElement>(null)
  const paper = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ scale: 0.52, contentHeight: A4_HEIGHT })
  useEffect(() => {
    const node = frame.current
    const wrapper = paper.current
    const sheet = wrapper?.querySelector('.career-sheet')
    if (!node || !wrapper || !sheet) return
    function update() {
      if (!node || !sheet) return
      const style = getComputedStyle(node)
      const available = node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const scale = Math.min(1, Math.max(0.1, available / A4_WIDTH))
      const contentHeight = sheet.getBoundingClientRect().height / (wrapper!.getBoundingClientRect().width / A4_WIDTH)
      setBox(old => old.scale === scale && old.contentHeight === contentHeight ? old : { scale, contentHeight })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(node)
    observer.observe(sheet)
    return () => observer.disconnect()
  }, [])

  return <>
    {box.contentHeight > A4_HEIGHT * pageTarget + 1 && <p className="cd-warning mb-2 text-[12px]" role="status">{c.overflow(pageTarget)}</p>}
    <div ref={frame} className="min-h-0 flex-1 overflow-auto rounded-xl border border-[#e3e8f0] bg-[#eef0f3] p-3">
      <div style={{ width: A4_WIDTH * box.scale, height: box.contentHeight * box.scale }}>
        <div ref={paper} style={{ width: A4_WIDTH, transform: `scale(${box.scale})`, transformOrigin: 'top left' }}>{children}</div>
      </div>
    </div>
  </>
}

const profileFields = ['name', 'headline', 'years', 'location', 'phone', 'email', 'links'] as const
const longFields = ['summary', 'workExperience', 'education', 'skills'] as const
const longHints = { summary: '', workExperience: copy.workExperienceHint, education: copy.educationHint, skills: copy.skillsHint }

function ProfileForm({ initial, summary, targeted, disabled, onSave, onDirty, onCancel }: {
  initial: ResumeProfile
  summary: string
  targeted: boolean
  disabled: boolean
  onSave: (patch: ProfilePatch) => void
  onDirty: (dirty: boolean) => void
  onCancel: () => void
}) {
  const [original] = useState(() => ({ ...initial, summary, skills: initial.skills.join('\n') }))
  const [form, setForm] = useState(original)
  const changed = [...profileFields, ...longFields].some(key => form[key] !== original[key])

  function update(key: keyof typeof form, value: string) {
    const next = { ...form, [key]: value }
    setForm(next)
    onDirty([...profileFields, ...longFields].some(key => next[key] !== original[key]))
  }

  return <form className="mx-5 mb-2 max-h-[40vh] shrink-0 overflow-y-auto rounded-xl border bg-white p-3 text-[12px]" onSubmit={event => {
    event.preventDefault()
    const patch: ProfilePatch = {}
    for (const key of [...profileFields, 'summary', 'workExperience', 'education'] as const) {
      if (original[key] !== form[key]) patch[key] = form[key]
    }
    if (original.skills !== form.skills) patch.skills = form.skills.split('\n').map(item => item.trim()).filter(Boolean)
    onSave(patch)
  }}>
    {targeted && <p className="cd-muted mb-2">{c.profileHint}</p>}
    <fieldset disabled={disabled} className="grid grid-cols-2 gap-2 xl:grid-cols-4">
      {profileFields.map(key => <label key={key}>{copy[key]}<input className="cd-input mt-1" value={form[key]} onChange={event => update(key, event.target.value)} /></label>)}
      {longFields.map(key => <label key={key} className="xl:col-span-2">{copy[key]}
        <textarea className="cd-input mt-1 min-h-14" placeholder={longHints[key]} value={form[key]} onChange={event => update(key, event.target.value)} />
      </label>)}
    </fieldset>
    <div className="mt-2 flex justify-end gap-2">
      <button className="cd-button" type="button" onClick={onCancel}>{copy.cancel}</button>
      <button className="cd-button cd-primary" disabled={!changed || disabled}>{c.profileSave}</button>
    </div>
  </form>
}
