import fs from 'node:fs'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { getDb, getSqlite } from '@/server/db'
import { jobKeywords, jobMatches, jobTargets, profile, projects, resumeItems, resumes, settings, syncProposals } from '@/server/db/schema'
import { newId, nowIso } from '@/server/ids'
import { validateBackup } from '@/server/backup-validation'
import { snapshotMissingLegacy } from '@/server/db/legacy-snapshot'
import { sourceMaterials, evidenceFacts, jobAnalyses, tailoringProposals, resumeRevisions } from '@/server/db/schema'

export function exportBackup() {
  const db = getDb()
  return {
    version: 2 as const,
    profile: db.select().from(profile).where(eq(profile.id, 1)).get(),
    projects: db.select().from(projects).all(),
    jobs: db.select().from(jobTargets).all(),
    keywords: db.select().from(jobKeywords).all(),
    matches: db.select().from(jobMatches).all(),
    resumes: db.select().from(resumes).all(),
    resumeItems: db.select().from(resumeItems).all(),
    proposals: db.select().from(syncProposals).all(),
    settings: db.select().from(settings).where(eq(settings.id, 1)).get(),
    sourceMaterials: db.select().from(sourceMaterials).all(), evidenceFacts: db.select().from(evidenceFacts).all(), jobAnalyses: db.select().from(jobAnalyses).all(), tailoringProposals: db.select().from(tailoringProposals).all(), resumeRevisions: db.select().from(resumeRevisions).all(),
  }
}

export function importBackup(input: unknown, confirm: boolean) {
  const payload = validateBackup(input)
  const db = getDb()
  const sqlite = getSqlite()
  const currentProfile = db.select().from(profile).where(eq(profile.id, 1)).get()
  const hasProfileContent = currentProfile && (
    [currentProfile.name, currentProfile.headline, currentProfile.years, currentProfile.location,
      currentProfile.phone, currentProfile.email, currentProfile.links, currentProfile.summary,
      currentProfile.education, currentProfile.workExperience, currentProfile.photo].some(value => value.trim() !== '') ||
    currentProfile.skillsJson.trim() !== '[]'
  )
  const currentSettings = db.select().from(settings).where(eq(settings.id, 1)).get()
  const hasSettings = currentSettings && (currentSettings.syncIntervalDays !== 7 || currentSettings.lastMasterSyncAt !== null)
  const tables = ['projects', 'job_targets', 'job_keywords', 'job_matches', 'resume_items', 'sync_proposals',
    'source_materials', 'evidence_facts', 'job_analyses', 'tailoring_proposals', 'resume_revisions']
  const hasRows = tables.some(table => Boolean(sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()))
  const hasResume = Boolean(sqlite.prepare("SELECT 1 FROM resumes WHERE type <> 'master' OR summary <> '' LIMIT 1").get())
  const nonempty = Boolean(hasProfileContent || hasSettings || hasRows || hasResume)
  if (nonempty && !confirm) {
    const error = new Error('库里已有内容，确认后才会覆盖')
    error.name = 'ConfirmRequired'
    throw error
  }
  const run = sqlite.transaction(() => {
    sqlite.exec('DELETE FROM tailoring_proposals; DELETE FROM job_analyses; DELETE FROM evidence_facts; DELETE FROM source_materials; DELETE FROM resume_revisions; DELETE FROM resume_items; DELETE FROM sync_proposals; DELETE FROM job_matches; DELETE FROM job_keywords; DELETE FROM resumes; DELETE FROM job_targets; DELETE FROM projects;')
    if (payload.profile) {
      db.update(profile).set({
        ...payload.profile,
        workExperience: payload.profile.workExperience ?? '',
        photo: payload.profile.photo ?? '',
      }).where(eq(profile.id, 1)).run()
    }
    for (const row of payload.projects ?? []) db.insert(projects).values(row).run()
    for (const row of payload.jobs ?? []) db.insert(jobTargets).values(row).run()
    for (const row of payload.keywords ?? []) db.insert(jobKeywords).values(row).run()
    for (const row of payload.matches ?? []) db.insert(jobMatches).values(row).run()
    for (const row of payload.resumes ?? []) db.insert(resumes).values(payload.version === 1 ? { ...row, currentRevisionId: null } : row).run()
    for (const row of payload.resumeItems ?? []) db.insert(resumeItems).values(row).run()
    for (const row of payload.proposals ?? []) db.insert(syncProposals).values(row).run()
    if (payload.version === 2) {
      for (const row of payload.sourceMaterials) db.insert(sourceMaterials).values(row).run()
      for (const row of payload.evidenceFacts) db.insert(evidenceFacts).values(row).run()
      for (const row of payload.jobAnalyses) db.insert(jobAnalyses).values(row).run()
      for (const row of payload.tailoringProposals) db.insert(tailoringProposals).values(row).run()
      for (const row of payload.resumeRevisions) db.insert(resumeRevisions).values(row).run()
    } else snapshotMissingLegacy(sqlite)
    if (payload.settings) db.update(settings).set(payload.settings).where(eq(settings.id, 1)).run()
  })
  run()
}

