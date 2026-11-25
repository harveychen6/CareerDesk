'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MaterialIntake, type MaterialDraft } from '@/components/projects/MaterialIntake'
import { copy, materialsCopy, tailoringCopy as c } from '@/content/zh-CN'
import { MAX_JD_LENGTH } from '@/domain/source-limits'
import type { AnalyzeJobInput, GenerateDraftInput, JobRequirementAnalysis, TailoringProposal } from '@/domain/tailoring'
import { api, notifyChanged } from '@/lib/api'
import { useUnsavedNavigation } from '@/lib/workspace-navigation'

interface JobSummary {
  id: string
  company: string
  role: string
  city: string
  salary: string
  department: string
  hasResume: boolean
}

interface JobDetail extends Omit<JobSummary, 'hasResume'> {
  jdText: string
  resumeId: string | null
}

interface ConfirmedFact {
  id: string
  text: string
  sourceText: string
  stage: keyof typeof stages
  project: { id: string; title: string; status: string } | null
}

const stages = { active: materialsCopy.active, done: materialsCopy.done, unknown: materialsCopy.unknown, planned: materialsCopy.planned }
const emptyJob = { company: '', role: '', city: '', salary: '', department: '', jdText: '' }
const fields = ['company', 'role', 'city', 'salary', 'department'] as const

type TailoringState = { analysis: JobRequirementAnalysis | null; proposal: TailoringProposal | null }

