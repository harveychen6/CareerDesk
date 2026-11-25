import { z } from 'zod'
import { fail, json } from '@/server/http'
import { updateMaterialFacts } from '@/server/materials'
const schema = z.object({expectedRevision:z.number().int().safe().positive(),facts:z.array(z.object({id:z.string(),status:z.enum(['candidate','confirmed','rejected']),text:z.string().optional(),stage:z.enum(['planned','active','done','unknown']).optional()})).min(1)})
export async function PATCH(request:Request, {params}:{params:Promise<{id:string}>}) { try { const body = schema.parse(await request.json()); return json(updateMaterialFacts((await params).id,body.expectedRevision,body.facts)) } catch(e) { return fail(e) } }