export function importDemo(confirm: boolean) {
  const raw = fs.readFileSync(path.join(process.cwd(), 'fixtures/demo.json'), 'utf8')
  const demo = JSON.parse(raw) as {
    profile: { name: string; headline: string; years: string; location: string; phone: string; email: string; links: string; summary: string; education: string; skills: string[] }
    projects: {
      id: string
      title: string
      status: string
      tags: string[]
      factsMarkdown: string
      todos: string
      resumeBullet: string
      org: string
      periodStart: string
      periodEnd: string
    }[]
  }
  const db = getDb()
  const current = db.select().from(profile).where(eq(profile.id, 1)).get()
  const nonempty = db.select().from(projects).all().length > 0 || Boolean(current?.name)
  if (nonempty && !confirm) {
    const error = new Error('库里已有内容，确认后才会导入示例')
    error.name = 'ConfirmRequired'
    throw error
  }
  if (!current?.name) {
    db.update(profile).set({
      name: demo.profile.name,
      headline: demo.profile.headline,
      years: demo.profile.years,
      location: demo.profile.location,
      phone: demo.profile.phone,
      email: demo.profile.email,
      links: demo.profile.links,
      summary: demo.profile.summary,
      education: demo.profile.education,
      skillsJson: JSON.stringify(demo.profile.skills),
    }).where(eq(profile.id, 1)).run()
  }
  const timestamp = nowIso()
  for (const project of demo.projects) {
    const exists = db.select().from(projects).where(eq(projects.id, project.id)).get()
    if (exists) continue
    db.insert(projects).values({
      id: project.id || newId(),
      title: project.title,
      status: project.status,
      summary: '',
      tagsJson: JSON.stringify(project.tags),
      factsMarkdown: project.factsMarkdown,
      todos: project.todos,
      resumeBullet: project.resumeBullet,
      org: project.org,
      periodStart: project.periodStart,
      periodEnd: project.periodEnd,
      factsUpdatedAt: timestamp,
      bulletUpdatedAt: timestamp,
      masterSyncedAt: null,
      updatedAt: timestamp,
    }).run()
  }
}

export function getSettings() {
  const row = getDb().select().from(settings).where(eq(settings.id, 1)).get()
  return { syncIntervalDays: row?.syncIntervalDays ?? 7 }
}

export function updateSettings(syncIntervalDays: number) {
  const days = Math.max(1, Math.round(syncIntervalDays))
  getDb().update(settings).set({ syncIntervalDays: days }).where(eq(settings.id, 1)).run()
  return getSettings()
}

export function getProfile() {
  const row = getDb().select().from(profile).where(eq(profile.id, 1)).get()
  return row
}

export function updateProfile(patch: Partial<{ name: string; headline: string; years: string; location: string; phone: string; email: string; links: string; summary: string; education: string; skills: string[]; workExperience: string; photo: string }>) {
  const current = getProfile()
  if (!current) return null
  getDb().update(profile).set({
    name: patch.name ?? current.name,
    headline: patch.headline ?? current.headline,
    years: patch.years ?? current.years,
    location: patch.location ?? current.location,
    phone: patch.phone ?? current.phone,
    email: patch.email ?? current.email,
    links: patch.links ?? current.links,
    summary: patch.summary ?? current.summary,
    education: patch.education ?? current.education,
    skillsJson: patch.skills ? JSON.stringify(patch.skills) : current.skillsJson,
    workExperience: patch.workExperience ?? current.workExperience,
    photo: patch.photo ?? current.photo,
  }).where(eq(profile.id, 1)).run()
  return getProfile()
}
