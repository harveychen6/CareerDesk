import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { resetDbForTests } from '@/server/db'
import { createProject, updateProject, deleteProject } from '@/server/projects'
import { createJob } from '@/server/jobs'
import { generateTargetedResume, getResume, renderMarkdown, updateResume } from '@/server/resumes'
import { submitResume, getResumeRevision } from '@/server/resume-revisions'

beforeEach(() => {
  resetDbForTests()
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'careerdesk-revision-'))
  process.env.AI_PROVIDER = 'fake'
})

it('freezes targeted content and submitted revisions across source changes', async () => {
  const p = createProject('原始项目')
  await updateProject(p.id, { resumeBullet: '原始句子', status: 'done' })
  const job = await createJob({ company: '公司', role: '工程师', jdText: '工程' })
  const id = generateTargetedResume(job!.id)!
  const initial = getResume(id)!
  expect(initial.revision).toBe(1)
  const updated = updateResume(id, { expectedRevision: initial.revision!, includedProjectIds: [p.id], overrides: [{ projectId: p.id, bulletOverride: '定制句子' }] })!
  const submitted = submitResume(id, updated.revision!)!

  await updateProject(p.id, { title: '已更改', resumeBullet: '新句子' })
  deleteProject(p.id)
  expect(getResume(id)!.projects.find(x => x.projectId === p.id)?.title).toBe('原始项目')
  expect(getResumeRevision(id, submitted.revision)?.document.projects.find(x => x.projectId === p.id)?.bullet).toBe('定制句子')
  expect(() => updateResume(id, { expectedRevision: initial.revision!, summary: '过期' })).toThrow(/修订/)
})

it('exports the frozen summary and project stages without relying on project periods', async () => {
  const active = createProject('进行项目')
  const planned = createProject('计划项目')
  await updateProject(active.id, { status: 'active', resumeBullet: '已完成子项' })
  const job = await createJob({ company: '公司', role: '工程师', jdText: '工程' })
  const id = generateTargetedResume(job!.id)!
  const draft = updateResume(id, { expectedRevision: 1, summary: '原始简介', includedProjectIds: [active.id, planned.id] })!
  const submitted = submitResume(id, draft.revision!)!
  updateResume(id, { expectedRevision: draft.revision!, summary: '后续简介' })
  await updateProject(active.id, { status: 'done' })

  const markdown = renderMarkdown(id, submitted.revision)
  expect(markdown).toContain('## 个人简介\n原始简介')
  expect(markdown).toContain('### 进行项目 · 进行中')
  expect(markdown).toContain('### 计划项目 · 尚未执行')
  expect(markdown).toContain('已完成子项')
  expect(markdown).not.toContain('后续简介')
})

it('keeps available live projects outside the frozen draft until explicitly added and preserves cleared text', async () => {
  const frozen = createProject('旧项目')
  await updateProject(frozen.id, { resumeBullet: '旧描述' })
  const job = await createJob({ company: '公司', role: '工程师', jdText: '工程' })
  const id = generateTargetedResume(job!.id)!
  const later = createProject('后来加入')
  await updateProject(later.id, { resumeBullet: '新项目描述' })
  await updateProject(frozen.id, { resumeBullet: '变更后的母版描述' })

  const detail = getResume(id)!
  expect(detail.availableProjects).toMatchObject([{ projectId: later.id, title: later.title }])
  expect(detail.projects.find(project => project.projectId === later.id)).toBeUndefined()
  const selected = updateResume(id, { expectedRevision: detail.revision!, includedProjectIds: [frozen.id, later.id] })!
  expect(selected.projects.filter(project => project.included).map(project => project.bullet)).toEqual(['旧描述', '新项目描述'])
  const cleared = updateResume(id, { expectedRevision: selected.revision!, overrides: [{ projectId: frozen.id, bulletOverride: ' \n ' }] })!
  const first = cleared.projects.find(project => project.projectId === frozen.id)!
  expect(first.bullet).toBe('')
  expect(first.bullets).toEqual([])
  expect(first.provenance).toEqual([])
  expect(renderMarkdown(id)).not.toContain('旧描述')
  expect(getResumeRevision(id, detail.revision!)?.document.projects.some(project => project.projectId === later.id)).toBe(false)
})
