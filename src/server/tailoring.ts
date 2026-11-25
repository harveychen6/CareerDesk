import { and, desc, eq, sql } from 'drizzle-orm'
import { contentHash } from '@/domain/evidence'
import {
  AnalysisPayloadSchema, AnalyzeJobInputSchema, ApplyProposalInputSchema, FactStageSchema,
  GenerateDraftInputSchema, ProposalPayloadSchema,
  type AnalysisPayload, type AnalyzeJobInput, type ApplyProposalInput, type FrozenFact, type GenerateDraftInput,
  type JobRequirementAnalysis, type ProposalPayload, type ResumeDocumentV1, type TailoringProposal,
} from '@/domain/tailoring'
import { guardTailoringBullet } from '@/domain/tailoring-guard'
import {
  analysisInputHash, draftInputHash, questionId, requirementId, validFrozenAnalysis, validFrozenProposal,
  type FrozenAnalysisInput,
} from '@/domain/tailoring-integrity'
import { segmentMaterial } from '@/server/ai/materials'
import { canceledRequest, type StructuredRequest } from '@/server/ai/structured'
import {
  ANALYSIS_PROMPT, DRAFT_PROMPT, requestAnalysis, requestDraft, tailoringModel, type DraftProject,
  type ModelAnalysis, type ModelDraft,
} from '@/server/ai/tailoring'
import { getDb, getSqlite } from '@/server/db'
import { jobAnalyses, jobTargets, resumes, tailoringProposals } from '@/server/db/schema'
import { newId, nowIso } from '@/server/ids'
import { listConfirmedFacts } from '@/server/materials'
import { currentResumeRevision, getResumeRevision, writeResumeRevision } from '@/server/resume-revisions'
import { generateTargetedResume, getResume } from '@/server/resumes'
import { RequestError } from '@/server/request-error'

type AnalysisRow = typeof jobAnalyses.$inferSelect
type ProposalRow = typeof tailoringProposals.$inferSelect
type Project = ResumeDocumentV1['projects'][number]
type DraftBullet = ProposalPayload['bullets'][number]
type Segment = ReturnType<typeof segmentMaterial>[number]

const conflict = () => new RequestError('stale_tailoring', 409, '岗位、事实或简历已变化，请刷新并重新生成')
const invalid = (message: string) => new RequestError('invalid_input', 400, message)
const missing = (message: string) => new RequestError('not_found', 404, message)
const notFoundJob = () => missing('岗位不存在')
const badProposal = () => invalid('建议的事实、岗位要求或原句引用无效')
const cancelIfNeeded = (signal?: AbortSignal) => { if (signal?.aborted) throw canceledRequest() }

function jobRow(jobId: string) {
  return getDb().select().from(jobTargets).where(eq(jobTargets.id, jobId)).get()
}

function resumeRow(jobId: string) {
  return getDb().select().from(resumes).where(eq(resumes.jobId, jobId)).get()
}

function freezeInput(jobId: string, factIds: string[], absentRequirementIds: string[]): FrozenAnalysisInput {
  const row = jobRow(jobId)
  if (!row) throw notFoundJob()
  const { company, role, city, salary, department, jdText } = row
  if (!jdText.trim()) throw invalid('请先保存完整岗位描述')
  if (jdText.length > 12000) throw new RequestError('input_too_large', 413, '岗位描述超过 12000 个字符，请缩小范围后再分析')
  const confirmed = new Map(listConfirmedFacts().map(f => [f.id, f]))
  const facts = [...factIds].sort().map((id): FrozenFact => {
    const fact = confirmed.get(id)
    if (!fact) throw invalid('所选事实未确认或已删除，请刷新并重新选择')
    if (!fact.project || !fact.projectId) throw invalid('所选事实没有有效关联项目，请移除它或在关联项目的材料中确认事实')
    if (fact.stage === 'planned' || fact.project.status === 'planned') throw invalid('所选事实或关联项目仍在计划中，请从本轮选择中移除')
    const { id: projectId, title, status, tags, org, periodStart, periodEnd, todoCount } = fact.project
    return {
      id, projectId, status: 'confirmed', stage: FactStageSchema.parse(fact.stage), revision: fact.revision,
      text: fact.text, sourceRef: fact.sourceRef, sourceText: fact.sourceText, material: fact.material,
      project: { id: projectId, title, status, tags, org, periodStart, periodEnd, todoCount },
    }
  })
  if (facts.reduce((total, fact) => total + fact.text.length, 0) > 30000) {
    throw new RequestError('input_too_large', 413, '确认事实总文本超过 30000 个字符，请减少所选事实')
  }
  return {
    schemaVersion: 1, promptVersion: ANALYSIS_PROMPT, model: tailoringModel(), jdText,
    job: { company, role, city, salary, department }, facts, absentRequirementIds: [...absentRequirementIds].sort(),
  }
}

