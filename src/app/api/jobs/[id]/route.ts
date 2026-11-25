import { fail, json } from '@/server/http'
import { getJob, updateJob } from '@/server/jobs'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const job = await getJob(id)
  if (!job) return json({ error: '岗位不存在' }, 404)
  return json(job)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const job = await updateJob(id, await request.json())
    return job ? json(job) : json({ error: '岗位不存在' }, 404)
  } catch (error) {
    return fail(error)
  }
}