export function JobsWorkspace() {
  const [jobs, setJobs] = useState<JobSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const materialDrafts = useRef(new Map<string, MaterialDraft>())
  const current = selected ?? jobs[0]?.id
  useUnsavedNavigation(() => Array.from(materialDrafts.current.values()).some(draft => Boolean(draft.content)))

  useEffect(() => {
    const controller = new AbortController()
    void api<JobSummary[]>('/api/jobs', { signal: controller.signal }).then(setJobs).catch((error: Error) => {
      if (!controller.signal.aborted) setError(error.message)
    })
    return () => controller.abort()
  }, [])

  function updateList(job: JobDetail, moveToTop: boolean) {
    const summary = { ...job, hasResume: Boolean(job.resumeId) }
    setJobs(rows => moveToTop
      ? [summary, ...rows.filter(row => row.id !== job.id)]
      : rows.map(row => row.id === job.id ? summary : row))
    notifyChanged()
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <header className="flex items-end gap-4 border-b border-[#e9edf4] px-6 py-4">
        <div>
          <h1 className="text-[21px] font-semibold">{copy.jobsTitle}</h1>
          <p className="mt-1 text-[12.5px] text-[#7c8899]">{copy.jobsLead}</p>
        </div>
        <button className="cd-button cd-primary ml-auto" onClick={() => setAdding(true)}>{copy.addJob}</button>
      </header>
      <section className="flex min-h-0 flex-1">
        <div className="w-[clamp(165px,21vw,295px)] shrink-0 overflow-y-auto border-r border-[#e6eaf1] bg-white p-2.5">
          {error && <p role="alert" className="cd-error">{error}</p>}
          {!error && jobs.length === 0 && <p className="px-2 py-6 text-[12.5px] text-[#7c8899]">{copy.noJob}</p>}
          {jobs.map(job => (
            <button key={job.id} aria-current={current === job.id} className={`mb-1.5 w-full rounded-xl px-3.5 py-3 text-left ${current === job.id ? 'border border-[#dbe6ff] bg-[#f7faff]' : 'hover:bg-[#fafbfd]'}`} onClick={() => setSelected(job.id)}>
              <p className="truncate text-[13px] font-semibold">{job.role}</p>
              <p className="truncate text-[11px] text-[#6b778a]">{[job.company, job.city, job.salary].filter(Boolean).join(' · ')}</p>
              <p className="mt-2 text-[11px] text-[#6b778a]">{job.hasResume ? c.draftExists : c.draftMissing}</p>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {current && <JobWorkflow key={current} id={current} onUpdated={updateList}
            initialMaterial={materialDrafts.current.get(current)}
            onMaterialChange={draft => materialDrafts.current.set(current, draft)}
          />}
        </div>
      </section>
      {adding && <AddJob onClose={() => setAdding(false)} onCreated={job => {
        updateList(job, true)
        setSelected(job.id)
        setAdding(false)
      }} />}
    </main>
  )
}

function usableFacts(facts: ConfirmedFact[]) {
  return facts.filter(fact => fact.project && fact.project.status !== 'planned' && fact.stage !== 'planned')
}

function sameIds(a: string[], b: string[]) {
  return a.length === b.length && a.every(id => b.includes(id))
}

function defaultFacts(facts: ConfirmedFact[]) {
  let total = 0
  const ids: string[] = []
  for (const fact of facts) {
    if (ids.length === 1000 || total + fact.text.length > 30000) break
    ids.push(fact.id)
    total += fact.text.length
  }
  return ids
}

function JobWorkflow({ id, onUpdated, initialMaterial, onMaterialChange }: {
  id: string
  onUpdated: (job: JobDetail, moveToTop: boolean) => void
  initialMaterial?: MaterialDraft
  onMaterialChange: (draft: MaterialDraft) => void
}) {
  const router = useRouter()
  const route = `/api/jobs/${id}`
  const operation = useRef<AbortController | null>(null)
  const [job, setJob] = useState<JobDetail | null>(null)
  const [analysis, setAnalysis] = useState<JobRequirementAnalysis | null>(null)
  const [proposal, setProposal] = useState<TailoringProposal | null>(null)
  const [facts, setFacts] = useState<ConfirmedFact[]>([])
  const [factIds, setFactIds] = useState<string[]>([])
  const [absent, setAbsent] = useState<string[]>([])
  const [jd, setJd] = useState('')
  const [editingJd, setEditingJd] = useState(false)
  const [pageTarget, setPageTarget] = useState<1 | 2>(1)
  const [busy, setBusy] = useState('')
  const [materialPending, setMaterialPending] = useState(false)
  const [factsNeedRefresh, setFactsNeedRefresh] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [reload, setReload] = useState(0)
  useUnsavedNavigation(() => Boolean(job && editingJd && jd !== job.jdText))

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    void Promise.all([
      api<JobDetail>(route, { signal }),
      api<TailoringState>(`${route}/tailoring`, { signal }),
      api<ConfirmedFact[]>('/api/materials/confirmed', { signal }),
    ]).then(([savedJob, tailored, confirmed]) => {
      if (signal.aborted) return
      const eligible = usableFacts(confirmed)
      setJob(savedJob)
      setJd(savedJob.jdText)
      setAnalysis(tailored.analysis)
      setProposal(tailored.proposal)
      setPageTarget(tailored.proposal?.pageTarget ?? 1)
      setFacts(eligible)
      setFactIds(tailored.analysis ? tailored.analysis.facts.map(fact => fact.id).filter(id => eligible.some(fact => fact.id === id)) : defaultFacts(eligible))
      setAbsent(tailored.analysis?.absentRequirementIds ?? [])
    }).catch((error: Error) => { if (!signal.aborted) setError(error.message) })
    return () => {
      controller.abort()
      operation.current?.abort()
      operation.current = null
    }
  }, [route, reload])

  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return
    const controller = new AbortController()
    operation.current = controller
    setBusy(label)
    setError('')
    setStatus('')
    try {
      await work(controller.signal)
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : c.requestFailed)
    } finally {
      if (operation.current === controller) {
        operation.current = null
        setBusy('')
      }
    }
  }

  function refreshFacts() {
    setFactsNeedRefresh(true)
    void run(c.loading, async signal => {
      const [confirmed, tailored] = await Promise.all([
        api<ConfirmedFact[]>('/api/materials/confirmed', { signal }),
        api<TailoringState>(`${route}/tailoring`, { signal }),
      ])
      if (signal.aborted) return
      const eligible = usableFacts(confirmed)
      const retained = factIds.filter(id => eligible.some(fact => fact.id === id))
      const added = eligible.filter(fact => !facts.some(old => old.id === fact.id))
      setFactIds(defaultFacts([...eligible.filter(fact => retained.includes(fact.id)), ...added]))
      setFacts(eligible)
      setAnalysis(tailored.analysis)
      setProposal(tailored.proposal)
      setFactsNeedRefresh(false)
      notifyChanged()
    })
  }

  if (!job) return error ? <div role="alert" className="space-y-2"><p className="cd-error">{error}</p><button className="cd-button" onClick={() => { setError(''); setReload(n => n + 1) }}>{c.retry}</button></div> : <p role="status">{c.loading}</p>

  const selectionChanged = analysis && (!sameIds(factIds, analysis.facts.map(fact => fact.id)) || !sameIds(absent, analysis.absentRequirementIds))
  const analysisStale = Boolean(analysis && (analysis.stale || analysis.jdText !== job.jdText))
  const jdTooLong = jd.length > MAX_JD_LENGTH
  const readyJd = Boolean(job.jdText.trim()) && !jdTooLong && jd === job.jdText
  const updateJob = (next: JobDetail, moveToTop = false) => { setJob(next); onUpdated(next, moveToTop) }
  const grouped = new Map<string, { title: string; facts: ConfirmedFact[] }>()
  for (const fact of facts) {
    if (!fact.project) continue
    const group = grouped.get(fact.project.id) ?? { title: fact.project.title, facts: [] }
    group.facts.push(fact)
    grouped.set(fact.project.id, group)
  }

  return (
    <div className="mx-auto max-w-[960px] space-y-4 pb-5 text-[13px]">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-[18px] font-semibold">{job.role}</h2>
          <p className="mt-1 text-[#6b778a]">{[job.company, job.city, job.salary, job.department].filter(Boolean).join(' · ')}</p>
        </div>
        <button className="cd-button" disabled={Boolean(busy) || materialPending} onClick={() => {
          if (job.resumeId) router.push(`/resume?id=${job.resumeId}`)
          else void run(c.loading, async signal => {
            const { resumeId } = await api<{ resumeId: string }>(`${route}/resume`, { method: 'POST', signal })
            if (signal.aborted) return
            updateJob({ ...job, resumeId })
            router.push(`/resume?id=${resumeId}`)
          })
        }}>{job.resumeId ? c.openDraft : c.manualDraft}</button>
      </div>
      <section className="cd-card">
        <div className="mb-2 flex items-center gap-2">
          <h3 className="font-semibold">{copy.jd}</h3>
          {!editingJd && <button className="cd-button ml-auto" disabled={Boolean(busy) || materialPending} onClick={() => setEditingJd(true)}>{c.editJd}</button>}
        </div>
        {editingJd ? (
          <form className="space-y-2" onSubmit={event => {
            event.preventDefault()
            if (jdTooLong || !jd.trim() || materialPending) return
            void run(copy.saving, async signal => {
              const next = await api<JobDetail>(route, { method: 'PATCH', signal, body: JSON.stringify({ jdText: jd }) })
              if (signal.aborted) return
              updateJob(next, true)
              setEditingJd(false)
              setAbsent([])
              const tailored = await api<TailoringState>(`${route}/tailoring`, { signal })
              if (!signal.aborted) { setAnalysis(tailored.analysis); setProposal(tailored.proposal) }
            })
          }}>
            <textarea className="cd-input min-h-36" aria-label={copy.jd} aria-describedby="job-jd-size" aria-invalid={jdTooLong}
              value={jd} required disabled={Boolean(busy)} onChange={event => setJd(event.target.value)} />
            <JdSize id="job-jd-size" length={jd.length} />
            <div className="flex gap-2">
              <button className="cd-button cd-primary" disabled={Boolean(busy) || materialPending || jdTooLong || !jd.trim() || jd === job.jdText}>{c.saveJob}</button>
              <button type="button" className="cd-button" disabled={Boolean(busy)} onClick={() => { setJd(job.jdText); setEditingJd(false) }}>{copy.cancel}</button>
            </div>
          </form>
        ) : <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{job.jdText}</p>}
        {!editingJd && jdTooLong && <JdSize id="job-jd-size" length={job.jdText.length} />}
      </section>
      <section className="cd-card space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">{c.selectFacts}</h3>
          <span className="cd-muted">{c.selectedFacts(factIds.length)}</span>
        </div>
        <p className="cd-muted">{facts.length ? c.factHint : c.noFacts}</p>
        {Array.from(grouped, ([projectId, group]) => (
          <details className="cd-details" key={projectId}>
            <summary>{group.title} · {c.selectedFacts(group.facts.filter(fact => factIds.includes(fact.id)).length)}</summary>
            <div className="mt-2 space-y-2">
              {group.facts.map(fact => <div key={fact.id} className="border-t border-[#eef1f6] pt-2">
                <label className="flex items-baseline gap-2 [overflow-wrap:anywhere]">
                  <input type="checkbox" checked={factIds.includes(fact.id)} disabled={Boolean(busy)} onChange={event => setFactIds(ids => event.target.checked ? [...ids, fact.id] : ids.filter(id => id !== fact.id))} />
                  <span>{fact.text} <span className="cd-muted">{stages[fact.stage]}</span></span>
                </label>
                <details className="ml-5 mt-1 text-[12px] text-[#526176]">
                  <summary>{materialsCopy.source}</summary>
                  <blockquote className="cd-quote">{fact.sourceText}</blockquote>
                </details>
              </div>)}
            </div>
          </details>
        ))}
        <details id="job-materials" className="cd-details">
          <summary>{c.materialSection}</summary>
          <div className="mt-3"><MaterialIntake requireProject onChanged={refreshFacts} onPendingChange={setMaterialPending} blocked={Boolean(busy)}
            initialDraft={initialMaterial} onDraftChange={onMaterialChange}
          /></div>
        </details>
      </section>
      <section className="cd-card space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="mr-auto font-semibold">{c.analysisTitle}</h3>
          <button className="cd-button cd-primary" disabled={Boolean(busy) || materialPending || factsNeedRefresh || !readyJd} onClick={() => void run(c.analyzing, async signal => {
            const body: AnalyzeJobInput = { factIds, absentRequirementIds: absent }
            const result = await api<JobRequirementAnalysis>(`${route}/tailoring/analyze`, { method: 'POST', signal, body: JSON.stringify(body) })
            if (signal.aborted) return
            const tailored = await api<TailoringState>(`${route}/tailoring`, { signal })
            if (signal.aborted) return
            const latest = tailored.analysis ?? result
            setAnalysis(latest)
            setAbsent(latest.absentRequirementIds)
            setProposal(tailored.proposal)
          })}>{c.analyze}</button>
        </div>
        {busy && <div className="flex flex-wrap items-center gap-2" role="status">
          <span>{busy}</span>
          {(busy === c.analyzing || busy === c.drafting) && <button className="cd-button" onClick={() => {
            operation.current?.abort()
            operation.current = null
            setBusy('')
            setStatus(c.cancelled)
          }}>{c.cancelTask}</button>}
        </div>}
        {status && <p role="status">{status}</p>}
        {error && <p role="alert" className="cd-error">{error}</p>}
        {factsNeedRefresh && !busy && <button className="cd-button" onClick={refreshFacts}>{materialsCopy.refresh}</button>}
        {analysis && <>
          {analysis.provider === 'fake' && <p className="cd-demo">{c.fake}</p>}
          {(analysisStale || selectionChanged) && <p role="status" className="cd-warning">{analysisStale ? c.analysisStale : c.selectionStale}</p>}
          <AnalysisResults analysis={analysis} absent={absent} canMark={!busy && !analysisStale} onMark={id => setAbsent(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id])} />
          <div className="flex flex-wrap items-end gap-2 border-t border-[#eef1f6] pt-3">
            <label className="block text-[12px]">{c.pageTarget}
              <select className="cd-input mt-1" value={pageTarget} disabled={Boolean(busy)} onChange={event => setPageTarget(event.target.value === '2' ? 2 : 1)}>
                <option value={1}>{c.pages(1)}</option>
                <option value={2}>{c.pages(2)}</option>
              </select>
            </label>
            <button className="cd-button cd-primary" disabled={Boolean(busy || analysisStale || selectionChanged || !readyJd || materialPending || factsNeedRefresh)} onClick={() => void run(c.drafting, async signal => {
              const latest = await api<JobDetail>(route, { signal })
              const expectedRevision = latest.resumeId ? (await api<{ revision: number }>(`/api/resumes/${latest.resumeId}`, { signal })).revision : 0
              const body: GenerateDraftInput = { analysisId: analysis.id, expectedInputHash: analysis.inputHash, expectedRevision, pageTarget }
              const result = await api<TailoringProposal>(`${route}/tailoring/draft`, { method: 'POST', signal, body: JSON.stringify(body) })
              if (signal.aborted) return
              setProposal(result)
              updateJob({ ...job, resumeId: result.resumeId })
              router.push(`/resume?id=${result.resumeId}`)
            })}>{c.draft}</button>
            {proposal && <button className="cd-button" disabled={Boolean(busy)} onClick={() => router.push(`/resume?id=${proposal.resumeId}`)}>{c.openReview}</button>}
          </div>
        </>}
      </section>
    </div>
  )
}

