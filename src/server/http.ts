import { ZodError } from 'zod'
import { RequestError } from '@/server/request-error'

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status })
}

export function fail(error: unknown): Response {
  if (error instanceof RequestError) return json({ error: error.message, code: error.code }, error.status)
  if (error instanceof ZodError || error instanceof SyntaxError) return json({ error: '请求数据无效', code: 'invalid_input' }, 400)
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : '请求失败'
  const status = name === 'ConfirmRequired' || name === 'RevisionConflict' ? 409 : 400
  return json({ error: message }, status)
}
