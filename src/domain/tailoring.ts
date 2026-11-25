import { z } from 'zod'

const id = z.string().min(1).max(200)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().safe().nonnegative()
const pageTarget = z.union([z.literal(1), z.literal(2)])
const range = z.object({ start: revision, end: revision }).strict()
export const MaterialSourceRefSchema = range.extend({ materialId: id, contentHash: hash }).refine(ref => ref.end > ref.start)
export const EvidenceProvenanceSchema = z.object({ kind: z.enum(['legacy', 'user', 'evidence']), factId: z.string().nullable(), materialId: z.string().nullable(), sourceText: z.string(), status: z.enum(['unmapped', 'confirmed', 'rejected', 'candidate']), sourceRef: MaterialSourceRefSchema.optional() }).strict().superRefine((value, ctx) => { if (value.kind === 'evidence' && (!value.factId || !value.materialId || !value.sourceText)) ctx.addIssue({ code: 'custom', message: 'evidence provenance requires fact, material and source text' }) })
export const ResumeProfileSchema = z.object({ name: z.string(), headline: z.string(), years: z.string(), location: z.string(), phone: z.string(), email: z.string(), links: z.string(), education: z.string(), skills: z.array(z.string()), workExperience: z.string(), photo: z.string() }).strict()
export const ResumeProjectSchema = z.object({ projectId: z.string().min(1), title: z.string(), status: z.enum(['planned', 'active', 'done']), tags: z.array(z.string()), org: z.string(), periodStart: z.string(), periodEnd: z.string(), included: z.boolean(), bulletOverride: z.string(), bullet: z.string(), sourceBullet: z.string(), sortOrder: z.number().int(), todoCount: z.number().int().nonnegative(), provenance: z.array(EvidenceProvenanceSchema), bullets: z.array(z.object({ text: z.string(), provenance: z.array(EvidenceProvenanceSchema) }).strict()) }).strict()
export const ResumeDocumentV1Schema = z.object({ version: z.literal(1), profile: ResumeProfileSchema.nullable(), job: z.object({ company: z.string(), role: z.string(), matchScore: z.number(), city: z.string(), salary: z.string(), department: z.string(), jdText: z.string() }).strict().nullable(), summary: z.string(), pageTarget: z.union([z.literal(1), z.literal(2)]), projects: z.array(ResumeProjectSchema) }).strict().superRefine((doc, ctx) => { if (new Set(doc.projects.map(p => p.projectId)).size !== doc.projects.length) ctx.addIssue({ code: 'custom', message: 'duplicate project id' }) })
export type ResumeDocumentV1 = z.infer<typeof ResumeDocumentV1Schema>
export type ResumeProfile = z.infer<typeof ResumeProfileSchema>

