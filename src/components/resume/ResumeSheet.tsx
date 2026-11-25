'use client'

import { useLayoutEffect, useRef } from 'react'
import { copy, tailoringCopy as c } from '@/content/zh-CN'
import { formatResumePeriod } from '@/domain/period'
import { resumeBulletLines, splitResumeHeading, splitResumeLead } from '@/domain/resume-line'
import type { ResumeProfile } from '@/domain/tailoring'
import './resume-sheet.css'

export interface SheetProject {
  projectId: string
  title: string
  org: string
  periodStart: string
  periodEnd: string
  bullet: string
  status?: 'planned' | 'active' | 'done'
}

interface ResumeSheetProps {
  profile: ResumeProfile
  job: { company: string; role: string } | null
  projects: SheetProject[]
  summary?: string
  editable?: boolean
  onBullet?: (projectId: string, value: string) => void
  onEditing?: (editing: boolean) => void
  onPhoto?: (dataUrl: string) => void
  onPhotoPending?: (pending: boolean) => void
  onPhotoError?: () => void
}

function ContentLine({ text }: { text: string }) {
  const parts = splitResumeLead(text)
  if (!parts) return text
  return <><strong>{parts.lead}</strong>{parts.body}</>
}

function educationRows(text: string): { school: string; detail: string; time: string }[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const parts = line.split(/\s*[·|]\s*/).filter(Boolean)
    const time = parts.find((part) => /\d{4}/.test(part)) ?? ''
    const rest = parts.filter((part) => part !== time)
    return { school: rest[0] ?? line, detail: rest.slice(1).join(' · '), time }
  })
}

function workBlocks(text: string): { name: string; period: string; lines: string[] }[] {
  return text.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean).map((block) => {
    const [head, ...rest] = block.split('\n')
    const { name, period } = splitResumeHeading(head)
    return { name, period, lines: rest.map((line) => line.replace(/^[-•]\s*/, '').trim()).filter(Boolean) }
  })
}

function readPhoto(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(file)
    image.onload = () => {
      const max = 480
      const scale = Math.min(1, max / Math.max(image.width, image.height))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      const context = canvas.getContext('2d')
      if (!context) {
        URL.revokeObjectURL(url)
        reject(new Error('无法处理图片'))
        return
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', 0.86))
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片'))
    }
    image.src = url
  })
}

