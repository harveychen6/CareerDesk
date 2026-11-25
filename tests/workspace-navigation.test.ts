import { expect, it } from 'vitest'
import { isWorkspaceLink } from '@/lib/workspace-navigation'

it('guards in-app route changes while allowing export links, new tabs and anchors', () => {
  const current = new URL('http://localhost/resume?id=working')
  const link = (path: string, target = '', download = false) => ({ href: new URL(path, current), target, download })
  expect(isWorkspaceLink(current, link('/jobs'))).toBe(true)
  expect(isWorkspaceLink(current, link('/resume?id=other'))).toBe(true)
  expect(isWorkspaceLink(current, link('/api/resumes/working/markdown'))).toBe(false)
  expect(isWorkspaceLink(current, link('/resume/working/print', '_blank'))).toBe(false)
  expect(isWorkspaceLink(current, link('/jobs', '', true))).toBe(false)
  expect(isWorkspaceLink(current, link('#history'))).toBe(false)
  expect(isWorkspaceLink(current, link('https://example.com/jobs'))).toBe(false)
})