function AnalysisResults({ analysis, absent, canMark, onMark }: { analysis: JobRequirementAnalysis; absent: string[]; canMark: boolean; onMark: (id: string) => void }) {
  const factsById = new Map(analysis.facts.map(fact => [fact.id, fact]))
  const assessments = new Map(analysis.assessments.map(assessment => [assessment.requirementId, assessment]))
  return (
    <>
      <div className="overflow-x-auto">
        <table className="cd-requirements w-full text-left text-[12px]">
          <thead><tr><th scope="col">{c.required}</th><th scope="col">{c.evidence}</th></tr></thead>
          <tbody>{analysis.requirements.map(requirement => {
            const assessment = assessments.get(requirement.id)
            return <tr key={requirement.id}>
              <td>
                <p className="font-medium">{requirement.text}</p>
                <p className="cd-muted">{c.requirementKind[requirement.kind]}</p>
                {requirement.alternatives.length > 0 && <p className="cd-muted">{c.alternatives} · {requirement.alternatives.join(' / ')}</p>}
                <details className="mt-1"><summary>{copy.jd}</summary><blockquote className="cd-quote">{analysis.jdText.slice(requirement.jdRef.start, requirement.jdRef.end)}</blockquote></details>
              </td>
              <td>
                {assessment && <><p className="font-medium">{c.assessmentState[assessment.state]}</p><p className="cd-muted">{assessment.reason}</p>
                  {assessment.factIds.map(id => {
                    const fact = factsById.get(id)
                    return fact && <details key={id} className="mt-1"><summary>{fact.project.title} · {fact.text}</summary><blockquote className="cd-quote">{fact.sourceText}</blockquote></details>
                  })}
                  {(assessment.state === 'not_shown' || assessment.state === 'confirmed_absent') &&
                    <label className="mt-2 flex items-start gap-1.5">
                      <input type="checkbox" className="mt-0.5" checked={absent.includes(requirement.id)} disabled={!canMark} onChange={() => onMark(requirement.id)} />
                      {c.noExperience}
                    </label>}
                </>}
              </td>
            </tr>
          })}</tbody>
        </table>
      </div>
      {analysis.questions.length > 0 && <div>
        <h4 className="font-semibold">{c.questions}</h4>
        <ul className="my-1 list-disc space-y-1 pl-5">{analysis.questions.map(item => <li key={item.id}>{item.question}</li>)}</ul>
        <p className="cd-muted">{c.questionHelp}</p>
      </div>}
    </>
  )
}

