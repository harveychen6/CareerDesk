import { z } from 'zod'
import { fail, json } from '@/server/http'
import { createMaterial, listMaterials } from '@/server/materials'
export const dynamic = 'force-dynamic'
const input = z.object({ content:z.string(), projectId:z.string().optional(), createProject:z.boolean().optional(), title:z.string().optional(), stage:z.enum(['planned','active','done']).optional() })
export function GET(request:Request) { try { return json(listMaterials(new URL(request.url).searchParams.get('projectId') || undefined)) } catch (e) { return fail(e) } }
export async function POST(request:Request) { try { return json(createMaterial(input.parse(await request.json())),201) } catch(e) { return fail(e) } }
