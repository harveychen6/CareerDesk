import { fail, json } from '@/server/http'
import { generateTargetedDraft } from '@/server/tailoring'

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(await generateTargetedDraft((await params).id, await request.json(), request.signal))
  } catch (error) {
    return fail(error)
  }
}
