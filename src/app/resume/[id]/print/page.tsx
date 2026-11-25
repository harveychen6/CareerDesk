import { ResumeSheet } from '@/components/resume/ResumeSheet'
import { getResume } from '@/server/resumes'

export const dynamic = 'force-dynamic'

export default async function PrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ autoprint?: string; revision?: string }>
}) {
  const { id } = await params
  const query = await searchParams
  const revision = query.revision && /^[1-9]\d*$/.test(query.revision) ? Number(query.revision) : undefined
  if (query.revision && revision === undefined) return <p>修订号无效</p>
  const resume = getResume(id, revision)
  if (!resume?.profile) return <p>简历不存在</p>
  const included = resume.projects.filter((project) => project.included)
  return (
    <main className="bg-white">
      <ResumeSheet profile={resume.profile} job={resume.job} projects={included} summary={resume.summary} />
      <style>{'@page { size: A4; margin: 0; }'}</style>
      {query.autoprint ? <script dangerouslySetInnerHTML={{ __html: 'window.addEventListener("load", () => window.print())' }} /> : null}
    </main>
  )
}
