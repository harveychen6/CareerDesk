import { expect, test } from 'vitest'
import { createResumeSaveQueue, type ResumeEdit } from '@/components/resume/resume-save-queue'

type Draft = { revision: number; text: string }

test('serializes saves and retries the retained edit against the reloaded revision', async () => {
  const revisions: number[] = []
  let release!: () => void
  const first = new Promise<void>(resolve => { release = resolve })
  const queue = createResumeSaveQueue<Draft>({ revision: 1, text: '' }, () => {})
  const edit = (text: string): ResumeEdit<Draft> => ({
    preview: base => ({ ...base, text }),
    save: async base => {
      revisions.push(base.revision)
      if (base.revision === 1) await first
      if (base.revision === 2) throw new Error('conflict')
      return { revision: base.revision + 1, text }
    },
  })

  queue.enqueue(edit('first'))
  queue.enqueue(edit('second'))
  expect(revisions).toEqual([1])
  expect(queue.snapshot().draft.text).toBe('second')
  release()
  await queue.flush()
  expect(revisions).toEqual([1, 2])
  expect(queue.snapshot()).toMatchObject({ draft: { revision: 2, text: 'second' }, pending: 1, error: new Error('conflict') })

  queue.retry({ revision: 6, text: 'external edit' })
  await queue.flush()
  expect(revisions).toEqual([1, 2, 6])
  expect(queue.snapshot()).toMatchObject({ draft: { revision: 7, text: 'second' }, pending: 0, error: null })
})