function inputStillMatches(jobId: string, input: FrozenAnalysisInput, inputHash: string) {
  try {
    return analysisInputHash(jobId, freezeInput(jobId, input.facts.map(f => f.id), input.absentRequirementIds)) === inputHash
  } catch {
    return false
  }
}

function analysisRows(jobId: string) {
  return getDb().select().from(jobAnalyses).where(eq(jobAnalyses.jobId, jobId))
    .orderBy(desc(jobAnalyses.createdAt), sql`rowid desc`).all()
}

function activeAnalysisRow(jobId: string) {
  return getDb().select().from(jobAnalyses).where(eq(jobAnalyses.jobId, jobId))
    .orderBy(desc(jobAnalyses.createdAt), sql`rowid desc`).get()
}

function proposalRows(jobId: string, analysisId: string) {
  return getDb().select().from(tailoringProposals).where(and(eq(tailoringProposals.jobId, jobId), eq(tailoringProposals.analysisId, analysisId)))
    .orderBy(desc(tailoringProposals.createdAt), sql`rowid desc`).all()
}

function readAnalysis(row: AnalysisRow): JobRequirementAnalysis {
  const payload = AnalysisPayloadSchema.parse(JSON.parse(row.payloadJson))
  if (!validFrozenAnalysis(payload)) throw invalid('已保存的分析引用无效，请重新分析')
  return {
    ...payload, id: row.id, jobId: row.jobId, inputHash: row.inputHash, createdAt: row.createdAt,
    provider: payload.model.provider, stale: analysisInputHash(row.jobId, payload) !== row.inputHash ||
      !inputStillMatches(row.jobId, payload, row.inputHash),
  }
}

function decodeProposal(row: ProposalRow, analysis: JobRequirementAnalysis) {
  const payload = ProposalPayloadSchema.parse(JSON.parse(row.payloadJson))
  if (!validFrozenProposal(payload, analysis)) throw badProposal()
  return payload
}

function draftHash(analysis: JobRequirementAnalysis, pageTarget: 1 | 2, revision: number) {
  return draftInputHash(analysis.id, analysis.inputHash, {
    schemaVersion: 1, promptVersion: DRAFT_PROMPT, model: tailoringModel(), pageTarget, initialRevision: revision,
  })
}

function proposalIsStale(row: ProposalRow, payload: ProposalPayload, analysis: JobRequirementAnalysis | null, revision: number | undefined) {
  return !analysis || analysis.stale || analysis.id !== row.analysisId || analysis.jobId !== row.jobId || revision !== row.baseRevision ||
    row.inputHash !== draftHash(analysis, payload.pageTarget, payload.initialRevision)
}

function readProposal(row: ProposalRow, payload: ProposalPayload, stale: boolean): TailoringProposal {
  return {
    ...payload, id: row.id, resumeId: row.resumeId, jobId: row.jobId, analysisId: row.analysisId,
    inputHash: row.inputHash, baseRevision: row.baseRevision, createdAt: row.createdAt,
    provider: payload.model.provider, stale,
    bullets: payload.bullets.map(({ replacementIndex: _index, ...bullet }) => bullet),
  }
}

