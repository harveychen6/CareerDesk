import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { resetDbForTests } from '@/server/db'
import { createMaterial, extractMaterial, listMaterials, listConfirmedFacts, updateMaterialFacts } from '@/server/materials'
import { contentHash, validSourceRange } from '@/domain/evidence'
import { getMeta } from '@/server/meta'
import { deleteProject } from '@/server/projects'

beforeEach(() => { resetDbForTests(); process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'materials-')); process.env.AI_PROVIDER = 'fake' })
it('preserves source, hashes UTF-8 and validates UTF-16 source ranges', () => {
  const text = '  做了😀\n第二行  '
  const material = createMaterial({ content: text })
  expect(material.content).toBe(text)
  expect(material.contentHash).toBe(contentHash(text))
  expect(validSourceRange(text, 2, 6, '做了😀')).toBe(true)
  expect(validSourceRange(text, 2, 6, '做了')).toBe(false)
  expect(validSourceRange(text, 0, 2, '  ')).toBe(false)
})
it('extracts candidates without confirmation and requires matching revision and ownership', async () => {
  const a = createMaterial({content:'第一行\n第二行'})
  const b = createMaterial({content:'其他'})
  await extractMaterial(a.id); await extractMaterial(b.id)
  const fact = listMaterials()[0].facts[0]
  const owner = listMaterials().find(m => m.facts.some(f => f.id === fact.id))!
  const other = owner.id === a.id ? b : a
  expect(listConfirmedFacts()).toEqual([])
  expect(() => updateMaterialFacts(other.id, fact.revision, [{id: fact.id, status:'confirmed'}])).toThrow()
  expect(() => updateMaterialFacts(owner.id, fact.revision, [{id:'missing', status:'confirmed'}])).toThrow()
  updateMaterialFacts(owner.id, fact.revision, [{id:fact.id,status:'confirmed',stage:'done'}])
  expect(listConfirmedFacts()).toHaveLength(1)
  expect(() => updateMaterialFacts(owner.id, fact.revision, [{id:fact.id,status:'rejected'}])).toThrow()
})
it('rejects invalid extracted references and preserves source on failures without retries', async () => {
  const material = createMaterial({content:'原文'})
  let calls = 0
  await expect(extractMaterial(material.id, async () => { calls++; return [{text:'编造',start:0,end:20,sourceText:'原文'}] })).rejects.toThrow()
  expect(calls).toBe(1)
  expect(listMaterials()[0].content).toBe('原文')
  expect(listMaterials()[0].facts).toEqual([])
})
import { POST } from '@/app/api/materials/route'
import { POST as extract } from '@/app/api/materials/[id]/extract/route'
import { PATCH } from '@/app/api/materials/[id]/facts/route'
it('validates HTTP revisions and preserves material when provider is unavailable', async () => {
  const request = (body: unknown) => new Request('http://localhost/', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  const created = await POST(request({content:'来源'})); expect(created.status).toBe(201)
  const material = await created.json() as {id:string}; const ctx = {params:Promise.resolve({id:material.id})}
  delete process.env.AI_PROVIDER; const key = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY
  try { expect((await extract(request({}),ctx)).status).toBe(503); expect(listMaterials().find(m => m.id === material.id)?.content).toBe('来源') } finally { if (key) process.env.OPENAI_API_KEY = key; process.env.AI_PROVIDER = 'fake' }
  await extract(request({}),ctx)
  const fact = listMaterials().find(m => m.id === material.id)!.facts[0]
  expect((await PATCH(request({expectedRevision:'1',facts:[{id:fact.id,status:'confirmed'}]}),ctx)).status).toBe(400)
})
it('reuses existing candidates without calling the extractor or discarding edits', async () => {
  const material = createMaterial({content:'材料'})
  await extractMaterial(material.id)
  const fact = listMaterials()[0].facts[0]
  updateMaterialFacts(material.id, fact.revision, [{id:fact.id,status:'candidate',text:'我的修改'}])
  const result = await extractMaterial(material.id, async () => { throw new Error('unexpected call') })
  expect(result.facts[0].text).toBe('我的修改')
})
import { segmentMaterial } from '@/server/ai/materials'
it('maps source segments to exact original UTF-16 ranges', () => {
  const source = '  😀贡献\r\n\n第二行  '
  const segments = segmentMaterial(source)
  expect(segments.map(s => source.slice(s.start,s.end))).toEqual(['  😀贡献\r','第二行  '])
  expect(segments.map(s => s.id)).toEqual(['0','1'])
})
it('creates a project only on explicit request with the chosen stage', () => {
  const unlinked = createMaterial({content:'无关联'})
  expect(unlinked.projectId).toBeNull()
  expect(() => createMaterial({content:'材料',createProject:true,title:'经历'})).toThrow()
  const linked = createMaterial({content:'材料',createProject:true,title:'经历',stage:'active'})
  expect(linked.projectId).toBeTruthy()
  expect(listMaterials(linked.projectId!)).toHaveLength(1)
})
it('extracts bounded chunks from long unbroken source without splitting emoji', async () => {
  const source = '字'.repeat(1799) + '😀' + '字'.repeat(2200)
  const material = createMaterial({content:source})
  const result = await extractMaterial(material.id)
  expect(result.facts.length).toBeGreaterThan(1)
  expect(result.facts.map(f => f.sourceText).join('')).toBe(source)
  expect(result.facts.every(f => !/[\uD800-\uDBFF]$/.test(f.sourceText))).toBe(true)
})

it('counts reviewed material as complete until confirmation or its project is removed', async () => {
  const material = createMaterial({ content: '完成索引\n检查结果', createProject: true, title: '项目', stage: 'active' })
  const { facts: [first, second] } = await extractMaterial(material.id)

  updateMaterialFacts(material.id, first.revision, [{ id: first.id, status: 'confirmed', stage: 'done' }])
  expect(getMeta().completeness).toBe(0)
  updateMaterialFacts(material.id, second.revision, [{ id: second.id, status: 'rejected' }])
  expect(getMeta().completeness).toBe(100)
  updateMaterialFacts(material.id, first.revision + 1, [{ id: first.id, status: 'rejected' }])
  expect(getMeta().completeness).toBe(0)
  updateMaterialFacts(material.id, first.revision + 2, [{ id: first.id, status: 'confirmed' }])
  expect(getMeta().completeness).toBe(100)
  deleteProject(material.projectId!)
  expect(getMeta().completeness).toBeNull()
  expect(listMaterials()[0].projectId).toBeNull()
})
