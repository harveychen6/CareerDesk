import { fail, json } from '@/server/http'
import { listConfirmedFacts } from '@/server/materials'
export const dynamic = 'force-dynamic'
export function GET() { try { return json(listConfirmedFacts()) } catch(e) { return fail(e) } }
