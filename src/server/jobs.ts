import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { matchJob } from '@/domain/score'
import { MAX_JD_LENGTH } from '@/domain/source-limits'
import { aiConfigured, getAiClient } from '@/server/ai/client'
import { getDb } from '@/server/db'
import { jobKeywords, jobMatches, jobTargets, projects, resumes } from '@/server/db/schema'
import { newId, nowIso, parseTags } from '@/server/ids'
import { RequestError } from '@/server/request-error'
import type { ProjectStatus } from '@/domain/score'

export async function listJobs() {
  const db = getDb()
  const jobs = db.select().from(jobTargets).all()
  const resumeJobIds = new Set(
    db.select().from(resumes).all().map((item) => item.jobId).filter((id): id is string => Boolean(id)),
  )
  return jobs
    .map((job) => ({
      id: job.id,
      company: job.company,
      role: job.role,
      city: job.city,
      salary: job.salary,
      department: job.department,
      matchScore: job.matchScore,
      updatedAt: job.updatedAt,
      hasResume: resumeJobIds.has(job.id),
    }))
    .reverse()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function getJob(id: string) {
  const db = getDb()
  const job = db.select().from(jobTargets).where(eq(jobTargets.id, id)).get()
  if (!job) return null
  const keywords = db.select().from(jobKeywords).where(eq(jobKeywords.jobId, id)).all()
  const matches = db.select().from(jobMatches).where(eq(jobMatches.jobId, id)).all()
    .sort((a, b) => a.rank - b.rank)
  const projectRows = db.select().from(projects).all()
  const byId = new Map(projectRows.map((row) => [row.id, row]))
  const resume = db.select().from(resumes).all().find((item) => item.jobId === id) ?? null
  return {
    id: job.id,
    company: job.company,
    role: job.role,
    city: job.city,
    salary: job.salary,
    department: job.department,
    jdText: job.jdText,
    matchScore: job.matchScore,
    updatedAt: job.updatedAt,
    resumeId: resume?.id ?? null,
    aiAvailable: aiConfigured(),
    keywords: keywords.map((item) => ({ text: item.text, evidence: item.evidenceStatus })),
    matches: matches.map((item) => {
      const project = byId.get(item.projectId)
      return {
        projectId: item.projectId,
        title: project?.title ?? '',
        status: (project?.status ?? 'planned') as ProjectStatus,
        relevance: item.relevance,
        reason: item.reason,
        todoCount: (project?.todos ?? '').split('\n').map((line) => line.trim()).filter(Boolean).length,
      }
    }),
  }
}

function checkJdLength(jdText: string | undefined) {
  if (jdText && jdText.length > MAX_JD_LENGTH) {
    throw new RequestError('input_too_large', 413, `岗位描述超过 ${MAX_JD_LENGTH} 个字符，请缩小范围后保存`)
  }
}

export async function createJob(input: {
  company: string
  role: string
  city?: string
  salary?: string
  department?: string
  jdText: string
}) {
  checkJdLength(input.jdText)
  const timestamp = nowIso()
  const id = newId()
  getDb().insert(jobTargets).values({
    id,
    company: input.company.trim() || '未命名公司',
    role: input.role.trim() || '未命名岗位',
    city: input.city?.trim() ?? '',
    salary: input.salary?.trim() ?? '',
    department: input.department?.trim() ?? '',
    jdText: input.jdText,
    matchScore: 0,
    updatedAt: timestamp,
  }).run()
  return getJob(id)
}

const jobPatchSchema = z.object({
  company: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1).optional(),
  city: z.string().trim().optional(),
  salary: z.string().trim().optional(),
  department: z.string().trim().optional(),
  jdText: z.string().optional(),
}).strict().refine(patch => Object.keys(patch).length > 0)

export function updateJob(id: string, input: z.input<typeof jobPatchSchema>) {
  const patch = jobPatchSchema.parse(input)
  checkJdLength(patch.jdText)
  const result = getDb().update(jobTargets).set({ ...patch, updatedAt: nowIso() }).where(eq(jobTargets.id, id)).run()
  return result.changes ? getJob(id) : null
}

export async function analyzeJob(id: string) {
  const db = getDb()
  const job = db.select().from(jobTargets).where(eq(jobTargets.id, id)).get()
  if (!job) return null
  const client = getAiClient()
  if (!client) return { ...(await getJob(id)), aiAvailable: false }
  const keywords = (await client.extractKeywords(job.jdText)).slice(0, 5)
  const projectRows = db.select().from(projects).all()
  const scored = matchJob(keywords, projectRows.map((project) => ({
    id: project.id,
    status: project.status as ProjectStatus,
    tags: parseTags(project.tagsJson),
    facts: project.factsMarkdown,
    bullet: project.resumeBullet,
  })))
  const reasonTargets = scored.matches.map((match) => {
    const project = projectRows.find((item) => item.id === match.projectId)
    return { projectId: match.projectId, title: project?.title ?? '', facts: project?.factsMarkdown ?? '' }
  })
  const reasons = reasonTargets.length > 0 ? await client.writeReasons(keywords, reasonTargets) : []
  db.delete(jobKeywords).where(eq(jobKeywords.jobId, id)).run()
  db.delete(jobMatches).where(eq(jobMatches.jobId, id)).run()
  for (const keyword of scored.keywords) {
    db.insert(jobKeywords).values({
      id: newId(),
      jobId: id,
      text: keyword.text,
      evidenceStatus: keyword.evidence,
    }).run()
  }
  scored.matches.forEach((match, index) => {
    const reason = reasons.find((item) => item.projectId === match.projectId)?.reason ?? ''
    const facts = reasonTargets.find((item) => item.projectId === match.projectId)?.facts ?? ''
    db.insert(jobMatches).values({
      id: newId(),
      jobId: id,
      projectId: match.projectId,
      relevance: match.relevance,
      reason: quoteReason(reason, facts),
      rank: index + 1,
    }).run()
  })
  db.update(jobTargets).set({ matchScore: scored.score, updatedAt: nowIso() }).where(eq(jobTargets.id, id)).run()
  return getJob(id)
}

function quoteReason(reason: string, facts: string): string {
  const snippet = facts.replace(/\s+/g, ' ').trim().slice(0, 40)
  if (!snippet) return reason
  if (reason.includes(snippet.slice(0, 12))) return reason
  return `事实原文：「${snippet}」`
}
