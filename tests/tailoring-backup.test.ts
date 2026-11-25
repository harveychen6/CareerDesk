import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, expect, it } from 'vitest'
import { resetDbForTests } from '@/server/db'
import { createProject, getProject } from '@/server/projects'
import { createJob } from '@/server/jobs'
import { generateTargetedResume, getResume } from '@/server/resumes'
import { exportBackup, importBackup } from '@/server/backup'

beforeEach(()=>{resetDbForTests();process.env.DATA_DIR=fs.mkdtempSync(path.join(os.tmpdir(),'careerdesk-backup-')); process.env.AI_PROVIDER='fake'})
it('round trips v2, rejects invalid relations without writing, and maps v1 to snapshots', async()=>{
  const p=createProject('原项目'); const job=await createJob({company:'公司',role:'工程师',jdText:'工程'}); const id=generateTargetedResume(job!.id)!
  const backup=exportBackup(); expect(backup.version).toBe(2)
  const bad=structuredClone(backup); bad.resumeItems.push({id:'bad',resumeId:'missing',projectId:p.id,included:1,bulletOverride:'',sortOrder:0})
  expect(()=>importBackup(bad,true)).toThrow(); expect(getProject(p.id)?.title).toBe('原项目')
  importBackup(backup,true); expect(getResume(id)?.revision).toBe(1)
  const {sourceMaterials: _m,evidenceFacts: _f,jobAnalyses: _a,tailoringProposals: _t,resumeRevisions: _r,...base}=backup
  const legacy={...base,version:1 as const,resumes:base.resumes.map(({currentRevisionId: _c,...row})=>row)}
  importBackup(legacy,true); expect(getResume(id)?.revision).toBe(1)
})

it('requires confirmation before overwriting jobs and submitted revisions even when profile and projects are empty', async()=>{
  const empty=exportBackup()
  const job=await createJob({company:'公司',role:'工程师',jdText:'工程'})
  const id=generateTargetedResume(job!.id)!
  const { submitResume }=await import('@/server/resume-revisions')
  submitResume(id,getResume(id)!.revision!)
  expect(()=>importBackup(empty,false)).toThrow(/确认/)
  expect(getResume(id)).not.toBeNull()
})

it('allows importing into a default empty database without confirmation',()=>{
  const empty=exportBackup()
  expect(()=>importBackup(empty,false)).not.toThrow()
})
