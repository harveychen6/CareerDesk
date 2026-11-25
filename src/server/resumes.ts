import { eq } from 'drizzle-orm'
import { copy, tailoringCopy } from '@/content/zh-CN'
import { currentResumeRevision, ensureResumeSnapshots, getResumeRevision, writeResumeRevision } from '@/server/resume-revisions'
import { getSqlite } from '@/server/db'
import type { ResumeDocumentV1, ResumeProfile } from '@/domain/tailoring'
import { snapshotLegacy } from '@/server/db/legacy-snapshot'
import { paperBullet } from '@/domain/resume'
import { resumeBulletLines } from '@/domain/resume-line'
import type { ProjectStatus } from '@/domain/score'
import { getDb } from '@/server/db'
import { jobMatches, jobTargets, profile, projects, resumeItems, resumes } from '@/server/db/schema'
import { newId, nowIso, parseSkills, parseTags } from '@/server/ids'

export function listResumes() {
  const db = getDb()
  const jobs = db.select().from(jobTargets).all()
  const byJob = new Map(jobs.map((job) => [job.id, job]))
  return db.select().from(resumes).all()
    .map((resume) => {
      const job = resume.jobId ? byJob.get(resume.jobId) : undefined
      return {
        id: resume.id,
        type: resume.type as 'master' | 'targeted',
        jobId: resume.jobId,
        title: resume.type === 'master' ? '经历母版' : `${job?.company ?? ''} · ${job?.role ?? ''}`,
        matchScore: job?.matchScore ?? null,
        updatedAt: resume.updatedAt,
      }
    })
    .sort((a, b) => (a.type === 'master' ? -1 : b.type === 'master' ? 1 : b.updatedAt.localeCompare(a.updatedAt)))
}

export function getResume(id: string, revision?: number) {
  const db = getDb()
  const resume = db.select().from(resumes).where(eq(resumes.id, id)).get()
  if (!resume) return null
  if (resume.type === 'targeted') {
    ensureResumeSnapshots()
    const current = revision === undefined ? currentResumeRevision(id) : getResumeRevision(id, revision)
    if (!current) return null
    const frozen = new Set(current.document.projects.map(project => project.projectId))
    const availableProjects = revision === undefined
      ? db.select({ projectId: projects.id, title: projects.title, status: projects.status }).from(projects).all()
        .filter(project => !frozen.has(project.projectId))
      : []
    return { id, type: 'targeted' as const, jobId: resume.jobId, updatedAt: resume.updatedAt, ...current.document, revision: current.revision, availableProjects }
  }
  const items = db.select().from(resumeItems).where(eq(resumeItems.resumeId, id)).all()
  const itemByProject = new Map(items.map((item) => [item.projectId, item]))
  const projectRows = db.select().from(projects).all()
  const person = db.select().from(profile).where(eq(profile.id, 1)).get()
  const job = resume.jobId ? db.select().from(jobTargets).where(eq(jobTargets.id, resume.jobId)).get() : null
  return {
    revision: null as number | null,
    pageTarget: 1 as const,
    id: resume.id,
    type: resume.type as 'master' | 'targeted',
    jobId: resume.jobId,
    summary: resume.type === 'master' ? (person?.summary ?? '') : resume.summary,
    updatedAt: resume.updatedAt,
    availableProjects: [],
    job: job ? { company: job.company, role: job.role, matchScore: job.matchScore } : null,
    profile: person ? {
      name: person.name,
      headline: person.headline,
      years: person.years,
      location: person.location,
      phone: person.phone,
      email: person.email,
      links: person.links,
      education: person.education,
      skills: parseSkills(person.skillsJson),
      workExperience: person.workExperience,
      photo: person.photo,
    } : null,
    projects: projectRows.map((project) => {
      const item = itemByProject.get(project.id)
      const override = item?.bulletOverride ?? ''
      return {
        projectId: project.id,
        title: project.title,
        status: project.status as ProjectStatus,
        tags: parseTags(project.tagsJson),
        org: project.org,
        periodStart: project.periodStart,
        periodEnd: project.periodEnd,
        included: Boolean(item?.included),
        bulletOverride: resume.type === 'master' ? '' : override,
        bullet: paperBullet(project.resumeBullet, resume.type === 'master' ? '' : override),
        sourceBullet: project.resumeBullet,
        sortOrder: item?.sortOrder ?? 0,
        todoCount: project.todos.split('\n').map((line) => line.trim()).filter(Boolean).length,
      }
    }).sort((a, b) => Number(b.included) - Number(a.included) || b.sortOrder - a.sortOrder),
  }
}

