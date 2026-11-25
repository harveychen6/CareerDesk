'use client'

import { useEffect, useRef } from 'react'
import { tailoringCopy } from '@/content/zh-CN'

interface LinkDestination {
  href: URL
  target: string
  download: boolean
}

export function isWorkspaceLink(current: URL, { href, target, download }: LinkDestination) {
  return (!target || target.toLowerCase() === '_self') && !download && href.origin === current.origin &&
    !href.pathname.startsWith('/api/') && !/^\/resume\/[^/]+\/print\/?$/.test(href.pathname) &&
    (href.pathname !== current.pathname || href.search !== current.search)
}

const workChecks = new Set<() => boolean>()

function hasUnsavedWork() {
  for (const check of workChecks) if (check()) return true
  return false
}

function beforeUnload(event: BeforeUnloadEvent) {
  if (!hasUnsavedWork()) return
  event.preventDefault()
  event.returnValue = ''
}

function guardLink(event: MouseEvent) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
  if (!hasUnsavedWork() || !(event.target instanceof Element)) return
  const anchor = event.target.closest<HTMLAnchorElement>('a[href]')
  if (!anchor) return
  const current = new URL(window.location.href)
  const destination = { href: new URL(anchor.href, current), target: anchor.target, download: anchor.hasAttribute('download') }
  if (isWorkspaceLink(current, destination) && !window.confirm(tailoringCopy.discardChanges)) {
    event.preventDefault()
    event.stopPropagation()
  }
}

export function useUnsavedNavigation(hasWork: () => boolean) {
  const check = useRef(hasWork)
  check.current = hasWork
  useEffect(() => {
    const read = () => check.current()
    if (workChecks.size === 0) {
      window.addEventListener('beforeunload', beforeUnload)
      document.addEventListener('click', guardLink, true)
    }
    workChecks.add(read)
    return () => {
      workChecks.delete(read)
      if (workChecks.size === 0) {
        window.removeEventListener('beforeunload', beforeUnload)
        document.removeEventListener('click', guardLink, true)
      }
    }
  }, [])
}
