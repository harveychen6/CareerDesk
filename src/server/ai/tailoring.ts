import { z } from 'zod'
import { contentHash } from '@/domain/evidence'
import { RequirementKindSchema, type AnalysisPayload, type FrozenFact } from '@/domain/tailoring'
import { chatCompletionsUrl, resolveModel } from '@/server/ai/endpoint'
import { segmentMaterial } from '@/server/ai/materials'
import { runStructuredTask, type StructuredRequest } from '@/server/ai/structured'

export const ANALYSIS_PROMPT = 'jd-assessment-v1'
export const DRAFT_PROMPT = 'targeted-draft-v1'
export const tailoringModel = (): AnalysisPayload['model'] => process.env.AI_PROVIDER === 'fake'
  ? { provider: 'fake', model: 'local-lexical-v1', endpointHash: null }
  : {
    provider: 'configured',
    model: resolveModel(process.env.OPENAI_MODEL),
    endpointHash: contentHash(chatCompletionsUrl(process.env.OPENAI_BASE_URL)),
  }

const text = (max: number) => z.string().trim().min(1).max(max)
const ids = z.array(text(200)).max(1000).refine(items => new Set(items).size === items.length)
const alternatives = z.array(text(300)).max(20).refine(items => items.length !== 1 && new Set(items).size === items.length)
const requirementIndex = z.number().int().nonnegative()
const modelAnalysisSchema = z.object({
  requirements: z.array(z.object({
    kind: RequirementKindSchema, text: text(1800), segmentId: text(20), endSegmentId: text(20).optional(), alternatives,
  }).strict()).min(1).max(500),
  assessments: z.array(z.object({
    requirementIndex, state: z.enum(['direct', 'transferable', 'not_shown']), factIds: ids, reason: text(500),
  }).strict()).min(1).max(500),
  questions: z.array(z.object({
    requirementIndex, projectId: text(200).nullable(),
    kind: z.enum(['experience', 'scope', 'ownership', 'outcome', 'metric']), question: text(300),
  }).strict()).max(3),
}).strict()

const modelDraftSchema = z.object({
  bullets: z.array(z.object({
    projectId: text(200), text: text(700).refine(value => !/[\r\n]/.test(value)), factIds: ids,
    requirementIds: ids, reason: text(500), replaceId: text(200).optional(),
  }).strict()).max(24),
}).strict()
export type ModelAnalysis = z.infer<typeof modelAnalysisSchema>
export type ModelDraft = z.infer<typeof modelDraftSchema>
type Segment = ReturnType<typeof segmentMaterial>[number]
type AnalysisInput = {
  jd: Segment[]
  facts: FrozenFact[]
  job: AnalysisPayload['job']
  previousRequirements: ModelAnalysis['requirements']
}
export type DraftProject = {
  project: FrozenFact['project']
  facts: FrozenFact[]
  requirements: Array<AnalysisPayload['requirements'][number] & { state: 'direct' | 'transferable'; factIds: string[] }>
  originals: Array<{ id: string; text: string }>
}
type DraftInput = {
  jd: Segment[]
  job: AnalysisPayload['job']
  projects: DraftProject[]
  pageTarget: 1 | 2
}

function modelFacts(facts: FrozenFact[]) {
  return facts.map(({ id, projectId, text, stage, sourceRef, sourceText }) => ({
    id, projectId, text, stage,
    sourceSegmentId: `${sourceRef.materialId}:${sourceRef.start}:${sourceRef.end}`,
    sourceText,
  }))
}

const modelJd = (segments: Segment[]) => segments.map(({ id, text }) => ({ id, text }))

