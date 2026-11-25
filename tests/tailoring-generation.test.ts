import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runStructuredTask } from '@/server/ai/structured'
import { exportBackup, importBackup } from '@/server/backup'
import { resetDbForTests } from '@/server/db'
import { createJob, updateJob } from '@/server/jobs'
import { createMaterial, extractMaterial, updateMaterialFacts } from '@/server/materials'
import { deleteProject } from '@/server/projects'
import { generateTargetedResume, getResume, renderMarkdown, updateResume } from '@/server/resumes'
import { submitResume } from '@/server/resume-revisions'
import * as service from '@/server/tailoring'
import { z } from 'zod'

let directory: string
beforeEach(() => {
  resetDbForTests()
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tailoring-'))
  process.env.DATA_DIR = directory
  process.env.AI_PROVIDER = 'fake'
})
afterEach(() => {
  resetDbForTests()
  fs.rmSync(directory, { recursive: true, force: true })
})

async function fact(text: string, stage: 'done' | 'candidate' = 'done', projectId?: string) {
  const source = createMaterial(projectId
    ? { content: text, projectId }
    : { content: text, createProject: true, title: '测试项目', stage: 'active' })
  const { facts: [entry] } = await extractMaterial(source.id)
  if (stage === 'done') updateMaterialFacts(source.id, entry.revision, [{ id: entry.id, status: 'confirmed', stage }])
  return { ...entry, projectId: source.projectId!, materialId: source.id }
}

const req = (text: string, kind = 'must', segmentId = '0', alternatives: string[] = []) =>
  ({ text, kind, segmentId, alternatives })
const assessment = (factIds: string[], state = 'direct') => ({ factIds, state, reason: '引用相关经历' })
const analysisResult = (requirements: unknown[], assessments: unknown[]) => ({
  requirements, assessments: assessments.map((item, requirementIndex) => ({ ...(item as object), requirementIndex })), questions: [],
})
const draftInput = (analysis: { id: string; inputHash: string }, expectedRevision = 0, pageTarget: 1 | 2 = 1) =>
  ({ analysisId: analysis.id, expectedInputHash: analysis.inputHash, expectedRevision, pageTarget })

it('保存岗位不运行旧分析，保留完整 JD', async () => {
  const saved = await createJob({ company: '公司', role: '工程师', jdText: '精通 Go 和 Kubernetes' })
  expect(saved).toMatchObject({ jdText: '精通 Go 和 Kubernetes', keywords: [], matches: [], matchScore: 0 })
})

it('对照职责、独立条件和 OR 分支，补充缺失证据与用户明确确认的区别', async () => {
  const { id: factId } = await fact('负责 Go 接口开发')
  const jdText = '😀负责接口开发\n掌握 Go 或 Rust，且熟悉发布流程'
  const job = (await createJob({ company: '公司', role: '工程师', jdText }))!
  const options = analysisResult([
    req('负责接口开发', 'responsibility'),
    req('掌握 Go 或 Rust', 'must', '1', ['Go', 'Rust']),
    req('熟悉发布流程', 'must', '1'),
  ], [assessment([factId]), assessment([factId], 'transferable'), assessment([], 'not_shown')])
  const first = await service.analyzeJobRequirements(job.id, { factIds: [factId] }, undefined, async () => options)
  expect(first.requirements.map(r => [r.text, jdText.slice(r.jdRef.start, r.jdRef.end), r.alternatives])).toEqual([
    ['负责接口开发', '😀负责接口开发', []],
    ['掌握 Go 或 Rust', '掌握 Go 或 Rust，且熟悉发布流程', ['Go', 'Rust']],
    ['熟悉发布流程', '掌握 Go 或 Rust，且熟悉发布流程', []],
  ])
  expect(first.assessments.map(r => r.state)).toEqual(['direct', 'transferable', 'not_shown'])
  await expect(service.analyzeJobRequirements(job.id, { factIds: [factId], absentRequirementIds: ['invented'] }, undefined, async () => options)).rejects.toThrow()
  const second = await service.analyzeJobRequirements(job.id, { factIds: [factId], absentRequirementIds: [first.requirements[2].id] }, undefined, async () => options)
  expect(second.assessments[2]).toMatchObject({ state: 'confirmed_absent', factIds: [] })
  expect(service.getJobTailoring(job.id)?.analysis?.id).toBe(second.id)
})

