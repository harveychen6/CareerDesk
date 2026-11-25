import { z } from 'zod'
import { canceledRequest, runStructuredTask } from '@/server/ai/structured'
export type ExtractedFact = { text: string; start: number; end: number; sourceText: string }
export type MaterialExtractor = (content: string, signal?: AbortSignal) => Promise<ExtractedFact[]>
const schema = z.object({ facts: z.array(z.object({ text: z.string().trim().min(1).max(2000), segmentId: z.string() }).strict()).max(100) }).strict()
export function segmentMaterial(content:string) {
  const segments: {id:string; text:string; start:number; end:number}[] = []; let start = 0
  for (const line of content.split('\n')) {
    let offset = 0
    while (offset < line.length) {
      let end = Math.min(offset + 1800, line.length)
      if (end < line.length && /[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end])) end--
      const text = line.slice(offset,end)
      if (text.trim()) segments.push({id:String(segments.length),text,start:start+offset,end:start+end})
      offset = end
    }
    start += line.length + 1
  }
  return segments
}
export async function extractCandidates(content: string, signal?: AbortSignal): Promise<ExtractedFact[]> {
  if (signal?.aborted) throw canceledRequest()
  const segments = segmentMaterial(content)
  if (process.env.AI_PROVIDER === 'fake') return segments.slice(0,100).map(s => ({text:s.text.trim(),start:s.start,end:s.end,sourceText:s.text}))
  const byId = new Map(segments.map(segment => [segment.id, segment]))
  const result = await runStructuredTask(`从材料分段提取候选事实，返回 JSON 对象 facts 数组，每项包含 text 和 segmentId。只使用给出的分段 ID，候选事实必须由该分段支持，不要推测或编造。材料分段：\n${JSON.stringify(segments.map(({id,text}) => ({id,text})))}`, schema, {
    signal, repair: true, validate: value => value.facts.every(fact => byId.has(fact.segmentId)),
  })
  return result.facts.map(f => { const segment = byId.get(f.segmentId)!; return {text:f.text,start:segment.start,end:segment.end,sourceText:segment.text} })
}