export function getJobTailoring(jobId: string) {
  if (!jobRow(jobId)) return null
  const latestAnalysis = activeAnalysisRow(jobId)
  if (!latestAnalysis) return { analysis: null, proposal: null }
  const analysis = readAnalysis(latestAnalysis)
  const latestProposal = proposalRows(jobId, analysis.id)[0]
  if (!latestProposal) return { analysis, proposal: null }
  const payload = decodeProposal(latestProposal, analysis)
  const revision = currentResumeRevision(latestProposal.resumeId)?.revision
  return { analysis, proposal: readProposal(latestProposal, payload, proposalIsStale(latestProposal, payload, analysis, revision)) }
}

function nextTimestamp(latest?: { createdAt: string }) {
  return latest && latest.createdAt >= nowIso() ? new Date(Date.parse(latest.createdAt) + 1).toISOString() : nowIso()
}

function materializeAnalysis(model: ModelAnalysis, input: FrozenAnalysisInput, segments: Segment[]): AnalysisPayload | null {
  const covered = new Set<string>()
  const requirements: AnalysisPayload['requirements'] = []
  const jdHash = contentHash(input.jdText)
  for (const candidate of model.requirements) {
    const start = segments.findIndex(s => s.id === candidate.segmentId)
    const end = segments.findIndex(s => s.id === (candidate.endSegmentId ?? candidate.segmentId))
    if (start < 0 || end < start) return null
    const jdRef = { start: segments[start].start, end: segments[end].end }
    const excerpt = input.jdText.slice(jdRef.start, jdRef.end).normalize('NFKC').toLowerCase()
    if (candidate.alternatives.some(option => !excerpt.includes(option.normalize('NFKC').toLowerCase()))) return null
    const { kind, text, alternatives } = candidate
    const requirement = { kind, text, alternatives, jdRef }
    requirements.push({ id: requirementId(jdHash, requirement), ...requirement })
    segments.slice(start, end + 1).forEach(s => covered.add(s.id))
  }
  const absent = new Set(input.absentRequirementIds)
  const requirementIds = new Set(requirements.map(r => r.id))
  if (covered.size !== segments.length || requirementIds.size !== requirements.length ||
    [...absent].some(id => !requirementIds.has(id)) || model.assessments.length !== requirements.length) return null
  const factIds = new Set(input.facts.map(f => f.id))
  const projects = new Set(input.facts.map(f => f.projectId))
  const assessments: AnalysisPayload['assessments'] = []
  for (const candidate of model.assessments) {
    const { requirementIndex, state, factIds: linked, reason } = candidate
    const requirement = requirements[requirementIndex]
    if (!requirement || assessments[requirementIndex] || linked.some(id => !factIds.has(id)) ||
      (state === 'not_shown') !== (linked.length === 0)) return null
    if (absent.has(requirement.id) && state !== 'not_shown') return null
    assessments[requirementIndex] = absent.has(requirement.id)
      ? { requirementId: requirement.id, state: 'confirmed_absent', factIds: [], reason: '用户明确确认没有相关经历' }
      : { requirementId: requirement.id, state, factIds: linked, reason }
  }
  const questions: AnalysisPayload['questions'] = []
  for (const candidate of model.questions) {
    const { requirementIndex, projectId, kind, question } = candidate
    const requirement = requirements[requirementIndex]
    if (!requirement || (projectId !== null && !projects.has(projectId))) return null
    if (absent.has(requirement.id)) continue
    const entry = { requirementId: requirement.id, projectId, kind, question }
    const id = questionId(entry)
    if (questions.some(q => q.id === id)) return null
    questions.push({ id, ...entry })
  }
  return { ...input, requirements, assessments, questions }
}