it('拒绝候选、孤立项目事实及模型自判没有做过', async () => {
  const candidate = await fact('候选', 'candidate')
  const orphan = await fact('确认事实')
  deleteProject(orphan.projectId)
  const job = (await createJob({ company: '公司', role: '工程师', jdText: '熟悉 Go' }))!
  const unreachable = async () => { throw new Error('不应调用模型') }
  await expect(service.analyzeJobRequirements(job.id, { factIds: [candidate.id] }, undefined, unreachable)).rejects.not.toThrow('不应调用模型')
  await expect(service.analyzeJobRequirements(job.id, { factIds: [orphan.id] }, undefined, unreachable)).rejects.not.toThrow('不应调用模型')
  await expect(service.analyzeJobRequirements(job.id, { factIds: [] }, undefined, async () => analysisResult([req('熟悉 Go')], [assessment([], 'confirmed_absent')]))).rejects.toThrow()
  expect(service.getJobTailoring(job.id)?.analysis).toBeNull()
})

it('只复用有效分析，拒绝并发 JD 或事实变化，不保存陈旧结果', async () => {
  const entry = await fact('负责缓存压测')
  const job = (await createJob({ company: '公司', role: '工程师', jdText: '负责缓存压测' }))!
  const output = analysisResult([req('负责缓存压测')], [assessment([entry.id])])
  const selection = { factIds: [entry.id] }
  const started = await service.analyzeJobRequirements(job.id, selection, undefined, async () => output)
  const cached = await service.analyzeJobRequirements(job.id, selection, undefined, async () => { throw new Error('unexpected repeat') })
  expect(cached.id).toBe(started.id)
  await updateJob(job.id, { jdText: '负责缓存设计' })
  expect(service.getJobTailoring(job.id)?.analysis?.stale).toBe(true)
  await expect(service.analyzeJobRequirements(job.id, selection, undefined, async () => {
    updateMaterialFacts(entry.materialId, 2, [{ id: entry.id, status: 'rejected' }])
    return output
  })).rejects.toMatchObject({ status: 409 })
  expect(service.getJobTailoring(job.id)?.analysis?.id).toBe(started.id)
})

it('只有当前激活的分析能生成及接受提案，重新选择缓存分析才恢复其提案', async () => {
  const entry = await fact('完成接口开发')
  const job = (await createJob({ company: '公司', role: '研发', jdText: '接口开发' }))!
  const a = await service.analyzeJobRequirements(job.id, { factIds: [entry.id] })
  const draft = await service.generateTargetedDraft(job.id, draftInput(a))
  const b = await service.analyzeJobRequirements(job.id, { factIds: [] })
  expect(service.getJobTailoring(job.id)).toMatchObject({ analysis: { id: b.id }, proposal: null })
  await expect(service.generateTargetedDraft(job.id, draftInput(a, draft.baseRevision))).rejects.toMatchObject({ status: 409 })
  expect(() => service.applyTailoringProposal(draft.resumeId, draft.id, {
    expectedRevision: draft.baseRevision, decisions: [{ bulletId: draft.bullets[0].id, action: 'accept' }],
  })).toThrow(expect.objectContaining({ status: 409 }))
  const active = await service.analyzeJobRequirements(job.id, { factIds: [entry.id] }, undefined, async () => { throw new Error('不重复调用') })
  expect(active.id).toBe(a.id)
  expect(service.getJobTailoring(job.id)).toMatchObject({ analysis: { id: a.id }, proposal: { id: draft.id, stale: false } })
  const pending = service.generateTargetedDraft(job.id, draftInput(a, draft.baseRevision, 2), undefined, async () => {
    await service.analyzeJobRequirements(job.id, { factIds: [] })
    return { bullets: [] }
  })
  await expect(pending).rejects.toMatchObject({ status: 409 })
  expect(service.getJobTailoring(job.id)).toMatchObject({ analysis: { id: b.id }, proposal: null })
})

