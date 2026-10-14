import type { QRecord, Question } from './types'

export interface ReviewPolicy {
  baseIntervalDays: number
}

const DEFAULT_EASE = 2.0

/** Basic SM-2-inspired interval update (simplified, no short/mark: on correct iterate interval*ease). */
export function nextInterval(
  prevIntervalDays: number,
  isCorrect: boolean,
  ease = DEFAULT_EASE,
): { intervalDays: number; ease: number } {
  if (!isCorrect) {
    return { intervalDays: 0, ease: ease }
  }
  if (prevIntervalDays <= 0) {
    return { intervalDays: 1, ease: ease }
  }
  const next = Math.round(prevIntervalDays * ease)
  return { intervalDays: Math.min(Math.max(next, 1), 365), ease }
}

/** Advance a record after an attempt. */
export function applyAttempt(rec: QRecord, isCorrect: boolean, now = Date.now()): QRecord {
  const prev = rec.intervalDays
  const { intervalDays, ease } = nextInterval(prev, isCorrect, rec.ease)
  const attempts = rec.attempts + 1
  const correctCount = rec.correctCount + (isCorrect ? 1 : 0)
  const wrongCount = rec.wrongCount + (isCorrect ? 0 : 1)
  const streakWindow = attempts
  let status: QRecord['status']
  if (wrongCount >= 3) status = 'struggling'
  else if (attempts >= 3 && correctCount / streakWindow >= 0.8 && intervalDays >= 3 && wrongCount === 0) {
    status = 'mastered'
  } else if (attempts >= 4 && correctCount - wrongCount >= 3) {
    status = 'mastered'
  } else {
    status = 'learning'
  }
  const nextReviewAt = intervalDays === 0 ? now : now + intervalDays * 24 * 3600 * 1000
  return {
    ...rec,
    status,
    attempts,
    correctCount,
    wrongCount,
    lastSeenAt: now,
    lastCorrect: isCorrect,
    intervalDays,
    ease,
    nextReviewAt,
  }
}

export function freshRecord(qid: string, now = Date.now()): QRecord {
  return {
    qid,
    status: 'new',
    attempts: 0,
    correctCount: 0,
    wrongCount: 0,
    lastSeenAt: 0,
    lastCorrect: null,
    lastAnswer: null,
    intervalDays: 0,
    ease: DEFAULT_EASE,
    nextReviewAt: now,
  }
}

/** Selection weights. Wrong-first + due + coverage balancing. */
export interface SelectParams {
  pool: Question[]
  records: Map<string, QRecord>
  now: number
  count: number
  /** If provided, type-selection target; bottled selection is uniform within pool otherwise. */
  wrongBoost?: number // multiplier on wrong/struggling weight
  newBoost?: number
  rng?: () => number
}

/** Deterministic PRNG for tests/paper composition. */
export function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Pick `count` questions from pool, weighting:
/**
 * Pick `count` questions from pool, weighting:
 *   - due for review (nextReviewAt <= now) highest
 *   - wrong often / struggling higher than new
 *   - not-new coverage features higher than already-mastered
 * plus randomness to avoid identical repeats within a session.
 */
export function selectQuestions(params: SelectParams): Question[] {
  const { pool, records, now, count } = params
  const rng = params.rng ?? (Math.random as () => number)
  if (count <= 0 || pool.length === 0) return []
  const wrongBoost = params.wrongBoost ?? 4
  const newBoost = params.newBoost ?? 1.2

  const weight = (q: Question): number => {
    const rec = records.get(q.id) ?? freshRecord(q.id, now)
    let w = 1
    if (rec.nextReviewAt <= now) w += 6 // due
    if (rec.status === 'struggling' || rec.wrongCount >= 2) w += wrongBoost
    else if (rec.status === 'learning') w += 2
    if (rec.status === 'new') w += newBoost
    if (rec.status === 'mastered') w *= 0.15 // rarely show mastered
    if (rec.lastSeenAt > 0 && now - rec.lastSeenAt < 60_000) w *= 0.3 // avoid recent repeat
    if (rec.attempts === 0) w *= 2 // prefer untouched questions
    return w
  }

  const result: Question[] = []
  const chosen = new Set<string>()
  let guard = 0
  while (result.length < count && guard < 10000) {
    guard++
    const candidates = pool.filter((q) => !chosen.has(q.id) && weight(q) > 0.05)
    if (candidates.length === 0) break
    const total = candidates.reduce((s, q) => s + weight(q), 1e-9)
    let r = rng() * total
    let picked: Question | null = null
    for (const q of candidates) {
      r -= weight(q)
      if (r <= 0) {
        picked = q
        break
      }
    }
    if (!picked) picked = candidates[candidates.length - 1]
    result.push(picked)
    chosen.add(picked.id)
  }
  return result
}

/** Build a mock exam paper from config: exact per-type counts. */
export function buildPaper(
  allQuestions: Question[],
  config: {
    singleCount: number
    multiCount: number
    judgeCount: number
    shortCount: number
    chapters: string[] | 'all'
  },
  rng: () => number = Math.random,
): Question[] {
  const pool =
    config.chapters === 'all'
      ? allQuestions
      : allQuestions.filter((q) => (config.chapters as string[]).includes(q.chapter))
  const objective = pool.filter((q) => q.type !== 'short' && q.type !== 'material')
  const shorts = pool.filter((q) => q.type === 'short' || q.type === 'material')

  const byType = (t: Question['type']) => objective.filter((q) => q.type === t)
  const pick = (arr: Question[], n: number): Question[] => {
    const copy = arr.slice()
    const res: Question[] = []
    for (let i = 0; i < n && copy.length > 0; i++) {
      const idx = Math.floor(rng() * copy.length)
      res.push(copy[idx])
      copy.splice(idx, 1)
    }
    return res
  }
  const singles = pick(byType('single'), config.singleCount)
  const multis = pick(byType('multi'), config.multiCount)
  const judges = pick(byType('judge'), config.judgeCount)
  let subs: Question[] = []
  if (config.shortCount > 0) {
    const enough = shorts.slice(0, Math.max(config.shortCount, shorts.length))
    let need = config.shortCount - enough.length
    subs = enough
    while (need > 0) {
      subs = subs.concat(pick(byType('short'), 1), pick(byType('material'), 1))
      need = config.shortCount - subs.length
    }
  }
  return [...singles, ...multis, ...judges, ...subs].slice(
    0,
    config.singleCount + config.multiCount + config.judgeCount + config.shortCount,
  )
}