function priorRequirements(rows: AnalysisRow[], input: FrozenAnalysisInput, segments: Segment[]): ModelAnalysis['requirements'] {
  if (!input.absentRequirementIds.length) return []
  const prior = rows.map(row => AnalysisPayloadSchema.parse(JSON.parse(row.payloadJson))).find(payload => {
    const priorAbsence = new Set(payload.assessments.filter(a => a.state === 'not_shown' || a.state === 'confirmed_absent').map(a => a.requirementId))
    return payload.jdText === input.jdText && input.absentRequirementIds.every(id => priorAbsence.has(id))
  })
  if (!prior) throw invalid('只能把同一份岗位描述中待确认的要求标记为没有相关经历')
  return prior.requirements.map(({ jdRef, kind, text, alternatives }) => {
    const segmentId = segments.find(s => s.start === jdRef.start)?.id
    const endSegmentId = segments.find(s => s.end === jdRef.end)?.id
    if (segmentId === undefined || endSegmentId === undefined) throw invalid('已有岗位要求的原文引用无效，请重新分析')
    return { kind, text, alternatives, segmentId, endSegmentId }
  })
}

export async function analyzeJobRequirements(jobId: string, body: AnalyzeJobInput, signal?: AbortSignal, request?: StructuredRequest) {
  cancelIfNeeded(signal)
  const { factIds, absentRequirementIds = [] } = AnalyzeJobInputSchema.parse(body)
  const input = freezeInput(jobId, factIds, absentRequirementIds)
  const inputHash = analysisInputHash(jobId, input)
  const rows = analysisRows(jobId)
  const reuse = (latest: AnalysisRow[]) => {
    const cached = latest.find(row => row.inputHash === inputHash)
    if (!cached) return null
    const result = readAnalysis(cached)
    if (result.stale) return null
    if (cached !== latest[0]) {
      cached.createdAt = nextTimestamp(latest[0])
      getDb().update(jobAnalyses).set({ createdAt: cached.createdAt }).where(eq(jobAnalyses.id, cached.id)).run()
    }
    return { ...result, createdAt: cached.createdAt }
  }
  const cached = reuse(rows)
  if (cached) return cached
  const jd = segmentMaterial(input.jdText)
  const previousRequirements = priorRequirements(rows, input, jd)
  let payload: AnalysisPayload | null = null
  await requestAnalysis({ jd, job: input.job, facts: input.facts, previousRequirements }, result => {
    payload = materializeAnalysis(result, input, jd)
    return payload !== null
  }, signal, request)
  return getSqlite().transaction(() => {
    cancelIfNeeded(signal)
    if (!inputStillMatches(jobId, input, inputHash)) throw conflict()
    const latest = analysisRows(jobId)
    const existing = reuse(latest)
    if (existing) return existing
    const row = { id: newId(), jobId, inputHash, createdAt: nextTimestamp(latest[0]),
      payloadJson: JSON.stringify(AnalysisPayloadSchema.parse(payload)) }
    getDb().insert(jobAnalyses).values(row).run()
    return readAnalysis(row)
  })()
}

function editableLines(project: Project | undefined): Project['bullets'] {
  if (!project?.bullet || (!project.included && !project.bulletOverride && project.provenance.every(p => p.kind === 'legacy'))) return []
  const recorded = project.bullets.map(b => b.text).join('\n') === project.bullet
    ? project.bullets
    : [{ text: project.bullet, provenance: project.provenance }]
  return recorded.flatMap(b => b.text.split('\n').map(text => ({ text, provenance: b.provenance })))
}

