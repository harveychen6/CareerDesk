import { createHash } from 'node:crypto'
export function contentHash(content: string) { return createHash('sha256').update(content, 'utf8').digest('hex') }
export function validSourceRange(content: string, start: number, end: number, sourceText: string) {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= content.length && start < end && Boolean(sourceText.trim()) && content.slice(start, end) === sourceText
}
