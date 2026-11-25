import { fail, json } from '@/server/http'
import { applyTailoringProposal } from '@/server/tailoring'

export async function POST(request: Request, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  try {
    const { id, proposalId } = await params
    return json(applyTailoringProposal(id, proposalId, await request.json()))
  } catch (error) {
    return fail(error)
  }
}