function eligibleProjects(analysis: JobRequirementAnalysis, pageTarget: 1 | 2, document?: ResumeDocumentV1): DraftProject[] {
  const requirementById = new Map(analysis.requirements.map(r => [r.id, r]))
  const facts = analysis.facts.filter(f => f.stage === 'done' || f.stage === 'active')
  const grouped = new Map<string, DraftProject>()
  for (const fact of facts) {
    const matches = analysis.assessments.filter(a => (a.state === 'direct' || a.state === 'transferable') && a.factIds.includes(fact.id))
    if (!matches.length) continue
    let project = grouped.get(fact.projectId)
    if (!project) {
      const original = editableLines(document?.projects.find(p => p.projectId === fact.projectId))
      project = { project: fact.project, facts: [], requirements: [], originals: original
        .map(({ text }, index) => ({ id: String(index), text })).filter(line => line.text.trim()) }
      grouped.set(fact.projectId, project)
    }
    project.facts.push(fact)
    for (const match of matches) {
      const existing = project.requirements.find(r => r.id === match.requirementId)
      if (existing) existing.factIds.push(fact.id)
      else {
        const requirement = requirementById.get(match.requirementId)!
        project.requirements.push({ ...requirement, state: match.state as 'direct' | 'transferable', factIds: [fact.id] })
      }
    }
  }
  const weight = (r: DraftProject['requirements'][number]) =>
    ({ must: 4, responsibility: 4, preferred: 2, context: 1 }[r.kind]) * (r.state === 'direct' ? 2 : 1)
  const score = (requirements: DraftProject['requirements'], factId?: string) => requirements
    .reduce((total, r) => total + (!factId || r.factIds.includes(factId) ? weight(r) : 0), 0)
  const ranked = [...grouped.values()].sort((a, b) => score(b.requirements) - score(a.requirements) || b.facts.length - a.facts.length)
  for (const project of ranked) project.facts.sort((a, b) => score(project.requirements, b.id) - score(project.requirements, a.id))
  return ranked.slice(0, pageTarget === 1 ? 3 : 6)
}

function supportFor(project: DraftProject, factIds: string[], requirementIds: string[]) {
  if (!factIds.length || !requirementIds.length) return null
  const facts = factIds.map(id => project.facts.find(f => f.id === id))
  const requirements = requirementIds.map(id => project.requirements.find(r => r.id === id))
  if (facts.some(f => !f) || requirements.some(r => !r?.factIds.some(id => factIds.includes(id))) ||
    factIds.some(id => !requirements.some(r => r?.factIds.includes(id)))) return null
  return facts as FrozenFact[]
}

function materializeDraft(model: ModelDraft, projects: DraftProject[], pageTarget: 1 | 2): DraftBullet[] | null {
  const bullets: DraftBullet[] = []
  for (const candidate of model.bullets) {
    const { projectId, text, factIds, requirementIds, reason, replaceId } = candidate
    const project = projects.find(p => p.project.id === projectId)
    const facts = project && supportFor(project, factIds, requirementIds)
    if (!project || !facts) return null
    const original = replaceId === undefined ? null : project.originals.find(line => line.id === replaceId)
    if (original === undefined || project.originals.some(item => item.text.trim() === text) ||
      bullets.some(b => b.projectId === projectId && (b.text === text || (original && String(b.replacementIndex) === original.id))) ||
      bullets.filter(b => b.projectId === projectId).length >= (pageTarget === 1 ? 3 : 4)) return null
    const sources = facts.map(({ id: factId, text, sourceText, sourceRef }) => ({ factId, text, sourceText, sourceRef }))
    bullets.push({
      id: newId(), projectId, text, factIds, requirementIds, reason, sources, status: 'pending',
      originalText: original?.text ?? null, replacementIndex: original ? Number(original.id) : null,
      risks: guardTailoringBullet(text, facts),
    })
  }
  return bullets
}

