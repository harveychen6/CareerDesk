import { z } from 'zod'
import { createHash } from 'node:crypto'
import { AnalysisPayloadSchema, ProposalPayloadSchema, ResumeDocumentV1Schema, type AnalysisPayload } from '@/domain/tailoring'
import { analysisInputHash, draftInputHash, validFrozenAnalysis, validFrozenProposal } from '@/domain/tailoring-integrity'
const id = z.string().min(1), s = z.string(), n = z.number().int(), nullable = s.nullable()
const profile = z.object({ id: z.literal(1), name:s, headline:s, years:s, location:s, phone:s, email:s, links:s, summary:s, education:s, skillsJson:s, workExperience:s.optional(), photo:s.optional() }).strict()
const project = z.object({ id, title:s, status:z.enum(['planned','active','done']), summary:s, tagsJson:s, factsMarkdown:s, todos:s, resumeBullet:s, org:s, periodStart:s, periodEnd:s, factsUpdatedAt:nullable, bulletUpdatedAt:nullable, masterSyncedAt:nullable, updatedAt:s }).strict()
const job = z.object({ id, company:s, role:s, city:s, salary:s, department:s, jdText:s, matchScore:n, updatedAt:s }).strict()
const keyword = z.object({ id, jobId:id, text:s, evidenceStatus:s }).strict()
const match = z.object({ id, jobId:id, projectId:id, relevance:n, reason:s, rank:n }).strict()
const resume = z.object({ id, type:z.enum(['master','targeted']), jobId:nullable, summary:s, updatedAt:s, currentRevisionId:nullable.optional() }).strict()
const item = z.object({ id, resumeId:id, projectId:id, included:z.union([z.literal(0),z.literal(1)]), bulletOverride:s, sortOrder:n }).strict()
const proposal = z.object({ id, projectId:id, baseBullet:s, proposedBullet:s, evidenceNote:s, status:z.enum(['pending','accepted','dismissed','rejected']) }).strict()
const settings = z.object({ id:z.literal(1), syncIntervalDays:n, lastMasterSyncAt:nullable }).strict()
const material = z.object({ id, projectId:nullable, title:nullable, content:s, contentHash:s, createdAt:s }).strict()
const fact = z.object({ id, materialId:id, projectId:nullable, text:s, sourceStart:n.nonnegative(), sourceEnd:n.nonnegative(), status:z.enum(['candidate','confirmed','rejected']), stage:z.enum(['planned','active','done','unknown']), revision:n.positive(), createdAt:s }).strict()
const analysis = z.object({ id, jobId:id, inputHash:s, payloadJson:s, createdAt:s }).strict()
const tailoring = z.object({ id, resumeId:id, jobId:id, analysisId:id, inputHash:s, baseRevision:n.nonnegative(), payloadJson:s, createdAt:s }).strict()
const revision = z.object({ id, resumeId:id, revision:n.positive(), kind:z.enum(['working','submitted']), documentJson:s, createdAt:s }).strict()
const base = { profile:profile.nullable().optional(), projects:z.array(project), jobs:z.array(job), keywords:z.array(keyword), matches:z.array(match), resumes:z.array(resume), resumeItems:z.array(item), proposals:z.array(proposal), settings:settings.nullable().optional() }
const v1 = z.object({ version:z.literal(1), ...base }).strict()
const v2 = z.object({ version:z.literal(2), ...base, profile: profile.nullable(), settings:settings.nullable(), resumes:z.array(resume.extend({currentRevisionId:nullable})), sourceMaterials:z.array(material), evidenceFacts:z.array(fact), jobAnalyses:z.array(analysis), tailoringProposals:z.array(tailoring), resumeRevisions:z.array(revision) }).strict()
export function validateBackup(input: unknown) {
  const b = z.discriminatedUnion('version',[v1,v2]).parse(input)
  const unique = (rows: { id:string }[]) => { const ids = rows.map(r => r.id); if (new Set(ids).size !== ids.length) throw new Error('备份包含重复 ID'); return new Set(ids) }
  const ps=unique(b.projects), js=unique(b.jobs), rs=unique(b.resumes); unique(b.keywords); unique(b.matches); unique(b.resumeItems); unique(b.proposals)
  const requireRef=(ok:unknown) => { if (!ok) throw new Error('备份关联无效') }
  b.keywords.forEach(x=>requireRef(js.has(x.jobId))); b.matches.forEach(x=>requireRef(js.has(x.jobId)&&ps.has(x.projectId))); b.resumes.forEach(x=>requireRef(x.type === 'master' ? x.jobId === null : x.jobId !== null && js.has(x.jobId))); b.resumeItems.forEach(x=>requireRef(rs.has(x.resumeId)&&ps.has(x.projectId))); b.proposals.forEach(x=>requireRef(ps.has(x.projectId)))
  requireRef(b.resumes.filter(x=>x.type==='master').length <= 1); requireRef(new Set(b.resumes.filter(x=>x.jobId).map(x=>x.jobId)).size===b.resumes.filter(x=>x.jobId).length); requireRef(new Set(b.resumeItems.map(x=>`${x.resumeId}:${x.projectId}`)).size===b.resumeItems.length)
  b.projects.forEach(x=>{ z.array(s).parse(JSON.parse(x.tagsJson)) }); if(b.profile) z.array(s).parse(JSON.parse(b.profile.skillsJson))
  if(b.version===2) {
    const ms=unique(b.sourceMaterials), fs=unique(b.evidenceFacts), as=unique(b.jobAnalyses), ts=unique(b.tailoringProposals), vs=unique(b.resumeRevisions); void fs; void ts
    b.sourceMaterials.forEach(x=>requireRef((x.projectId===null||ps.has(x.projectId)) && createHash('sha256').update(x.content, 'utf8').digest('hex')===x.contentHash))
    b.evidenceFacts.forEach(x=>{const m=b.sourceMaterials.find(y=>y.id===x.materialId); requireRef(ms.has(x.materialId)&&(x.projectId===null||ps.has(x.projectId))&&m&&x.projectId===m.projectId&&x.sourceStart<x.sourceEnd&&x.sourceEnd<=m.content.length)})
    const frozenAnalyses = new Map<string, AnalysisPayload>()
    b.jobAnalyses.forEach(x=>{
      const payload=AnalysisPayloadSchema.parse(JSON.parse(x.payloadJson))
      requireRef(js.has(x.jobId)&&analysisInputHash(x.jobId,payload)===x.inputHash&&validFrozenAnalysis(payload))
      for (const fact of payload.facts) {
        const material=b.sourceMaterials.find(m=>m.id===fact.sourceRef.materialId)
        if (material?.contentHash===fact.sourceRef.contentHash) {
          requireRef(material.content.slice(fact.sourceRef.start,fact.sourceRef.end)===fact.sourceText)
        }
      }
      frozenAnalyses.set(x.id,payload)
    })
    b.tailoringProposals.forEach(x=>{
      const a=b.jobAnalyses.find(y=>y.id===x.analysisId); const r=b.resumes.find(y=>y.id===x.resumeId)
      requireRef(rs.has(x.resumeId)&&js.has(x.jobId)&&as.has(x.analysisId)&&a?.jobId===x.jobId&&r?.jobId===x.jobId)
      const payload=ProposalPayloadSchema.parse(JSON.parse(x.payloadJson))
      const frozen=frozenAnalyses.get(x.analysisId)
      requireRef(a&&frozen&&draftInputHash(a.id,a.inputHash,payload)===x.inputHash&&validFrozenProposal(payload,frozen))
      const working=b.resumeRevisions.filter(v=>v.resumeId===x.resumeId&&v.kind==='working').map(v=>v.revision)
      requireRef(working.includes(payload.initialRevision)&&working.includes(x.baseRevision)&&payload.initialRevision<=x.baseRevision)
    })
    b.resumeRevisions.forEach(x=>{requireRef(rs.has(x.resumeId)); ResumeDocumentV1Schema.parse(JSON.parse(x.documentJson))})
    requireRef(new Set(b.resumeRevisions.map(x=>`${x.resumeId}:${x.revision}`)).size===b.resumeRevisions.length)
    b.resumes.forEach(x=>{if(x.type==='targeted') { const v=b.resumeRevisions.find(y=>y.id===x.currentRevisionId); requireRef(vs.has(x.currentRevisionId??'')&&v?.resumeId===x.id&&v.kind==='working') } else requireRef(!x.currentRevisionId)})
  }
  return b
}
