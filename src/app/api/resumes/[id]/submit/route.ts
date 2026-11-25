import { z } from 'zod'
import { fail, json } from '@/server/http'
import { submitResume } from '@/server/resume-revisions'
export const dynamic = 'force-dynamic'
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try { const { id } = await context.params; const { expectedRevision } = z.object({ expectedRevision:z.number().int().positive() }).strict().parse(await request.json()); const result=submitResume(id,expectedRevision); return result ? json(result) : json({error:'简历不存在'},404) } catch(error) { return fail(error) }
}
