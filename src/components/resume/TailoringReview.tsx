'use client'

import { useState } from 'react'
import Link from 'next/link'
import { copy, materialsCopy, tailoringCopy as c } from '@/content/zh-CN'
import type { ApplyProposalInput, JobRequirementAnalysis, ProposedBullet, TailoringProposal } from '@/domain/tailoring'

type Decision = ApplyProposalInput['decisions'][number]

export interface TailoringState {
  analysis: JobRequirementAnalysis | null
  proposal: TailoringProposal | null
}

interface Props {
  state: TailoringState | null
  resumeId: string
  revision: number | null
  disabled: boolean
  error: string
  onRetry: () => void
  onDecision: (proposalId: string, decision: Decision) => void
}

export function TailoringReview({ state, resumeId, revision, disabled, error, onRetry, onDecision }: Props) {
  const proposal = state?.proposal?.resumeId === resumeId ? state.proposal : null
  const analysis = state?.analysis
  const stale = Boolean(proposal && (proposal.stale || proposal.baseRevision !== revision))
  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-semibold">{c.review}</h3>
      {error && <div role="alert"><p className="cd-error">{error}</p><button className="cd-button mt-1" onClick={onRetry}>{c.retry}</button></div>}
      {!error && !state && <p role="status" className="cd-muted">{c.loading}</p>}
      {state && !proposal && <p className="cd-muted">{c.reviewEmpty}</p>}
      {(!proposal || stale) && <Link href="/jobs" className="text-[12px] text-[#2458b8] underline">{c.goToJobs}</Link>}
      {proposal && <>
        <p className="cd-muted">{c.pageTarget} · {c.pages(proposal.pageTarget)}</p>
        {proposal.provider === 'fake' && <p className="cd-demo">{c.fake}</p>}
        {stale && <p role="status" className="cd-warning">{c.reviewStale}</p>}
        {proposal.insufficiency && <p className="cd-muted">{proposal.insufficiency}</p>}
        {proposal.bullets.map(bullet => <ReviewBullet
          key={`${proposal.id}/${bullet.id}`}
          bullet={bullet}
          analysis={analysis}
          disabled={disabled || stale || Boolean(error)}
          onDecision={decision => onDecision(proposal.id, decision)}
        />)}
      </>}
    </section>
  )
}

function ReviewBullet({ bullet, analysis, disabled, onDecision }: { bullet: ProposedBullet; analysis?: JobRequirementAnalysis | null; disabled: boolean; onDecision: (decision: Decision) => void }) {
  const [confirmed, setConfirmed] = useState(false)
  const project = analysis?.facts.find(fact => fact.projectId === bullet.projectId)?.project
  const requirements = analysis?.requirements.filter(requirement => bullet.requirementIds.includes(requirement.id)) ?? []
  const needsConfirmation = bullet.risks.some(risk => risk.severity === 'confirm')
  const blocked = bullet.risks.some(risk => risk.severity === 'blocked')

  return (
    <article className="rounded-lg border border-[#e6eaf1] p-2.5 text-[12px] [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <h4 className="font-semibold">{project?.title}</h4>
        <span className="cd-muted">{c.bulletStatus[bullet.status]}</span>
      </div>
      {bullet.originalText && <p className="mb-1 mt-2 text-[#627086]">{c.before} · {bullet.originalText}</p>}
      <p className="my-1.5 font-medium">{bullet.text}</p>
      <p className="cd-muted">{bullet.reason}</p>
      {requirements.length > 0 && <details className="mt-1">
        <summary>{c.required}</summary>
        {requirements.map(requirement => <div key={requirement.id} className="mt-1">
          <p>{requirement.text}</p>
          <blockquote className="cd-quote" aria-label={copy.jd}>{analysis?.jdText.slice(requirement.jdRef.start, requirement.jdRef.end)}</blockquote>
        </div>)}
      </details>}
      <details className="mt-1">
        <summary>{c.evidenceSource}</summary>
        {bullet.sources.map(source => <div key={source.factId} className="mt-1">
          <p>{source.text}</p>
          <blockquote className="cd-quote" aria-label={materialsCopy.source}>{source.sourceText}</blockquote>
        </div>)}
      </details>
      {bullet.risks.length > 0 && <ul className="cd-warning my-2 list-disc space-y-1 pl-5">
        {bullet.risks.map((risk, index) => <li key={`${risk.code}-${index}`}>{risk.message}</li>)}
      </ul>}
      {bullet.status === 'pending' && <div className="mt-2 space-y-2">
        {needsConfirmation && !blocked && <label className="flex items-start gap-1.5">
          <input className="mt-0.5" type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={disabled} />
          {c.riskConfirm}
        </label>}
        <div className="flex flex-wrap gap-2">
          <button className="cd-button cd-primary" disabled={disabled || blocked || (needsConfirmation && !confirmed)} onClick={() => onDecision({ bulletId: bullet.id, action: 'accept', ...(needsConfirmation ? { confirmRisk: confirmed } : {}) })}>{c.acceptBullet}</button>
          <button className="cd-button" disabled={disabled} onClick={() => onDecision({ bulletId: bullet.id, action: 'reject' })}>{c.rejectBullet}</button>
        </div>
      </div>}
    </article>
  )
}
