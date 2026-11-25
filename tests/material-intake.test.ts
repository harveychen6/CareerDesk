import { expect, it } from 'vitest'
import { createIntakeScope } from '@/components/projects/material-intake-scope'
it('ignores stale refreshes and disposed project contexts', () => {
  const scope = createIntakeScope()
  const first = scope.beginRefresh()
  const second = scope.beginRefresh()
  expect(scope.current(first)).toBe(false)
  expect(scope.current(second)).toBe(true)
  scope.dispose()
  expect(scope.current(second)).toBe(false)
  expect(scope.active()).toBe(false)
})
import { MaterialIntake } from '@/components/projects/MaterialIntake'
it('uses a separate keyed child for each project context', () => {
  expect(MaterialIntake({projectId:'a'}).key).not.toBe(MaterialIntake({projectId:'b'}).key)
  expect(MaterialIntake({}).key).not.toBe(MaterialIntake({projectId:'a'}).key)
})
