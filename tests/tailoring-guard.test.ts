import { expect, it } from 'vitest'
import { guardTailoringBullet } from '@/domain/tailoring-guard'

it.each([
  ['将缓存命中率提升至 90%', '缓存命中率达到 80%'],
  ['将成功率提升至 80%', '缓存命中率达到 80%'],
  ['接口延迟达到 100ms', '接口延迟低于 100ms'],
  ['缓存命中率达到 80%', '在测试环境缓存命中率达到 80%'],
  ['负责 Rust 服务开发', '负责 Go 服务开发'],
  ['主导缓存优化', '参与缓存优化'],
  ['全量发布接口改造', '完成局部接口改造'],
  ['独立完成服务迁移', '团队完成服务迁移'],
])('拦截确定的新主张 %s', (text, source) => {
  expect(guardTailoringBullet(text, [{ text: source, stage: 'done' }]).some(r => r.severity === 'blocked')).toBe(true)
})

it.each([
  ['完成接口上线', ['完成缓存监控，接口尚未上线']],
  ['主导接口改造', ['参与接口改造', '主导缓存改造']],
  ['全量发布接口改造', ['局部发布接口改造', '全量发布缓存监控']],
])('阻止把别的工作项的职责或状态套用到 %s', (text, sources) => {
  const evidence = sources.map(source => ({ text: source, stage: 'done' as const }))
  expect(guardTailoringBullet(text, evidence).some(r => r.severity === 'blocked')).toBe(true)
})

it('保留延迟上界和测试环境限定的改写仍可人工确认', () => {
  const evidence = [{ text: '在测试环境，接口延迟低于 100ms', stage: 'done' as const }]
  expect(guardTailoringBullet('测试环境下，接口延迟小于 100ms', evidence)).toEqual([
    expect.objectContaining({ severity: 'confirm' }),
  ])
})

it('保留已完成子项，普通改写要人工确认', () => {
  const fact = [{ text: '完成缓存数据归档', stage: 'done' as const }]
  expect(guardTailoringBullet('完成缓存数据归档', fact)).toEqual([])
  expect(guardTailoringBullet('完成缓存归档工作', fact)).toEqual([
    expect.objectContaining({ severity: 'confirm' }),
  ])
  expect(guardTailoringBullet('已上线缓存归档', [{text:'正在实现缓存归档',stage:'active'}]).some(r => r.severity === 'blocked')).toBe(true)
})

it('把 P95 当作指标标识，保留已完成与其他进行中工作的区别', () => {
  const evidence = [{ text: '完成缓存 P95 检查，后续告警改造正在进行', stage: 'done' as const }]
  expect(guardTailoringBullet('完成检查缓存 P95', evidence)).toEqual([expect.objectContaining({ severity: 'confirm' })])
  expect(guardTailoringBullet('完成缓存 P99 检查', evidence)).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'unsupported_technology', severity: 'blocked' })]),
  )
})