it('接受建议后的新修订重新生成，刷新仍能恢复此前提案的剩余建议', async () => {
  const first = await fact('完成接口开发')
  const second = await fact('完成接口监控', 'done', first.projectId)
  const job = (await createJob({ company: '公司', role: '研发', jdText: '接口' }))!
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [first.id, second.id] })
  const proposal = await service.generateTargetedDraft(job.id, draftInput(analysis))
  const [accepted, pending] = proposal.bullets
  const updated = service.applyTailoringProposal(proposal.resumeId, proposal.id, {
    expectedRevision: proposal.baseRevision, decisions: [{ bulletId: accepted.id, action: 'accept' }],
  })
  expect(service.getJobTailoring(job.id)?.proposal).toMatchObject({ id: proposal.id, bullets: [
    { id: accepted.id, status: 'accepted' }, { id: pending.id, status: 'pending' },
  ] })
  const generated = await service.generateTargetedDraft(job.id, draftInput(analysis, updated.proposal.baseRevision))
  expect(generated.id).not.toBe(proposal.id)
  expect(generated.inputHash).not.toBe(proposal.inputHash)
  expect(generated.bullets).toMatchObject([{ text: pending.text, status: 'pending' }])
})

it('手改后保留未改句子的证据并且不会给复制的行重复绑定同一来源', async () => {
  const first = await fact('完成接口开发')
  const second = await fact('完成接口监控', 'done', first.projectId)
  const job = (await createJob({ company: '公司', role: '研发', jdText: '接口' }))!
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [first.id, second.id] })
  const proposal = await service.generateTargetedDraft(job.id, draftInput(analysis))
  const { resume } = service.applyTailoringProposal(proposal.resumeId, proposal.id, {
    expectedRevision: proposal.baseRevision,
    decisions: proposal.bullets.map(bullet => ({ bulletId: bullet.id, action: 'accept' as const })),
  })
  const [original, unchanged] = proposal.bullets
  const revisedText = `${original.text}，补充范围\n${unchanged.text}\n${unchanged.text}`
  const edited = updateResume(proposal.resumeId, {
    expectedRevision: resume!.revision!,
    overrides: [{ projectId: first.projectId, bulletOverride: revisedText }],
  })!
  const submitted = submitResume(proposal.resumeId, edited.revision!)!
  const frozen = submitted.document.projects.find(project => project.projectId === first.projectId)!
  expect(frozen.bullets.map(line => [line.text, line.provenance.map(source => [source.kind, source.factId])])).toEqual([
    [`${original.text}，补充范围`, [['user', null]]],
    [unchanged.text, [['evidence', unchanged.factIds[0]]]],
    [unchanged.text, [['user', null]]],
  ])
  expect(frozen.provenance.flatMap(source => source.factId ? [source.factId] : [])).toEqual(unchanged.factIds)
  expect(renderMarkdown(proposal.resumeId, submitted.revision)).toContain(revisedText)
})

it('同一事实池按不同 JD 选择重点，离线候选保留确切出处', async () => {
  const performance = await fact('完成缓存性能压测')
  const delivery = await fact('完成灰度发布流程改造')
  const cache = (await createJob({ company: '公司', role: '性能', jdText: '职责：缓存性能压测' }))!
  const release = (await createJob({ company: '公司', role: '交付', jdText: '职责：灰度发布流程改造' }))!
  const input = { factIds: [performance.id, delivery.id] }
  const a = await service.analyzeJobRequirements(cache.id, input)
  const b = await service.analyzeJobRequirements(release.id, input)
  const p = await service.generateTargetedDraft(cache.id, draftInput(a))
  const q = await service.generateTargetedDraft(release.id, draftInput(b))
  expect(p).toMatchObject({ provider: 'fake', projectOrder: [performance.projectId], stale: false })
  expect(q.projectOrder).toEqual([delivery.projectId])
  expect(p.bullets[0].sources).toMatchObject([{ factId: performance.id, sourceText: '完成缓存性能压测' }])
  expect(getResume(p.resumeId)?.projects.filter(x => x.included)).toEqual([])
  expect(service.getJobTailoring(cache.id)?.proposal?.id).toBe(p.id)
  const repeat = await service.generateTargetedDraft(cache.id, draftInput(a, p.baseRevision), undefined, async () => { throw new Error('unexpected repeat') })
  expect(repeat.id).toBe(p.id)
  const differentPage = await service.generateTargetedDraft(cache.id, draftInput(a, p.baseRevision, 2))
  expect(differentPage.inputHash).not.toBe(p.inputHash)
})

