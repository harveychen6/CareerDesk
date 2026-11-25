import { json } from '@/server/http'
import { getResumeRevision } from '@/server/resume-revisions'
export const dynamic = 'force-dynamic'
export async function GET(_request: Request, context: { params: Promise<{ id:string; revision:string }> }) { const { id, revision }=await context.params; if (!/^[1-9]\d*$/.test(revision)) return json({error:'修订号无效'},400); const row=getResumeRevision(id,Number(revision)); return row ? json(row) : json({error:'修订不存在'},404) }
