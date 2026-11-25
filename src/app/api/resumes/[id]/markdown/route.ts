import { renderMarkdown } from '@/server/resumes'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const value = new URL(request.url).searchParams.get('revision')
  if (value !== null && !/^[1-9]\d*$/.test(value)) return new Response('修订号无效', { status: 400 })
  const markdown = renderMarkdown(id, value === null ? undefined : Number(value))
  if (!markdown) return new Response('简历不存在', { status: 404 })
  return new Response(markdown, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="resume.md"',
    },
  })
}
