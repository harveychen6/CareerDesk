import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const profile = sqliteTable('profile', {
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  headline: text('headline').notNull(),
  years: text('years').notNull(),
  location: text('location').notNull(),
  phone: text('phone').notNull(),
  email: text('email').notNull(),
  links: text('links').notNull(),
  summary: text('summary').notNull(),
  education: text('education').notNull(),
  skillsJson: text('skills_json').notNull(),
  workExperience: text('work_experience').notNull().default(''),
  photo: text('photo').notNull().default(''),
})

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull(),
  summary: text('summary').notNull(),
  tagsJson: text('tags_json').notNull(),
  factsMarkdown: text('facts_markdown').notNull(),
  todos: text('todos').notNull(),
  resumeBullet: text('resume_bullet').notNull(),
  org: text('org').notNull(),
  periodStart: text('period_start').notNull(),
  periodEnd: text('period_end').notNull(),
  factsUpdatedAt: text('facts_updated_at'),
  bulletUpdatedAt: text('bullet_updated_at'),
  masterSyncedAt: text('master_synced_at'),
  updatedAt: text('updated_at').notNull(),
})

export const jobTargets = sqliteTable('job_targets', {
  id: text('id').primaryKey(),
  company: text('company').notNull(),
  role: text('role').notNull(),
  city: text('city').notNull(),
  salary: text('salary').notNull(),
  department: text('department').notNull(),
  jdText: text('jd_text').notNull(),
  matchScore: integer('match_score').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const jobKeywords = sqliteTable('job_keywords', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  text: text('text').notNull(),
  evidenceStatus: text('evidence_status').notNull(),
})

export const jobMatches = sqliteTable('job_matches', {
  id: text('id').primaryKey(),
  jobId: text('job_id').notNull(),
  projectId: text('project_id').notNull(),
  relevance: integer('relevance').notNull(),
  reason: text('reason').notNull(),
  rank: integer('rank').notNull(),
})

export const resumes = sqliteTable('resumes', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  jobId: text('job_id'),
  summary: text('summary').notNull(),
  updatedAt: text('updated_at').notNull(),
  currentRevisionId: text('current_revision_id'),
})

export const resumeItems = sqliteTable('resume_items', {
  id: text('id').primaryKey(),
  resumeId: text('resume_id').notNull(),
  projectId: text('project_id').notNull(),
  included: integer('included').notNull(),
  bulletOverride: text('bullet_override').notNull(),
  sortOrder: integer('sort_order').notNull(),
})

export const syncProposals = sqliteTable('sync_proposals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  baseBullet: text('base_bullet').notNull(),
  proposedBullet: text('proposed_bullet').notNull(),
  evidenceNote: text('evidence_note').notNull(),
  status: text('status').notNull(),
})

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey(),
  syncIntervalDays: integer('sync_interval_days').notNull(),
  lastMasterSyncAt: text('last_master_sync_at'),
})

export const resumeRevisions = sqliteTable('resume_revisions', {
  id: text('id').primaryKey(), resumeId: text('resume_id').notNull(), revision: integer('revision').notNull(),
  kind: text('kind').notNull(), documentJson: text('document_json').notNull(), createdAt: text('created_at').notNull(),
})
export const sourceMaterials = sqliteTable('source_materials', {
  id: text('id').primaryKey(), projectId: text('project_id'), title: text('title'), content: text('content').notNull(), contentHash: text('content_hash').notNull(), createdAt: text('created_at').notNull(),
})
export const evidenceFacts = sqliteTable('evidence_facts', {
  id: text('id').primaryKey(), materialId: text('material_id').notNull(), projectId: text('project_id'), text: text('text').notNull(), sourceStart: integer('source_start').notNull(), sourceEnd: integer('source_end').notNull(), status: text('status').notNull(), stage: text('stage').notNull(), revision: integer('revision').notNull(), createdAt: text('created_at').notNull(),
})
export const jobAnalyses = sqliteTable('job_analyses', {
  id: text('id').primaryKey(), jobId: text('job_id').notNull(), inputHash: text('input_hash').notNull(), payloadJson: text('payload_json').notNull(), createdAt: text('created_at').notNull(),
})
export const tailoringProposals = sqliteTable('tailoring_proposals', {
  id: text('id').primaryKey(), resumeId: text('resume_id').notNull(), jobId: text('job_id').notNull(), analysisId: text('analysis_id').notNull(), inputHash: text('input_hash').notNull(), baseRevision: integer('base_revision').notNull(), payloadJson: text('payload_json').notNull(), createdAt: text('created_at').notNull(),
})
