import { contentHash } from '@/domain/evidence'
import type { AnalysisPayload, ProposalPayload } from '@/domain/tailoring'

export type FrozenAnalysisInput = Omit<AnalysisPayload, 'requirements' | 'assessments' | 'questions'>
type DraftInput = Pick<ProposalPayload, 'schemaVersion' | 'promptVersion' | 'model' | 'pageTarget' | 'initialRevision'>

function hash(value: unknown) {
  return contentHash(JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, (item as Record<string, unknown>)[key]]))
      : item,
  ))
}

export function analysisInputHash(jobId: string, input: FrozenAnalysisInput) {
  const { schemaVersion, promptVersion, model, jdText, job, facts, absentRequirementIds } = input
  return hash({ jobId, schemaVersion, promptVersion, model, jdText, job, facts, absentRequirementIds })
}

export function draftInputHash(analysisId: string, analysisHash: string, input: DraftInput) {
  const { schemaVersion, promptVersion, model, pageTarget, initialRevision } = input
  return hash({ analysisId, analysisHash, schemaVersion, promptVersion, model, pageTarget, initialRevision })
}

export function requirementId(jdHash: string, requirement: Omit<AnalysisPayload['requirements'][number], 'id'>) {
  const { jdRef, kind, text, alternatives } = requirement
  return hash([jdHash, jdRef, kind, text, alternatives])
}

export function questionId(question: Omit<AnalysisPayload['questions'][number], 'id'>) {
  return hash([question.requirementId, question.projectId, question.kind, question.question])
}

const unique = (values: string[]) => new Set(values).size === values.length

export function validFrozenAnalysis(payload: AnalysisPayload) {
  const jdHash = contentHash(payload.jdText)
  const facts = new Set(payload.facts.map(f => f.id))
  const projects = new Set(payload.facts.map(f => f.projectId))
  const requirements = new Set(payload.requirements.map(r => r.id))
  const absent = new Set(payload.absentRequirementIds)
  return facts.size === payload.facts.length &&
    payload.facts.every(f => f.project.id === f.projectId && f.stage !== 'planned' &&
      f.sourceText.trim() && f.sourceText.length === f.sourceRef.end - f.sourceRef.start) &&
    requirements.size === payload.requirements.length &&
    payload.requirements.every(r => r.jdRef.end <= payload.jdText.length && r.id === requirementId(jdHash, r)) &&
    payload.assessments.length === requirements.size &&
    unique(payload.assessments.map(a => a.requirementId)) &&
    payload.assessments.every(a => requirements.has(a.requirementId) && a.factIds.every(id => facts.has(id)) &&
      (a.state === 'direct' || a.state === 'transferable') === (a.factIds.length > 0) &&
      (a.state === 'confirmed_absent') === absent.has(a.requirementId)) &&
    payload.absentRequirementIds.every(id => requirements.has(id)) &&
    unique(payload.questions.map(q => q.id)) &&
    payload.questions.every(q => q.id === questionId(q) && requirements.has(q.requirementId) &&
      !absent.has(q.requirementId) && (q.projectId === null || projects.has(q.projectId)))
}

export function validFrozenProposal(payload: ProposalPayload, analysis: AnalysisPayload) {
  const facts = new Map(analysis.facts.map(f => [f.id, f]))
  const matches = new Map(analysis.assessments.filter(a => a.state === 'direct' || a.state === 'transferable')
    .map(a => [a.requirementId, a.factIds]))
  const replacements = payload.bullets.filter(b => b.replacementIndex !== null)
  const rankedProjects = new Set(payload.bullets.filter(b => b.risks.every(r => r.severity !== 'blocked')).map(b => b.projectId))
  return unique(payload.bullets.map(b => b.id)) &&
    unique(replacements.map(b => JSON.stringify([b.projectId, b.replacementIndex]))) &&
    rankedProjects.size === payload.projectOrder.length && payload.projectOrder.every(id => rankedProjects.has(id)) &&
    payload.bullets.every(bullet => {
      const { factIds, requirementIds, projectId, sources, replacementIndex, originalText } = bullet
      return (replacementIndex === null) === (originalText === null) &&
        !/[\r\n]/.test(bullet.text) && factIds.length > 0 && requirementIds.length > 0 &&
        sources.length === factIds.length && unique(sources.map(source => source.factId)) &&
        requirementIds.every(id => matches.get(id)?.some(factId => factIds.includes(factId))) &&
        factIds.every(id => requirementIds.some(requirement => matches.get(requirement)?.includes(id))) &&
        sources.every(source => {
          const fact = facts.get(source.factId)
          return factIds.includes(source.factId) && fact?.projectId === projectId &&
            (fact.stage === 'active' || fact.stage === 'done') &&
            source.text === fact.text && source.sourceText === fact.sourceText &&
            source.sourceRef.materialId === fact.sourceRef.materialId && source.sourceRef.start === fact.sourceRef.start &&
            source.sourceRef.end === fact.sourceRef.end && source.sourceRef.contentHash === fact.sourceRef.contentHash
        })
    })
}
