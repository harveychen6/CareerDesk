import { and, eq } from 'drizzle-orm'
import { contentHash, validSourceRange } from '@/domain/evidence'
import { MAX_MATERIAL_LENGTH } from '@/domain/source-limits'
import { extractCandidates, type MaterialExtractor } from '@/server/ai/materials'
import { canceledRequest } from '@/server/ai/structured'
import { getDb, getSqlite } from '@/server/db'
import { evidenceFacts, projects, sourceMaterials } from '@/server/db/schema'
import { newId, nowIso } from '@/server/ids'
import { getProject } from '@/server/projects'
import { RequestError } from '@/server/request-error'

export type FactStatus = 'candidate' | 'confirmed' | 'rejected'
export type FactStage = 'planned' | 'active' | 'done' | 'unknown'
export type FactChange = { id: string; status: FactStatus; text?: string; stage?: FactStage }
export function createMaterial(input: {content: string; projectId?: string; createProject?: boolean; title?: string; stage?: 'planned' | 'active' | 'done'}) {
  if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('请填写材料原文')
  if (input.content.length > MAX_MATERIAL_LENGTH) {
    throw new RequestError('input_too_large', 413, `材料超过 ${MAX_MATERIAL_LENGTH} 个字符，请缩小范围后保存`)
  }
  if (input.projectId && !getProject(input.projectId)) throw new Error('项目不存在')
  if (input.projectId && input.createProject) throw new Error('不能同时选择和新建项目')
  if (input.createProject && (!input.title?.trim() || !['planned','active','done'].includes(input.stage ?? ''))) throw new Error('请填写项目名称并选择阶段')
  return getSqlite().transaction(() => {
    let projectId = input.projectId ?? null
    if (input.createProject) {
      const timestamp = nowIso(); projectId = newId()
      getDb().insert(projects).values({ id: projectId, title: input.title!.trim(), status: input.stage!, summary:'', tagsJson:'[]', factsMarkdown:'', todos:'', resumeBullet:'', org:'', periodStart:'', periodEnd:'', factsUpdatedAt:null, bulletUpdatedAt:null, masterSyncedAt:null, updatedAt:timestamp }).run()
    }
    const row = { id:newId(), projectId, title:null, content:input.content, contentHash:contentHash(input.content), createdAt:nowIso() }
    getDb().insert(sourceMaterials).values(row).run(); return row
  })()
}
export function listMaterials(projectId?: string) {
  const db = getDb(); const rows = projectId ? db.select().from(sourceMaterials).where(eq(sourceMaterials.projectId, projectId)).all() : db.select().from(sourceMaterials).all()
  return rows.map(row => ({ ...row, facts: db.select().from(evidenceFacts).where(eq(evidenceFacts.materialId,row.id)).all().map(f => ({...f, sourceText: row.content.slice(f.sourceStart,f.sourceEnd)})) }))
}
export async function extractMaterial(id: string, extractor: MaterialExtractor = extractCandidates, signal?: AbortSignal) {
  if (signal?.aborted) throw canceledRequest()
  const material = getDb().select().from(sourceMaterials).where(eq(sourceMaterials.id,id)).get(); if (!material) throw new Error('材料不存在')
  const saved = listMaterials().find(m => m.id === id)!
  if (saved.facts.length) return saved
  const result = await extractor(material.content, signal)
  if (signal?.aborted) throw canceledRequest()
  if (!Array.isArray(result) || result.length > 100 || result.some(f => typeof f.text !== 'string' || !f.text.trim() || f.text.length > 2000 || !validSourceRange(material.content,f.start,f.end,f.sourceText))) throw new Error('模型返回的原文引用无效')
  return getSqlite().transaction(() => {
    // Avoid duplicate extraction and preserve any user-edited candidates.
    const existing = getDb().select().from(evidenceFacts).where(eq(evidenceFacts.materialId,id)).all()
    if (existing.length) return listMaterials().find(m => m.id === id)!
    for (const fact of result) getDb().insert(evidenceFacts).values({ id:newId(), materialId:id, projectId:material.projectId, text:fact.text.trim(), sourceStart:fact.start, sourceEnd:fact.end, status:'candidate', stage:'unknown', revision:1, createdAt:nowIso() }).run()
    return listMaterials().find(m => m.id === id)!
  })()
}
export function updateMaterialFacts(id: string, expectedRevision: number, facts: FactChange[]) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !Array.isArray(facts) || !facts.length || new Set(facts.map(f => f.id)).size !== facts.length) throw new Error('事实修订无效')
  return getSqlite().transaction(() => {
    for (const change of facts) {
      if (!change || typeof change.id !== 'string' || !['candidate','confirmed','rejected'].includes(change.status) || (change.stage !== undefined && !['planned','active','done','unknown'].includes(change.stage)) || (change.text !== undefined && (typeof change.text !== 'string' || !change.text.trim() || change.text.length > 2000))) throw new Error('事实内容无效')
      const fact = getDb().select().from(evidenceFacts).where(and(eq(evidenceFacts.id,change.id),eq(evidenceFacts.materialId,id))).get()
      if (!fact) throw new Error('事实不存在')
      if (fact.revision !== expectedRevision) { const error = new Error('事实已变化，请刷新后重试'); error.name = 'RevisionConflict'; throw error }
      getDb().update(evidenceFacts).set({ status:change.status, text:change.text?.trim() ?? fact.text, stage:change.stage ?? fact.stage, revision:fact.revision+1 }).where(eq(evidenceFacts.id,fact.id)).run()
    }
    return listMaterials().find(m => m.id === id)!
  })()
}
type MaterialWithFacts = ReturnType<typeof listMaterials>[number]

function validFactSource(material: MaterialWithFacts, fact: MaterialWithFacts['facts'][number]) {
  return fact.projectId === material.projectId &&
    material.contentHash === contentHash(material.content) &&
    validSourceRange(material.content, fact.sourceStart, fact.sourceEnd, fact.sourceText)
}

export function listConfirmedFacts() {
  return listMaterials().flatMap(material => material.facts.filter(f => f.status === 'confirmed').map(f => {
    if (!validFactSource(material, f)) throw new Error('事实来源无效')
    return { ...f, sourceRef: { materialId:material.id, start:f.sourceStart, end:f.sourceEnd, contentHash:material.contentHash }, sourceText:f.sourceText, material: { title:material.title, createdAt:material.createdAt }, project:material.projectId ? getProject(material.projectId) : null }
  }))
}

export function projectsWithReviewedMaterials() {
  const confirmed = new Set<string>()
  const pending = new Set<string>()
  for (const material of listMaterials()) {
    if (!material.projectId) continue
    if (material.facts.some(fact => fact.status === 'candidate')) pending.add(material.projectId)
    if (material.facts.some(fact => fact.status === 'confirmed' && validFactSource(material, fact))) {
      confirmed.add(material.projectId)
    }
  }
  for (const projectId of pending) confirmed.delete(projectId)
  return confirmed
}
