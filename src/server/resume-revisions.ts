import { and, eq } from 'drizzle-orm'
import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from '@/domain/tailoring'
import { getDb, getSqlite } from '@/server/db'
import { resumeRevisions, resumes } from '@/server/db/schema'
import { newId, nowIso } from '@/server/ids'
import { snapshotMissingLegacy } from '@/server/db/legacy-snapshot'

export class RevisionConflict extends Error { constructor() { super('简历修订已变化，请刷新后重试'); this.name = 'RevisionConflict' } }
export function ensureResumeSnapshots() { snapshotMissingLegacy(getSqlite()) }
export function getResumeRevision(resumeId: string, revision: number) {
  const row = getDb().select().from(resumeRevisions).where(and(eq(resumeRevisions.resumeId, resumeId), eq(resumeRevisions.revision, revision))).get()
  return row ? { ...row, document: ResumeDocumentV1Schema.parse(JSON.parse(row.documentJson)) } : null
}
export function listResumeRevisions(resumeId: string) {
  return getDb().select().from(resumeRevisions).where(eq(resumeRevisions.resumeId, resumeId)).all().sort((a, b) => b.revision - a.revision).map(({ documentJson: _json, ...row }) => row)
}
export function currentResumeRevision(resumeId: string) {
  const db = getDb(); const resume = db.select().from(resumes).where(eq(resumes.id, resumeId)).get()
  if (!resume?.currentRevisionId) return null
  const row = db.select().from(resumeRevisions).where(eq(resumeRevisions.id, resume.currentRevisionId)).get()
  return row ? getResumeRevision(resumeId, row.revision) : null
}
export function writeResumeRevision(resumeId: string, expectedRevision: number | undefined, document: ResumeDocumentV1) {
  const db = getDb(); const current = currentResumeRevision(resumeId)
  if (!current) throw new Error('简历工作稿不存在')
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new RevisionConflict()
  const revision = Math.max(...listResumeRevisions(resumeId).map(r => r.revision)) + 1
  const id = newId(); const createdAt = nowIso()
  db.insert(resumeRevisions).values({ id, resumeId, revision, kind: 'working', documentJson: JSON.stringify(ResumeDocumentV1Schema.parse(document)), createdAt }).run()
  db.update(resumes).set({ currentRevisionId: id, summary: document.summary, updatedAt: createdAt }).where(eq(resumes.id, resumeId)).run()
  return getResumeRevision(resumeId, revision)!
}
export function submitResume(resumeId: string, expectedRevision: number) {
  return getSqlite().transaction(() => {
    const current = currentResumeRevision(resumeId); if (!current) return null
    if (current.revision !== expectedRevision) throw new RevisionConflict()
    const revision = Math.max(...listResumeRevisions(resumeId).map(r => r.revision)) + 1
    getDb().insert(resumeRevisions).values({ id: newId(), resumeId, revision, kind: 'submitted', documentJson: current.documentJson, createdAt: nowIso() }).run()
    return getResumeRevision(resumeId, revision)
  })()
}