export async function generateTargetedDraft(jobId: string, body: GenerateDraftInput, signal?: AbortSignal, request?: StructuredRequest) {
  cancelIfNeeded(signal)
  const input = GenerateDraftInputSchema.parse(body)
  if (!jobRow(jobId)) throw notFoundJob()
  const latestAnalysis = activeAnalysisRow(jobId)
  if (!latestAnalysis || latestAnalysis.id !== input.analysisId) throw conflict()
  const analysis = readAnalysis(latestAnalysis)
  const resume = resumeRow(jobId)
  const base = resume ? currentResumeRevision(resume.id) : null
  if (analysis.stale || analysis.inputHash !== input.expectedInputHash || (base?.revision ?? 0) !== input.expectedRevision) throw conflict()
  const initialRevision = base?.revision ?? 1
  const { pageTarget } = input
  const inputHash = draftHash(analysis, pageTarget, initialRevision)
  const reuse = (rows: ProposalRow[]) => {
    if (!base) return null
    for (const row of rows) {
      if (row.resumeId !== resume?.id || row.baseRevision !== base.revision || row.inputHash !== inputHash) continue
      const payload = decodeProposal(row, analysis)
      if (payload.pageTarget !== pageTarget || payload.initialRevision !== initialRevision ||
        payload.bullets.some(b => b.risks.some(r => r.severity === 'blocked'))) continue
      if (row !== rows[0]) {
        row.createdAt = nextTimestamp(rows[0])
        getDb().update(tailoringProposals).set({ createdAt: row.createdAt }).where(eq(tailoringProposals.id, row.id)).run()
      }
      return readProposal(row, payload, false)
    }
    return null
  }
  const cached = reuse(proposalRows(jobId, analysis.id))
  if (cached) return cached
  const projects = eligibleProjects(analysis, pageTarget, base?.document)
  let bullets: DraftBullet[] | null = []
  if (projects.length) {
    await requestDraft({ jd: segmentMaterial(analysis.jdText), job: analysis.job, projects, pageTarget }, result => {
      bullets = materializeDraft(result, projects, pageTarget)
      return bullets !== null
    }, signal, request)
  }
  return getSqlite().transaction(() => {
    cancelIfNeeded(signal)
    const liveResume = resumeRow(jobId)
    const revision = liveResume ? currentResumeRevision(liveResume.id)?.revision : undefined
    const active = activeAnalysisRow(jobId)
    if (!inputStillMatches(jobId, analysis, analysis.inputHash) || resume?.id !== liveResume?.id || base?.revision !== revision ||
      active?.id !== latestAnalysis.id || active.createdAt !== latestAnalysis.createdAt ||
      draftHash(analysis, pageTarget, initialRevision) !== inputHash) throw conflict()
    const rows = proposalRows(jobId, analysis.id)
    const existing = reuse(rows)
    if (existing) return existing
    const resumeId = liveResume?.id ?? generateTargetedResume(jobId, { useLegacyMatches: false })
    if (!resumeId) throw notFoundJob()
    const candidates = bullets!
    const projectOrder = projects.filter(p => candidates.some(b => b.projectId === p.project.id &&
      !b.risks.some(r => r.severity === 'blocked'))).map(p => p.project.id)
    const payload = ProposalPayloadSchema.parse({
      schemaVersion: 1, promptVersion: DRAFT_PROMPT, model: tailoringModel(), initialRevision, pageTarget, projectOrder,
      bullets: candidates,
      insufficiency: projectOrder.length ? null : '当前确认材料不足以生成有事实支持的岗位描述，请补充相关经历或手工编辑',
    })
    const row = { id: newId(), jobId, resumeId, analysisId: analysis.id, inputHash,
      baseRevision: initialRevision, payloadJson: JSON.stringify(payload), createdAt: nextTimestamp(rows[0]) }
    getDb().insert(tailoringProposals).values(row).run()
    return readProposal(row, payload, false)
  })()
}