function editProjectBullet(project: ResumeDocumentV1['projects'][number], override: string) {
  const existing = new Map<string, (typeof project.provenance)[]>()
  for (const bullet of project.bullets) {
    for (const text of resumeBulletLines(bullet.text)) {
      const matches = existing.get(text) ?? []
      matches.push(bullet.provenance)
      existing.set(text, matches)
    }
  }
  const lines = resumeBulletLines(override)
  project.bullet = lines.join('\n')
  project.bulletOverride = project.bullet
  project.bullets = lines.map(text => ({
    text,
    provenance: existing.get(text)?.shift() ?? [{ kind: 'user', factId: null, materialId: null, sourceText: '', status: 'unmapped' }],
  }))
  project.provenance = project.bullets.flatMap(bullet => bullet.provenance)
}

export function updateResume(id: string, patch: {
  summary?: string
  expectedRevision?: number
  profile?: ResumeProfile
  pageTarget?: 1 | 2
  includedProjectIds?: string[]
  overrides?: { projectId: string; bulletOverride: string }[]
}) {
  const db = getDb()
  const resume = db.select().from(resumes).where(eq(resumes.id, id)).get()
  if (!resume) return null
  if (resume.type === 'targeted') {
    return getSqlite().transaction(() => {
      ensureResumeSnapshots()
      const current = currentResumeRevision(id)!
      const document = structuredClone(current.document)
      const source = snapshotLegacy(getSqlite(), id)
      const ids = new Set(source.projects.map(p => p.projectId))
      const known = new Set(document.projects.map(p => p.projectId))
      if (patch.includedProjectIds && (new Set(patch.includedProjectIds).size !== patch.includedProjectIds.length || patch.includedProjectIds.some(x => !known.has(x) && !ids.has(x)))) throw new Error('项目不存在')
      if (patch.overrides?.some(x => !known.has(x.projectId) && !patch.includedProjectIds?.includes(x.projectId))) throw new Error('项目不属于当前简历')
      if (patch.summary !== undefined) document.summary = patch.summary
      if (patch.profile !== undefined) document.profile = patch.profile
      if (patch.pageTarget !== undefined) document.pageTarget = patch.pageTarget
      if (patch.includedProjectIds) {
        for (const projectId of patch.includedProjectIds) if (!known.has(projectId)) document.projects.push(source.projects.find(p => p.projectId === projectId)!)
        document.projects.forEach(p => { const index = patch.includedProjectIds!.indexOf(p.projectId); p.included = index >= 0; if (index >= 0) p.sortOrder = patch.includedProjectIds!.length - index })
        document.projects.sort((a, b) => Number(b.included) - Number(a.included) || b.sortOrder - a.sortOrder)
      }
      for (const item of patch.overrides ?? []) {
        const project = document.projects.find(project => project.projectId === item.projectId)
        if (!project) throw new Error('项目不属于当前简历')
        editProjectBullet(project, item.bulletOverride)
      }
      writeResumeRevision(id, patch.expectedRevision, document)
      return getResume(id)
    })()
  }
  if (resume.type === 'master' && patch.summary !== undefined) {
    db.update(profile).set({ summary: patch.summary }).where(eq(profile.id, 1)).run()
  }
  if (patch.includedProjectIds) {
    const existing = db.select().from(resumeItems).where(eq(resumeItems.resumeId, id)).all()
    const byProject = new Map(existing.map((item) => [item.projectId, item]))
    patch.includedProjectIds.forEach((projectId, index) => {
      const current = byProject.get(projectId)
      if (current) {
        db.update(resumeItems).set({ included: 1, sortOrder: index }).where(eq(resumeItems.id, current.id)).run()
      } else {
        db.insert(resumeItems).values({
          id: newId(),
          resumeId: id,
          projectId,
          included: 1,
          bulletOverride: '',
          sortOrder: index,
        }).run()
      }
    })
    for (const item of existing) {
      if (!patch.includedProjectIds.includes(item.projectId)) {
        db.update(resumeItems).set({ included: 0 }).where(eq(resumeItems.id, item.id)).run()
      }
    }
  }
  if (patch.overrides && resume.type !== 'master') {
    for (const override of patch.overrides) {
      const current = db.select().from(resumeItems).all().find((item) => item.resumeId === id && item.projectId === override.projectId)
      if (current) {
        db.update(resumeItems).set({ bulletOverride: override.bulletOverride }).where(eq(resumeItems.id, current.id)).run()
      } else {
        db.insert(resumeItems).values({
          id: newId(),
          resumeId: id,
          projectId: override.projectId,
          included: 1,
          bulletOverride: override.bulletOverride,
          sortOrder: 0,
        }).run()
      }
    }
  }
  db.update(resumes).set({ updatedAt: nowIso() }).where(eq(resumes.id, id)).run()
  return getResume(id)
}

