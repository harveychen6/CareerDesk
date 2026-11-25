export interface ResumeEdit<T> {
  preview: (draft: T) => T
  save: (base: T) => Promise<T>
}

export function createResumeSaveQueue<T>(initial: T, onChange: () => void) {
  let base = initial
  const edits: ResumeEdit<T>[] = []
  let error: Error | null = null
  let active: Promise<void> | null = null

  async function drain() {
    while (edits.length && !error) {
      try {
        base = await edits[0].save(base)
        edits.shift()
      } catch (cause) {
        error = cause instanceof Error ? cause : new Error(String(cause))
      }
      onChange()
    }
  }

  function start() {
    if (!active && !error) {
      active = drain().finally(() => {
        active = null
        if (edits.length && !error) start()
      })
    }
    onChange()
  }

  return {
    snapshot: () => ({
      base,
      draft: edits.reduce((draft, edit) => edit.preview(draft), base),
      pending: edits.length,
      error,
    }),
    enqueue(edit: ResumeEdit<T>) {
      edits.push(edit)
      start()
    },
    retry(latest = base) {
      base = latest
      error = null
      start()
    },
    replace(latest: T) {
      base = latest
      onChange()
    },
    async flush() {
      while (active) await active
    },
  }
}