function AddJob({ onClose, onCreated }: { onClose: () => void; onCreated: (job: JobDetail) => void }) {
  const [form, setForm] = useState(emptyJob)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const jdTooLong = form.jdText.length > MAX_JD_LENGTH
  useUnsavedNavigation(() => Object.values(form).some(Boolean))

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || jdTooLong || !form.jdText.trim()) return
    setSaving(true)
    setError('')
    try {
      onCreated(await api<JobDetail>('/api/jobs', { method: 'POST', body: JSON.stringify(form) }))
    } catch (error) {
      setError(error instanceof Error ? error.message : c.requestFailed)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#101828]/35 p-6">
      <form role="dialog" aria-modal aria-labelledby="new-job-title" className="max-h-full w-[640px] overflow-y-auto rounded-2xl bg-white" onSubmit={event => void save(event)}>
        <h2 id="new-job-title" className="border-b border-[#eef1f6] px-6 py-4 text-[16px] font-semibold">{copy.addJob}</h2>
        <fieldset disabled={saving} className="grid grid-cols-2 gap-3 px-6 py-4 text-[12px]">
          {fields.map(field => <label key={field}>{copy[field]}
            <input className="cd-input mt-1" value={form[field]} onChange={event => setForm({ ...form, [field]: event.target.value })} />
          </label>)}
          <label className="col-span-2">{copy.jd}
            <textarea className="cd-input mt-1 min-h-40" aria-describedby="new-job-jd-size" aria-invalid={jdTooLong}
              value={form.jdText} required onChange={event => setForm({ ...form, jdText: event.target.value })} />
            <JdSize id="new-job-jd-size" length={form.jdText.length} />
          </label>
          {error && <p role="alert" className="cd-error col-span-2">{error}</p>}
        </fieldset>
        <div className="flex justify-end gap-2 border-t border-[#eef1f6] px-6 py-3">
          <button type="button" className="cd-button" disabled={saving} onClick={onClose}>{copy.cancel}</button>
          <button className="cd-button cd-primary" disabled={saving || jdTooLong || !form.jdText.trim()}>{saving ? copy.saving : c.saveJob}</button>
        </div>
      </form>
    </div>
  )
}

function JdSize({ id, length }: { id: string; length: number }) {
  const tooLong = length > MAX_JD_LENGTH
  return <p id={id} className={tooLong ? 'cd-error mt-1' : 'cd-muted mt-1'} role={tooLong ? 'alert' : undefined}>
    {tooLong && `${c.jdLimit} `}{c.sourceLength(length, MAX_JD_LENGTH)}
  </p>
}
