import type Database from 'better-sqlite3'
import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from '@/domain/tailoring'
import { parseSkills, parseTags } from '@/server/ids'

// Used inside the migration/import transaction, before callers can mutate source records.
export function snapshotLegacy(database: Database.Database, resumeId: string): ResumeDocumentV1 {
  const resume = database.prepare('SELECT * FROM resumes WHERE id = ?').get(resumeId) as Record<string, any>
  const p = database.prepare('SELECT * FROM profile WHERE id = 1').get() as Record<string, any> | undefined
  const j = resume.job_id ? database.prepare('SELECT * FROM job_targets WHERE id = ?').get(resume.job_id) as Record<string, any> | undefined : undefined
  const rows = database.prepare(`SELECT p.*, i.included, i.bullet_override, i.sort_order FROM projects p LEFT JOIN resume_items i ON i.project_id = p.id AND i.resume_id = ?`).all(resumeId) as Record<string, any>[]
  const legacy = [{ kind: 'legacy', factId: null, materialId: null, sourceText: '', status: 'unmapped' }]
  return ResumeDocumentV1Schema.parse({ version: 1, pageTarget: 1, summary: resume.summary,
    profile: p ? { name: p.name, headline: p.headline, years: p.years, location: p.location, phone: p.phone, email: p.email, links: p.links, education: p.education, skills: parseSkills(p.skills_json), workExperience: p.work_experience, photo: p.photo } : null,
    job: j ? { company: j.company, role: j.role, matchScore: j.match_score, city: j.city, salary: j.salary, department: j.department, jdText: j.jd_text } : null,
    projects: rows.map(x => { const override = x.bullet_override ?? ''; const bullet = override.trim() ? override : x.resume_bullet; return { projectId: x.id, title: x.title, status: x.status, tags: parseTags(x.tags_json), org: x.org, periodStart: x.period_start, periodEnd: x.period_end, included: Boolean(x.included), bulletOverride: override, bullet, sourceBullet: x.resume_bullet, sortOrder: x.sort_order ?? 0, todoCount: x.todos.split('\n').map((s: string) => s.trim()).filter(Boolean).length, provenance: legacy, bullets: [{ text: bullet, provenance: legacy }] } }).sort((a, b) => Number(b.included) - Number(a.included) || b.sortOrder - a.sortOrder),
  })
}
export function snapshotMissingLegacy(database: Database.Database): void {
  const rows = database.prepare("SELECT id FROM resumes WHERE type = 'targeted' AND current_revision_id IS NULL").all() as { id: string }[]
  const insert = database.prepare("INSERT INTO resume_revisions (id, resume_id, revision, kind, document_json, created_at) VALUES (?, ?, 1, 'working', ?, ?)")
  const update = database.prepare('UPDATE resumes SET current_revision_id = ? WHERE id = ?')
  for (const row of rows) { const id = crypto.randomUUID(); insert.run(id, row.id, JSON.stringify(snapshotLegacy(database, row.id)), new Date().toISOString()); update.run(id, row.id) }
}
