import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { resetDbForTests } from '@/server/db'
import { createJob, getJob } from '@/server/jobs'
import { generateTargetedResume, getResume } from '@/server/resumes'
import { PATCH } from '@/app/api/resumes/[id]/route'
import { POST } from '@/app/api/resumes/[id]/submit/route'
import { POST as saveJob } from '@/app/api/jobs/route'
import { PATCH as editJob } from '@/app/api/jobs/[id]/route'
import { POST as saveMaterial } from '@/app/api/materials/route'
it('requires a current revision for HTTP edits and rejects stale submits', async()=>{
  resetDbForTests();process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'careerdesk-http-'));process.env.AI_PROVIDER='fake'
  const job=await createJob({company:'公司',role:'工程师',jdText:'工程'});const id=generateTargetedResume(job!.id)!; const context={params:Promise.resolve({id})}
  const req=(body:unknown)=>new Request('http://localhost/',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)})
  expect((await PATCH(req({summary:'缺版本'}),context)).status).toBe(400)
  const revision=getResume(id)!.revision!; expect((await PATCH(req({summary:'新内容',expectedRevision:revision}),context)).status).toBe(200)
  expect((await PATCH(req({summary:'旧内容',expectedRevision:revision}),context)).status).toBe(409)
  expect((await POST(req({expectedRevision:revision}),context)).status).toBe(409)
})
it('rejects oversized source text on save and preserves the current JD', async () => {
  resetDbForTests()
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'careerdesk-input-bounds-'))
  process.env.AI_PROVIDER = 'fake'
  const request = (body: unknown) => new Request('http://localhost/', { method: 'POST', body: JSON.stringify(body) })
  const jdText = '岗'.repeat(12001)
  expect((await saveJob(request({ jdText }))).status).toBe(413)
  const original = (await createJob({ company: '公司', role: '工程师', jdText: '原文' }))!
  const context = { params: Promise.resolve({ id: original.id }) }
  expect((await editJob(request({ jdText }), context)).status).toBe(413)
  expect((await getJob(original.id))?.jdText).toBe('原文')
  expect((await saveMaterial(request({ content: '材'.repeat(20001) }))).status).toBe(413)
})