export function generateTargetedResume(jobId: string, { useLegacyMatches = true } = {}) {
  const db = getDb()
  const existing = db.select().from(resumes).all().find((item) => item.jobId === jobId)
  if (existing) return existing.id
  const job = db.select().from(jobTargets).where(eq(jobTargets.id, jobId)).get()
  if (!job) return null
  const person = db.select().from(profile).where(eq(profile.id, 1)).get()
  const id = newId()
  db.insert(resumes).values({
    id,
    type: 'targeted',
    jobId,
    summary: person?.summary ?? '',
    updatedAt: nowIso(),
  }).run()
  const matches = useLegacyMatches ? db.select().from(jobMatches).where(eq(jobMatches.jobId, jobId)).all() : []
  const projectRows = db.select().from(projects).all()
  const included = matches
    .map((match) => projectRows.find((project) => project.id === match.projectId))
    .filter((project): project is NonNullable<typeof project> => Boolean(project && project.status !== 'planned'))
  included.forEach((project, index) => {
    db.insert(resumeItems).values({
      id: newId(),
      resumeId: id,
      projectId: project.id,
      included: 1,
      bulletOverride: '',
      sortOrder: index,
    }).run()
  })
  ensureResumeSnapshots()
  return id
}

export function renderMarkdown(id: string, revision?: number): string | null {
  const resume = revision === undefined ? getResume(id) : getResumeRevision(id, revision)?.document
  if (!resume || !resume.profile) return null
  const person = resume.profile
  const lines = [
    `# ${person.name || '未命名'}`,
    [person.headline, person.years].filter(Boolean).join(' · '),
    [person.location, person.phone, person.email, person.links].filter(Boolean).join(' · '),
    '',
    ...(resume.summary.trim() ? [`## ${copy.summary}`, resume.summary, ''] : []),
    '## 工作经历',
    person.workExperience,
    '',
    '## 项目经历',
  ]
  for (const project of resume.projects.filter((item) => item.included)) {
    const period = [project.periodStart, project.periodEnd].filter(Boolean).join(' — ')
    const stage = project.status === 'active' ? tailoringCopy.activeProject : project.status === 'planned' ? tailoringCopy.plannedProject : ''
    const title = [project.title, stage].filter(Boolean).join(' · ')
    lines.push(`### ${title}`, [project.org, period].filter(Boolean).join(' · '), project.bullet, '')
  }
  lines.push('## 专业技能', ...person.skills, '', '## 教育背景', person.education)
  return lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
}
