import { fail, json } from '@/server/http'
import { extractMaterial } from '@/server/materials'
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    return json(await extractMaterial((await params).id, undefined, request.signal))
  } catch (error) {
    return fail(error)
  }
}
