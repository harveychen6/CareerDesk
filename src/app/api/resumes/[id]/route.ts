import { z } from 'zod'
import { ResumeProfileSchema } from '@/domain/tailoring'
import { fail, json } from '@/server/http'
import { getResume, updateResume } from '@/server/resumes'

export const dynamic = 'force-dynamic'
const patchSchema = z.object({ expectedRevision: z.number().int().positive().optional(), summary: z.string().optional(), profile: ResumeProfileSchema.optional(), pageTarget: z.union([z.literal(1),z.literal(2)]).optional(), includedProjectIds: z.array(z.string().min(1)).optional(), overrides: z.array(z.object({ projectId:z.string().min(1), bulletOverride:z.string() }).strict()).optional() }).strict()
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const resume = getResume(id)
  if (!resume) return json({ error: '简历不存在' }, 404)
  return json(resume)
}
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params
    const body = patchSchema.parse(await request.json())
    const existing = getResume(id)
    if (!existing) return json({ error: '简历不存在' }, 404)
    if (existing.type === 'targeted' && body.expectedRevision === undefined) return json({ error: '缺少修订号' }, 400)
    return json(updateResume(id, body))
  } catch (error) { return fail(error) }
}
