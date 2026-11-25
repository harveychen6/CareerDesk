import { fail, json } from '@/server/http'
import { analyzeJobRequirements } from '@/server/tailoring'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(await analyzeJobRequirements((await params).id, await request.json(), request.signal))
  } catch (error) {
    return fail(error)
  }
}
