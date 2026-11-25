import type { FrozenFact, TailoringRisk } from '@/domain/tailoring'

type Claim = Pick<FrozenFact, 'text' | 'stage'>
const sameText = (text: string) => text.normalize('NFKC').trim().toLowerCase()
const clauses = (text: string) => sameText(text).split(/[，。；！？、;!?\n]|,(?!\d{3}\b)/)
const numberWithUnit = /(?<![a-z\d.])[+-]?\d(?:[\d,]*\d)?(?:\.\d+)?\s*(?:%|ms|μs|µs|ns|秒|毫秒|分钟|小时|天|周|个月|年|gb|mb|kb|tb|qps|rps|tps|万|亿|千|倍|条|次|台|个|项|人|套|组|页)?/gi
const technologies = /[a-z][a-z0-9]*(?:[+#]+|[./-][a-z0-9]+)*|微服务|分布式|区块链|深度学习|机器学习|消息队列|容器编排|服务网格|向量数据库|大模型/gi
const commonWords = new Set(['and', 'or', 'for', 'with', 'the', 'to', 'a', 'in', 'of', 'by', 'ms', 'ns', 'gb', 'mb', 'kb', 'tb'])
const ownership = /主导|主责|牵头|带领|统筹|独立(?:设计|实现|完成|负责|交付|上线)|led\b|owned\b|spearheaded/i
const participation = /参与|协助|配合|辅助|协作|contribut|assist/i
const individual = /独立|个人|单人|独自|single-handed|solo/i
const team = /团队|小组|共同|协作|配合|team|collaborat/i
const fullScope = /全量|全面|全部|全链路|全站|所有|整体交付|full rollout|end.to.end/i
const complete = /已完成|完成|交付|上线|发布|落地|实现了|投入生产|deployed|completed|shipped|delivered/i
const pending = /尚未|暂未|未(?:完成|上线|发布|交付|落地)|正在|计划|拟|预计|待上线|待发布|待交付|测试中|试点中|in progress|planned|pending/i
const partial = /部分|局部|子项|灰度|试点|测试环境|部分用户|partial|pilot|canary/i
const hasCompletion = (text: string) => clauses(text).some(clause => complete.test(clause) && !pending.test(clause))

const metricScope = /测试环境|预生产环境|开发环境|本地环境|生产环境|预发环境|压测(?:期间|环境|场景|下)|灰度|试点|部分用户|全量|上周|本周|上月|本月|\d{4}年|\d{1,2}月/gi
const comparisons = [
  { type: 'atMost', before: /(?:不高于|不超过|至多|小于等于|<=|≤)\s*$/, after: /^\s*(?:以内|以下|为限)/ },
  { type: 'atLeast', before: /(?:不低于|不少于|至少|大于等于|>=|≥)\s*$/, after: /^\s*(?:以上|及以上)/ },
  { type: 'below', before: /(?:低于|小于|少于|<)\s*$/ },
  { type: 'above', before: /(?:高于|大于|超过|>)\s*$/ },
  { type: 'approximate', before: /(?:约为|大约|约|接近|~)\s*$/, after: /^\s*(?:左右|上下)/ },
]

function quantities(text: string) {
  const parts = clauses(text)
  return parts.flatMap((clause, index) => [...clause.matchAll(numberWithUnit)].map(match => {
    const clean = (value: string) => value
      .replace(/大于等于|小于等于|不高于|不超过|不低于|不少于|从|由|约为|为|至|到|降低|减少|提升|提高|达到|维持|稳定|约|平均|以内|以下|以上|低于|高于|大于|小于|少于|超过|至少|至多|后续|当前|将|使|处理|负责|累计|完成|落地|支持|覆盖|设计|统计|涉及/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '')
    const before = clause.slice(0, match.index)
    const after = clause.slice(match.index! + match[0].length)
    const comparison = comparisons.find(rule => rule.before.test(before) || rule.after?.test(after))?.type ?? 'stated'
    const scope = (value: string): string[] => value.match(metricScope) ?? []
    const prior = parts[index - 1] ?? ''
    const qualifiers = scope(clause)
    if (!qualifiers.length && ![...prior.matchAll(numberWithUnit)].length) qualifiers.push(...scope(prior))
    return {
      token: match[0].replace(/[\s,]/g, ''),
      left: clean(before),
      right: clean(after),
      clause: clause.trim(),
      qualifiers: [comparison, ...new Set(qualifiers.sort())].join('|'),
    }
  }))
}

function sharedObject(a: string, b: string, edge: 'start' | 'end') {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a]
  return shorter.length >= (/\p{Script=Han}/u.test(shorter) ? 2 : 3) &&
    (edge === 'end' ? longer.endsWith(shorter) : longer.startsWith(shorter))
}

const claimObject = (clause: string) => clause.replace(
  /全量|全面|全部|全链路|全站|所有|局部|部分|灰度|试点|完成|尚未|暂未|未能|未|负责|主导|主责|牵头|参与|协助|配合|上线|发布|交付|推进|改造|落地|实现|正在|计划|独立|团队/g,
  '',
).replace(/[^\p{L}\p{N}]/gu, '')

function sameClaimObject(first: string, second: string) {
  const a = claimObject(first)
  const b = claimObject(second)
  return sharedObject(a, b, 'start') || sharedObject(a, b, 'end')
}

export function guardTailoringBullet(text: string, facts: Claim[]): TailoringRisk[] {
  const bullet = sameText(text)
  const sources = facts.map(f => sameText(f.text))
  const proposedClauses = clauses(bullet)
  const evidenceClauses = facts.flatMap(f => clauses(f.text).map(text => ({ text, stage: f.stage })))
  const risks: TailoringRisk[] = []
  const block = (code: string, message: string) => risks.push({ code, message, severity: 'blocked' })

  if (facts.length === 0 || facts.some(f => f.stage === 'planned' || f.stage === 'unknown')) {
    block('unconfirmed_outcome', '引用中包含待澄清或计划中的经历')
  }
  const originalQuantities = sources.flatMap(quantities)
  if (quantities(bullet).some(q => !originalQuantities.some(s => q.token === s.token && q.qualifiers === s.qualifiers && (
    q.clause === s.clause || sharedObject(q.left, s.left, 'end') ||
    (!q.left || !s.left) && sharedObject(q.right, s.right, 'start')
  )))) block('unsupported_quantity', '数字、单位、指标或适用条件没有明确事实支持')

  const markers = new Set(sources.flatMap(s => s.match(technologies) ?? []))
  if ((bullet.match(technologies) ?? []).some(token => !commonWords.has(token) && !markers.has(token))) {
    block('unsupported_technology', '出现确认事实中没有的技术或英文术语')
  }
  const contradictsSubject = (
    claim: string,
    contradicts: (evidence: typeof evidenceClauses[number]) => boolean,
    supports: (evidence: typeof evidenceClauses[number]) => boolean,
  ) => {
    const matching = evidenceClauses.filter(evidence => sameClaimObject(claim, evidence.text))
    return matching.some(contradicts) && !matching.some(supports)
  }
  if ((ownership.test(bullet) && !sources.some(s => ownership.test(s))) ||
    (individual.test(bullet) && !sources.some(s => individual.test(s))) ||
    (complete.test(bullet) && !team.test(bullet) && sources.every(s => team.test(s))) ||
    ((complete.test(bullet) || /负责|实现|设计/.test(bullet)) &&
      !participation.test(bullet) && sources.every(s => participation.test(s))) ||
    proposedClauses.some(claim => (ownership.test(claim) || individual.test(claim)) && contradictsSubject(
      claim, evidence => participation.test(evidence.text) || team.test(evidence.text),
      evidence => individual.test(claim) ? individual.test(evidence.text) : ownership.test(evidence.text),
    ))) {
    block('ownership_upgrade', '事实没有支持改写中的个人责任或主导范围')
  }
  if (fullScope.test(bullet) && (!sources.some(s => fullScope.test(s) && !partial.test(s)) ||
    proposedClauses.some(claim => fullScope.test(claim) && contradictsSubject(
      claim, evidence => partial.test(evidence.text),
      evidence => fullScope.test(evidence.text) && !partial.test(evidence.text),
    )))) {
    block('scope_upgrade', '事实没有支持全量或整体交付')
  }
  if (hasCompletion(bullet) && (!facts.some(f => f.stage === 'done' && (hasCompletion(f.text) || !pending.test(f.text))) ||
    proposedClauses.some(claim => hasCompletion(claim) && contradictsSubject(
      claim, evidence => pending.test(evidence.text),
      evidence => evidence.stage === 'done' && hasCompletion(evidence.text),
    )))) {
    block('completion_upgrade', '事实没有支持已完成或已交付的状态')
  }
  if (/待补充|待填写|（待填）|\bxx\s*%/i.test(bullet)) block('placeholder', '描述中含有待填写的内容')
  if (risks.length === 0 && !sources.includes(bullet)) {
    risks.push({ code: 'review_meaning', message: '请确认改写准确保留了事实、职责、指标口径和成果范围', severity: 'confirm' })
  }
  return risks
}