export function applyTailoringProposal(resumeId: string, proposalId: string, body: ApplyProposalInput) {
  const input = ApplyProposalInputSchema.parse(body)
  return getSqlite().transaction(() => {
    const row = getDb().select().from(tailoringProposals).where(eq(tailoringProposals.id, proposalId)).get()
    const resume = row ? resumeRow(row.jobId) : null
    if (!row || row.resumeId !== resumeId || resume?.id !== resumeId) throw missing('简历建议不存在')
    const latestAnalysis = activeAnalysisRow(row.jobId)
    if (latestAnalysis?.id !== row.analysisId) throw conflict()
    const analysis = readAnalysis(latestAnalysis)
    const payload = decodeProposal(row, analysis)
    const current = currentResumeRevision(resumeId)
    if (!current || proposalIsStale(row, payload, analysis, current.revision)) throw conflict()
    const pending = input.decisions.flatMap(decision => {
      const bullet = payload.bullets.find(b => b.id === decision.bulletId)
      if (!bullet) throw invalid('建议句不存在')
      const status = decision.action === 'accept' ? 'accepted' : 'rejected'
      if (bullet.status !== 'pending' && bullet.status !== status) throw new RequestError('decision_conflict', 409, '这条建议已经处理，无法更改原决定')
      return bullet.status === 'pending' ? [{ decision, bullet, status } as const] : []
    })
    if (!pending.length) return { resume: getResume(resumeId), proposal: readProposal(row, payload, false) }
    if (input.expectedRevision !== current.revision) throw conflict()
    const base = getResumeRevision(resumeId, payload.initialRevision)
    if (!base) throw conflict()
    const document = current.document
    const projects = eligibleProjects(analysis, payload.pageTarget, base.document)
    const accepted = pending.filter(p => p.status === 'accepted')
    for (const { decision, bullet } of accepted) {
      const project = projects.find(p => p.project.id === bullet.projectId)
      const facts = project && supportFor(project, bullet.factIds, bullet.requirementIds)
      if (!project || !facts || /[\r\n]/.test(bullet.text)) throw badProposal()
      const risks = guardTailoringBullet(bullet.text, facts)
      if (risks.some(r => r.severity === 'blocked')) throw new RequestError('unsafe_bullet', 400, '建议句包含无事实支持的数字、技术、职责或成果，无法接受')
      if (risks.some(r => r.severity === 'confirm') && decision.confirmRisk !== true) {
        throw new RequestError('confirm_bullet_risk', 400, '请核对事实边界后确认这条改写')
      }
      let target = document.projects.find(p => p.projectId === bullet.projectId)
      if (!target) {
        const { id: projectId, ...metadata } = project.project
        target = { ...metadata, projectId, included: false, sortOrder: 0, bullet: '', bulletOverride: '',
          sourceBullet: '', bullets: [], provenance: [] }
        document.projects.push(target)
      }
      const lines = editableLines(target)
      const line = { text: bullet.text, provenance: facts.map(f => ({
        kind: 'evidence' as const, factId: f.id, materialId: f.sourceRef.materialId, sourceText: f.sourceText,
        sourceRef: f.sourceRef, status: 'confirmed' as const,
      })) }
      if (bullet.replacementIndex !== null) {
        if (lines[bullet.replacementIndex]?.text !== bullet.originalText) throw conflict()
        lines[bullet.replacementIndex] = line
      } else {
        if (bullet.originalText !== null) throw badProposal()
        lines.push(line)
      }
      target.included = true
      target.bullets = lines
      target.provenance = lines.flatMap(l => l.provenance)
      target.bullet = lines.map(l => l.text).join('\n')
      target.bulletOverride = target.bullet
    }
    if (accepted.length) {
      const acceptedProjects = new Set([
        ...payload.bullets.filter(b => b.status === 'accepted').map(b => b.projectId),
        ...accepted.map(({ bullet }) => bullet.projectId),
      ])
      const suggested = payload.projectOrder.filter(id => acceptedProjects.has(id))
      const order = [...suggested, ...document.projects.filter(p => p.included && !suggested.includes(p.projectId)).map(p => p.projectId)]
      const included = document.projects.filter(p => p.included).sort((a, b) => {
        return order.indexOf(a.projectId) - order.indexOf(b.projectId)
      })
      included.forEach((project, index) => { project.sortOrder = included.length - index })
      document.projects.sort((a, b) => Number(b.included) - Number(a.included) || b.sortOrder - a.sortOrder)
      document.pageTarget = payload.pageTarget
      document.job = { ...analysis.job, jdText: analysis.jdText, matchScore: document.job?.matchScore ?? 0 }
      row.baseRevision = writeResumeRevision(resumeId, current.revision, document).revision
    }
    for (const item of pending) item.bullet.status = item.status
    getDb().update(tailoringProposals).set({ baseRevision: row.baseRevision, payloadJson: JSON.stringify(payload) })
      .where(eq(tailoringProposals.id, row.id)).run()
    return { resume: getResume(resumeId), proposal: readProposal(row, payload, false) }
  })()
}
