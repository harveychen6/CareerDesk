import { json } from '@/server/http'
import { listResumeRevisions } from '@/server/resume-revisions'
import { getResume } from '@/server/resumes'
export const dynamic = 'force-dynamic'
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) { const { id }=await context.params; return getResume(id) ? json(listResumeRevisions(id)) : json({error:'简历不存在'},404) }