export function ResumeSheet({ profile, job, projects, summary, editable = false, onBullet, onEditing, onPhoto, onPhotoPending, onPhotoError }: ResumeSheetProps) {
  const intention = [profile.headline, profile.years].filter(Boolean).join(' · ')
  const rows = educationRows(profile.education)
  const jobs = workBlocks(profile.workExperience)
  return (
    <article className="career-sheet">
      <header className="header-grid">
        <div>
          <h1>{profile.name || '未填写姓名'}</h1>
          {intention && <div className="headline">{intention.startsWith('求职意向') ? intention : `求职意向：${intention}`}</div>}
          {profile.location && <div className="contact">意向城市：{profile.location}</div>}
          {(profile.phone || profile.email) && (
            <div className="contact">
              {profile.phone && <span>电话：{profile.phone}</span>}
              {profile.phone && profile.email && <span>　|　</span>}
              {profile.email && <span>邮箱：<a href={`mailto:${profile.email}`}>{profile.email}</a></span>}
            </div>
          )}
          {profile.links && <div className="contact">{profile.links}</div>}
          {job && <div className="contact">投递：{job.company} · {job.role}</div>}
        </div>
        <label className={`profile-photo-slot${profile.photo ? ' has-photo' : ''}`} aria-label="替换证件照">
          {profile.photo ? <img src={profile.photo} alt="证件照" /> : <span className="photo-placeholder">证件照</span>}
          {onPhoto && (
            <input
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0]
                event.target.value = ''
                if (!file) return
                onPhotoPending?.(true)
                void readPhoto(file).then(onPhoto).catch(() => onPhotoError?.()).finally(() => onPhotoPending?.(false))
              }}
            />
          )}
        </label>
      </header>
      {summary?.trim() && <section className="section">
        <h2 className="section-title">{copy.summary}</h2>
        <p className="whitespace-pre-wrap">{summary}</p>
      </section>}
      <section className="section">
        <h2 className="section-title">工作经历</h2>
        {jobs.map((item) => (
          <article className="project" key={`${item.name}-${item.period}`}>
            <div className="company">
              <div className="company-name">{item.name}</div>
              {item.period && <div className="company-meta">{item.period}</div>}
            </div>
            {item.lines.length > 0 && (
              <ul>{item.lines.map((line, index) => <li key={`${item.name}-${index}`}><ContentLine text={line} /></li>)}</ul>
            )}
          </article>
        ))}
      </section>
      <section className="section">
        <h2 className="section-title">项目经历</h2>
        {projects.map((project) => {
          const lines = resumeBulletLines(project.bullet)
          const period = formatResumePeriod(project.periodStart, project.periodEnd)
          const projectStatus = project.status === 'active' ? c.activeProject : project.status === 'planned' ? c.plannedProject : ''
          return (
            <article className="project" key={project.projectId}>
              <div className="company">
                <div className="company-name">
                  {[project.title, project.org].filter(Boolean).join(' · ')}
                  {projectStatus && <span className="project-stage">{projectStatus}</span>}
                </div>
                {period && <div className="company-meta">{period}</div>}
              </div>
              {editable ? <EditableBullets value={project.bullet} label={c.editProjectBullet(project.title)}
                onEditing={onEditing} onCommit={value => onBullet?.(project.projectId, value)}
              /> : lines.length > 0 && <ul>{lines.map((line, index) => <li key={index}><ContentLine text={line} /></li>)}</ul>}
            </article>
          )
        })}
      </section>
      {profile.skills.length > 0 && (
        <section className="section">
          <h2 className="section-title">专业技能</h2>
          <ul>{profile.skills.map((skill, index) => <li key={`${index}-${skill}`}><ContentLine text={skill} /></li>)}</ul>
        </section>
      )}
      <section className="section">
        <h2 className="section-title">教育背景</h2>
        {rows.map((row) => (
          <div className="edu" key={`${row.school}-${row.detail}-${row.time}`}>
            <strong>{row.school}</strong>
            {row.detail && <span>{row.detail}</span>}
            {row.time && <time>{row.time}</time>}
          </div>
        ))}
      </section>
    </article>
  )
}

function EditableBullets({ value, label, onCommit, onEditing }: { value: string; label: string; onCommit: (value: string) => void; onEditing?: (editing: boolean) => void }) {
  const list = useRef<HTMLUListElement>(null)
  const start = useRef('')
  const sync = useRef<HTMLUListElement | null>(null)
  const rendered = useRef<string | null>(null)

  useLayoutEffect(() => {
    const node = list.current
    if (!node || node === document.activeElement || (sync.current === node && rendered.current === value)) return
    const lines = resumeBulletLines(value)
    node.replaceChildren(...(lines.length ? lines : ['']).map(line => {
      const item = document.createElement('li')
      const parts = splitResumeLead(line)
      if (parts) {
        const label = document.createElement('strong')
        label.textContent = parts.lead
        item.append(label, parts.body)
      } else {
        item.textContent = line
      }
      return item
    }))
    sync.current = node
    rendered.current = value
  }, [value])

  return <ul
    ref={list}
    role="textbox"
    aria-label={label}
    aria-multiline="true"
    contentEditable="plaintext-only"
    onFocus={event => {
      start.current = resumeBulletLines(event.currentTarget.innerText).join('\n')
    }}
    onInput={event => onEditing?.(resumeBulletLines(event.currentTarget.innerText).join('\n') !== start.current)}
    onBlur={event => {
      const text = resumeBulletLines(event.currentTarget.innerText).join('\n')
      if (text !== start.current) onCommit(text)
      onEditing?.(false)
    }}
  />
}