function fakeAnalysis(input: AnalysisInput): ModelAnalysis {
  const requirements = input.previousRequirements.length ? input.previousRequirements : input.jd.flatMap(segment => {
    const entries = segment.text.trim().split(/(?:[,，；;。]?(?:且|并且)(?=熟悉|掌握|具备|了解|有|能|需)|[；;。])/u).map(x => x.trim()).filter(Boolean)
    const kind: ModelAnalysis['requirements'][number]['kind'] = /优先|加分/.test(segment.text)
      ? 'preferred'
      : /职责|负责/.test(segment.text) ? 'responsibility' : 'must'
    return (entries.length ? entries : [segment.text.trim()]).map(text => {
      const subject = text.replace(/^(?:岗位职责|职责|必要条件|要求|任职要求)\s*[:：]\s*/, '')
      const options = subject.split(/或(?:者)?|\s+or\s+/i).map(x => x.trim()).filter(x => x && x.length <= 300)
      const branches = [...new Set(options)]
      return { kind, text: subject || text, segmentId: segment.id, alternatives: branches.length > 1 ? branches : [] }
    })
  })
  const assessments = requirements.map((requirement, requirementIndex) => {
    const queries = (requirement.alternatives.length ? requirement.alternatives : [requirement.text])
      .map(x => x.replace(/^(?:需|应|负责|熟悉|精通|掌握|具有|具备|了解)\s*/, '').trim().toLowerCase())
      .filter(x => x.length >= 2)
    const matches = input.facts.filter(fact => queries.some(query => fact.text.toLowerCase().includes(query)))
    const transferable = !matches.length && input.facts.filter(fact => queries.some(query =>
      query.match(/[a-z][a-z0-9.#+-]+/g)?.some(token => fact.text.toLowerCase().includes(token)),
    ))
    const applicable = matches.length ? matches : transferable || []
    return {
      requirementIndex, state: matches.length ? 'direct' as const : applicable.length ? 'transferable' as const : 'not_shown' as const,
      factIds: applicable.map(f => f.id),
      reason: applicable.length ? '离线示例按词语重合找到了候选事实，请人工核对' : '离线示例没有找到词语重合的确认材料',
    }
  })
  const questions = assessments.filter(a => a.state === 'not_shown').slice(0, 3).map(a => ({
    requirementIndex: a.requirementIndex, projectId: null, kind: 'experience' as const,
    question: `是否有与「${requirements[a.requirementIndex].text.slice(0, 130)}」有关的经历可以补充？`,
  }))
  return { requirements, assessments, questions }
}

export function requestAnalysis(input: AnalysisInput, validate: (result: ModelAnalysis) => boolean, signal?: AbortSignal, request?: StructuredRequest) {
  const prompt = [
    '完整解读 JD 与用户确认事实。返回 JSON {requirements,assessments,questions}，不要返回 Markdown。',
    'requirements 保留 JD 全部段落（包括背景），拆成独立原子项。每项 {kind: responsibility|must|preferred|context, text, segmentId, endSegmentId?, alternatives: string[]}。只用给出的段落 ID。多个连续段落可用 endSegmentId 表示范围。AND 要求拆成多项，OR 条件合并为一项并在 alternatives 列出可替代分支。已有固定要求时，保持其顺序、内容和来源 ID。',
    'assessments 对每项返回 {requirementIndex: 从 0 起的 requirements 下标, state: direct|transferable|not_shown, factIds: string[], reason}。无证据用 not_shown + []，不可断言没有经历。只能引用给出的确认事实。标签、项目名和原文的未确认细节不能单独作为证据，unknown 阶段不得解读为已完成。',
    'questions 最多 3 个，优先影响要点的缺失信息。每项 {requirementIndex, projectId: string|null, kind: experience|scope|ownership|outcome|metric, question}。无法定位项目时用 null。',
    JSON.stringify({
      job: input.job, jd: modelJd(input.jd), previousRequirements: input.previousRequirements,
      projects: [...new Map(input.facts.map(f => [f.project.id, f.project])).values()],
      facts: modelFacts(input.facts),
    }),
  ].join('\n')
  return runStructuredTask(prompt, modelAnalysisSchema, {
    signal, repair: true, validate,
    request: request ?? (process.env.AI_PROVIDER === 'fake' ? async () => fakeAnalysis(input) : undefined),
  })
}

function fakeDraft({ projects, pageTarget }: DraftInput): ModelDraft {
  return { bullets: projects.flatMap(({ project, facts, requirements, originals }) =>
    facts.filter(fact => fact.text.length <= 700 && !/[\r\n]/.test(fact.text) && !originals.some(item => item.text.trim() === fact.text))
      .slice(0, pageTarget === 1 ? 3 : 4)
      .map(fact => ({
        projectId: project.id, text: fact.text, factIds: [fact.id],
        requirementIds: requirements.filter(r => r.factIds.includes(fact.id)).map(r => r.id),
        reason: '离线示例直接使用命中要求的确认事实',
      })),
  ) }
}

export function requestDraft(input: DraftInput, validate: (result: ModelDraft) => boolean, signal?: AbortSignal, request?: StructuredRequest) {
  const prompt = [
    '依据完整 JD、要求对照和用户确认事实，编写技术简历的候选项目描述。返回 JSON {bullets}。',
    '每项 {projectId,text,factIds,requirementIds,reason,replaceId?}。text 是一条精炼项目描述，单行。只引用本项目确认事实和这些事实对应的要求 ID。',
    '优先强调与必要条件和核心职责直接或可迁移相关的个人贡献，弱相关细节省略。无支持句子可留空，不为凑数添加经验。按输入的项目顺序，每项目一页目标最多 3 条、两页最多 4 条。',
    '保留职责、成果归属、完成状态、指标对象、数字、单位、时段和条件。不得把团队成果写成个人成果、参与写成主导、试点写成全量上线，也不得从原数据推导百分比。进行中项目可以有已完成的子任务。JD、标签和原文未确认细节只供阅读，不能变成个人经历。',
    '可改写同项目一个已有条目时，返回该项目 originals 中对应的 replaceId。同一原句最多改写一次。新事实的描述省略 replaceId。不要重复已有的相同描述。',
    JSON.stringify({ job: input.job, jd: modelJd(input.jd), pageTarget: input.pageTarget,
      projects: input.projects.map(p => ({ ...p, facts: modelFacts(p.facts) })) }),
  ].join('\n')
  return runStructuredTask(prompt, modelDraftSchema, {
    signal, repair: true, validate,
    request: request ?? (process.env.AI_PROVIDER === 'fake' ? async () => fakeDraft(input) : undefined),
  })
}
