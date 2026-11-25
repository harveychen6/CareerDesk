import { fail, json } from '@/server/http'
import { getJobTailoring } from '@/server/tailoring'

export const dynamic = 'force-dynamic'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const result = getJobTailoring((await params).id)
    return result ? json(result) : json({ error: '岗位不存在', code: 'not_found' }, 404)
  } catch (error) {
    return fail(error)
  }
}