it('只接受选中的句子，保留手改和既有接受结果，拒绝串岗、重放冲突和外部编辑', async () => {
  const a = await fact('完成缓存压测')
  const b = await fact('完成缓存监控', 'done', a.projectId)
  const job = (await createJob({ company: '公司', role: '工程师', jdText: '职责：缓存' }))!
  const other = (await createJob({ company: '别家', role: '工程师', jdText: '职责：缓存' }))!
  const otherResume = generateTargetedResume(other.id)!
  const resumeId = generateTargetedResume(job.id)!
  updateResume(resumeId, { summary: '手改摘要', overrides: [{ projectId: a.projectId, bulletOverride: '手改内容' }] })
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [a.id, b.id] })
  const proposal = await service.generateTargetedDraft(job.id, draftInput(analysis, 2))
  const [first, second] = proposal.bullets
  const firstDecision = { expectedRevision: proposal.baseRevision, decisions: [{ bulletId: first.id, action: 'accept' as const }] }
  expect(() => service.applyTailoringProposal(otherResume, proposal.id, firstDecision)).toThrow()
  const accepted = service.applyTailoringProposal(resumeId, proposal.id, firstDecision)
  expect(accepted.resume?.summary).toBe('手改摘要')
  expect(accepted.resume?.projects.find(p => p.projectId === a.projectId)?.bullet).toBe(`手改内容\n${first.text}`)
  expect(service.applyTailoringProposal(resumeId, proposal.id, firstDecision).resume?.revision).toBe(accepted.resume?.revision)
  expect(() => service.applyTailoringProposal(resumeId, proposal.id, { ...firstDecision, decisions: [{ bulletId: first.id, action: 'reject' }] })).toThrow()
  const both = service.applyTailoringProposal(resumeId, proposal.id, { expectedRevision: accepted.proposal.baseRevision, decisions: [{ bulletId: second.id, action: 'accept' }] })
  expect(both.resume?.projects.find(p => p.projectId === a.projectId)?.bullet).toBe(`手改内容\n${first.text}\n${second.text}`)
  updateResume(resumeId, { summary: '外部编辑' })
  expect(service.getJobTailoring(job.id)?.proposal?.stale).toBe(true)
  expect(() => service.applyTailoringProposal(resumeId, proposal.id, firstDecision)).toThrow()
})

it('不让无证据岗位凑出项目或候选成果', async () => {
  const entry = await fact('负责用户访谈')
  const job = (await createJob({ company: '公司', role: '研发', jdText: '熟悉 Kubernetes' }))!
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [entry.id] })
  const draft = await service.generateTargetedDraft(job.id, draftInput(analysis), undefined, async () => { throw new Error('无需调用模型') })
  expect(draft.bullets).toEqual([])
  expect(draft.projectOrder).toEqual([])
  expect(draft.insufficiency).toBeTruthy()
})

it('使用冻结原句 ID 逐条替换，并让已接受项目采用推荐顺序', async () => {
  const strong = await fact('完成缓存性能压测')
  const weak = await fact('完成发布监控')
  const job = (await createJob({ company: '公司', role: '工程', jdText: '缓存压测\n发布监控优先' }))!
  const resumeId = generateTargetedResume(job.id)!
  const selection = [weak.projectId, strong.projectId]
  const selected = updateResume(resumeId, {
    includedProjectIds: selection,
    overrides: [{ projectId: strong.projectId, bulletOverride: '旧压测句\n保留手改句' }],
  })!
  expect(selected.projects.filter(p => p.included).map(p => p.projectId)).toEqual(selection)
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [strong.id, weak.id] }, undefined, async () => analysisResult(
    [req('缓存压测'), req('发布监控', 'preferred', '1')], [assessment([strong.id]), assessment([weak.id])],
  ))
  const draft = await service.generateTargetedDraft(job.id, draftInput(analysis, 2), undefined, async prompt => {
    const data = JSON.parse(prompt.split('\n').at(-1)!)
    expect(data.jd.map((s: { text: string }) => s.text)).toEqual(['缓存压测', '发布监控优先'])
    expect(data.projects[0].originals).toEqual([{ id: '0', text: '旧压测句' }, { id: '1', text: '保留手改句' }])
    return { bullets: [
      { projectId: strong.projectId, factIds: [strong.id], text: '完成缓存性能压测', requirementIds: [analysis.requirements[0].id], replaceId: '0', reason: '强调压测' },
      { projectId: weak.projectId, factIds: [weak.id], text: '完成发布监控', requirementIds: [analysis.requirements[1].id], reason: '补充发布' },
    ] }
  })
  expect(draft.bullets[0].originalText).toBe('旧压测句')
  const updated = service.applyTailoringProposal(resumeId, draft.id, {
    expectedRevision: 2, decisions: draft.bullets.map(b => ({ bulletId: b.id, action: 'accept' as const })),
  })
  expect(updated.resume?.projects.filter(p => p.included).map(p => p.projectId)).toEqual([strong.projectId, weak.projectId])
  expect(updated.resume?.projects.find(p => p.projectId === strong.projectId)?.bullet).toBe('完成缓存性能压测\n保留手改句')
})