const distinctIds = z.array(id).max(1000).refine(ids => new Set(ids).size === ids.length)
export const FactStageSchema = z.enum(['planned', 'active', 'done', 'unknown'])
export const RequirementKindSchema = z.enum(['responsibility', 'must', 'preferred', 'context'])
export const RequirementSchema = z.object({
  id, kind: RequirementKindSchema, text: z.string().trim().min(1).max(1800),
  jdRef: range.refine(ref => ref.end > ref.start),
  alternatives: z.array(z.string().trim().min(1).max(300)).max(20)
    .refine(items => items.length !== 1 && new Set(items).size === items.length),
}).strict()
export const AssessmentSchema = z.object({
  requirementId: id,
  state: z.enum(['direct', 'transferable', 'not_shown', 'confirmed_absent']),
  factIds: distinctIds,
  reason: z.string().trim().min(1).max(500),
}).strict()
export const QuestionSchema = z.object({
  id, requirementId: id, projectId: id.nullable(),
  kind: z.enum(['experience', 'scope', 'ownership', 'outcome', 'metric']),
  question: z.string().trim().min(1).max(300),
}).strict()
const projectMetadata = z.object({
  id, title: z.string(), status: z.enum(['active', 'done']), tags: z.array(z.string()),
  org: z.string(), periodStart: z.string(), periodEnd: z.string(), todoCount: revision,
}).strict()
const sourceReceipt = z.object({
  factId: id, text: z.string().trim().min(1).max(2000),
  sourceText: z.string().min(1).max(20000), sourceRef: MaterialSourceRefSchema,
}).strict()
const factSnapshot = sourceReceipt.omit({ factId: true }).extend({
  id, projectId: id, revision: revision.min(1), status: z.literal('confirmed'), stage: FactStageSchema,
  project: projectMetadata,
  material: z.object({ title: z.string().nullable(), createdAt: z.string() }).strict(),
}).strict()
const provider = z.enum(['fake', 'configured'])
const modelIdentity = z.object({ provider, model: z.string(), endpointHash: hash.nullable() }).strict()
const jobMetadata = z.object({
  company: z.string(), role: z.string(), city: z.string(), salary: z.string(), department: z.string(),
}).strict()
export const AnalyzeJobInputSchema = z.object({ factIds: distinctIds, absentRequirementIds: distinctIds.optional() }).strict()
export const GenerateDraftInputSchema = z.object({
  analysisId: id, expectedInputHash: hash, expectedRevision: revision, pageTarget,
}).strict()
export const ApplyProposalInputSchema = z.object({
  expectedRevision: revision.min(1),
  decisions: z.array(z.object({
    bulletId: id, action: z.enum(['accept', 'reject']), confirmRisk: z.boolean().optional(),
  }).strict()).min(1).max(24).refine(items => new Set(items.map(x => x.bulletId)).size === items.length),
}).strict()
export const AnalysisPayloadSchema = z.object({
  schemaVersion: z.literal(1), promptVersion: z.string(), model: modelIdentity,
  jdText: z.string().min(1).max(12000), job: jobMetadata, facts: z.array(factSnapshot).max(1000),
  absentRequirementIds: distinctIds,
  requirements: z.array(RequirementSchema).min(1).max(500),
  assessments: z.array(AssessmentSchema).min(1).max(500),
  questions: z.array(QuestionSchema).max(3),
}).strict()
export const TailoringRiskSchema = z.object({
  code: id, message: z.string().min(1), severity: z.enum(['blocked', 'confirm']),
}).strict()
export const ProposedBulletSchema = z.object({
  id, projectId: id, text: z.string().trim().min(1).max(700), originalText: z.string().nullable(),
  factIds: distinctIds, requirementIds: distinctIds, sources: z.array(sourceReceipt),
  reason: z.string().trim().min(1).max(500), risks: z.array(TailoringRiskSchema),
  status: z.enum(['pending', 'accepted', 'rejected']),
}).strict()
export const ProposalPayloadSchema = z.object({
  schemaVersion: z.literal(1), promptVersion: z.string(), model: modelIdentity, pageTarget,
  initialRevision: revision.min(1),
  projectOrder: distinctIds,
  bullets: z.array(ProposedBulletSchema.extend({ replacementIndex: revision.nullable() }).strict()).max(24),
  insufficiency: z.string().nullable(),
}).strict()

export type AnalyzeJobInput = z.infer<typeof AnalyzeJobInputSchema>
export type GenerateDraftInput = z.infer<typeof GenerateDraftInputSchema>
export type ApplyProposalInput = z.infer<typeof ApplyProposalInputSchema>
export type AnalysisPayload = z.infer<typeof AnalysisPayloadSchema>
export type ProposalPayload = z.infer<typeof ProposalPayloadSchema>
export type FrozenFact = z.infer<typeof factSnapshot>
export type TailoringRisk = z.infer<typeof TailoringRiskSchema>
export type ProposedBullet = z.infer<typeof ProposedBulletSchema>
export type JobRequirementAnalysis = AnalysisPayload & {
  id: string; jobId: string; inputHash: string; createdAt: string; provider: z.infer<typeof provider>; stale: boolean
}
export type TailoringProposal = Omit<ProposalPayload, 'bullets'> & {
  id: string; jobId: string; resumeId: string; analysisId: string; inputHash: string; baseRevision: number;
  createdAt: string; provider: z.infer<typeof provider>; bullets: ProposedBullet[]; stale: boolean
}