it('备份往返保留已处理建议并在导入前拒绝损坏的分析或提案', async () => {
  const entry = await fact('完成接口开发')
  const job = (await createJob({ company: '公司', role: '研发', jdText: '接口开发' }))!
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [entry.id] })
  const draft = await service.generateTargetedDraft(job.id, draftInput(analysis))
  service.applyTailoringProposal(draft.resumeId, draft.id, {
    expectedRevision: draft.baseRevision, decisions: [{ bulletId: draft.bullets[0].id, action: 'accept' }],
  })
  const backup = exportBackup()
  const bad = structuredClone(backup)
  bad.jobAnalyses[0].payloadJson = '{}'
  expect(() => importBackup(bad, true)).toThrow()
  const badProposal = structuredClone(backup)
  badProposal.tailoringProposals[0].payloadJson = '{}'
  expect(() => importBackup(badProposal, true)).toThrow()
  importBackup(backup, true)
  expect(service.getJobTailoring(job.id)?.proposal?.bullets[0].status).toBe('accepted')
})

it('导入时验证冻结要求、来源凭据和 hash，允许原事实已被撤销的历史备份', async () => {
  const entry = await fact('完成接口开发')
  const job = (await createJob({ company: '公司', role: '研发', jdText: '接口开发' }))!
  const other = (await createJob({ company: '公司', role: '另一岗位', jdText: '接口开发' }))!
  const analysis = await service.analyzeJobRequirements(job.id, { factIds: [entry.id] })
  const draft = await service.generateTargetedDraft(job.id, draftInput(analysis))
  updateMaterialFacts(entry.materialId, 2, [{ id: entry.id, status: 'rejected' }])
  const backup = exportBackup()
  for (const corrupt of [
    (copy: typeof backup) => {
      const payload = JSON.parse(copy.jobAnalyses[0].payloadJson)
      payload.assessments[0].requirementId = '不存在的要求'
      copy.jobAnalyses[0].payloadJson = JSON.stringify(payload)
    },
    (copy: typeof backup) => {
      const payload = JSON.parse(copy.tailoringProposals[0].payloadJson)
      payload.bullets[0].sources[0].sourceText = '篡改的原文'
      copy.tailoringProposals[0].payloadJson = JSON.stringify(payload)
    },
    (copy: typeof backup) => { copy.tailoringProposals[0].inputHash = '0'.repeat(64) },
    (copy: typeof backup) => {
      copy.tailoringProposals = []
      copy.jobAnalyses[0].jobId = other.id
    },
  ]) {
    const copy = structuredClone(backup)
    corrupt(copy)
    expect(() => importBackup(copy, true)).toThrow()
  }
  importBackup(backup, true)
  expect(service.getJobTailoring(job.id)?.proposal).toMatchObject({ id: draft.id, stale: true })
})

it('阶段最多修复一次结构错误，鉴权失败不会重试，超时和取消会终止等待', async () => {
  const schema = z.object({ ok: z.literal(true) }).strict()
  let requests = 0
  const success = await runStructuredTask('test', schema, {
    repair: true, request: async () => ++requests === 1 ? { invalid: true } : { ok: true },
  })
  expect(success).toEqual({ ok: true })
  expect(requests).toBe(2)
  await expect(runStructuredTask('test', schema, {
    repair: true, request: async () => { requests++; throw new Error('private provider response') },
  })).rejects.toMatchObject({ status: 503 })
  expect(requests).toBe(3)
  await expect(runStructuredTask('test', schema, {timeoutMs: 10, request: () => new Promise(() => {})})).rejects.toMatchObject({ status: 504 })
  const controller = new AbortController()
  const pending = runStructuredTask('test', schema, { signal: controller.signal, request: () => new Promise(() => {}) })
  controller.abort()
  await expect(pending).rejects.toMatchObject({ status: 499 })
})
