import type { Question, QRecord } from './types'
import { selectQuestions, mulberry32 } from './scheduler'

/** Extra subjective questions appended to a plan, on top of the objective quota. */
export const SUBJECTIVE_SLOTS = 1

/** Share of the objective quota reserved for questions that are due now. */
const DUE_SHARE = 0.5
/** Share of the objective quota reserved for questions answered wrong before. */
const WRONG_SHARE = 0.25

export interface PlanInput {
  /** Questions the plan may draw objective picks from. */
  objective: Question[]
  /** Questions the plan may draw the subjective slot from. */
  subjective: Question[]
  records: Map<string, QRecord>
  now: number
  /** Objective questions requested by the user. */
  size: number
  /** Deterministic source; production passes a seeded PRNG or Math.random. */
  rng?: () => number
}

export interface PlanResult {
  questions: Question[]
  /** Counts of each pool, for the honest "how much is left" line. */
  pools: { due: number; wrong: number; fresh: number }
  /** Due questions that did not fit today and will be deferred in FIFO order. */
  deferredDue: number
  /** True when the bank could not supply `size` objective questions. */
  shortfall: number
}

const isDue = (r: QRecord | undefined, now: number): boolean => !!r && r.attempts > 0 && r.nextReviewAt <= now

/**
 * Split the objective bank into the three pools the plan draws from.
 *
 * The pools are mutually exclusive by construction:
 *  - `due`    — attempted and overdue now (highest priority)
 *  - `wrong`  — attempted, has a wrong answer, but is NOT due
 *  - `fresh`  — never attempted (no record, or a record with 0 attempts)
 */
export function planPools(objective: Question[], records: Map<string, QRecord>, now: number) {
  const due: Question[] = []
  const wrong: Question[] = []
  const fresh: Question[] = []
  for (const q of objective) {
    const r = records.get(q.id)
    if (!r || r.attempts === 0) {
      fresh.push(q)
    } else if (isDue(r, now)) {
      due.push(q)
    } else if (r.wrongCount > 0) {
      wrong.push(q)
    }
  }
  return { due, wrong, fresh }
}

/**
 * Order the due pool oldest-first, so an ever-growing backlog drains in order
 * instead of being re-sampled forever. `qid` is the tie-breaker for questions
 * last seen in the same millisecond, keeping the order deterministic.
 */
export function orderDueOldestFirst(due: Question[], records: Map<string, QRecord>): Question[] {
  return due.slice().sort((a, b) => {
    const ra = records.get(a.id)
    const rb = records.get(b.id)
    const sa = ra?.lastSeenAt ?? 0
    const sb = rb?.lastSeenAt ?? 0
    if (sa !== sb) return sa - sb
    // Overdue longer = due earlier; fall back to nextReviewAt, then qid.
    const na = ra?.nextReviewAt ?? 0
    const nb = rb?.nextReviewAt ?? 0
    if (na !== nb) return na - nb
    return a.id.localeCompare(b.id)
  })
}

/**
 * True when a question was already trained during the same calendar day.
 *
 * Used to avoid serving the identical set twice in one day. The window is the
 * local calendar day, not a rolling 24h, because that is how a user thinks about
 * "today's practice".
 */
function trainedToday(rec: QRecord | undefined, now: number): boolean {
  if (!rec || rec.lastSeenAt <= 0) return false
  const day = (t: number) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  }
  return day(rec.lastSeenAt) === day(now)
}

/**
 * Build the daily plan.
 *
 * `size` counts OBJECTIVE questions only. The subjective slot is additional and
 * never takes an objective slot, so the user can always tell the two apart.
 *
 * Quotas: 50% due, 25% wrong, remainder fresh. Unused quota flows back
 * due -> wrong -> fresh, so a category that is exhausted never wastes capacity.
 *
 * Questions already trained today are pushed to the back of their pool, so
 * generating the plan twice in one day does not serve the same set twice. This
 * is a preference, not a hard filter: if a pool has nothing else to offer, its
 * already-trained questions are still used rather than producing an empty plan.
 *
 * When the bank cannot supply `size` objective questions the plan is as long as
 * the bank allows — it never pads with duplicates and never borrows from the
 * subjective slot.
 */
export function buildPlan(input: PlanInput): PlanResult {
  const { objective, subjective, records, now, size } = input
  const rng = input.rng ?? (Math.random as () => number)

  const { due: duePoolRaw, wrong: wrongPoolRaw, fresh: freshPoolRaw } = planPools(objective, records, now)
  const pools = { due: duePoolRaw.length, wrong: wrongPoolRaw.length, fresh: freshPoolRaw.length }

  // Prefer questions not yet trained today, without ever emptying a pool. When
  // EVERY question in the pool was already trained today there is nothing left
  // to rotate to, so the pool is returned unchanged and the plan repeats — the
  // caller is expected to surface that (a repeated plan is honest, a fake one
  // that hides trained questions is not).
  const preferNotTrainedToday = (list: Question[]) => {
    const freshFirst = list.filter((q) => !trainedToday(records.get(q.id), now))
    if (freshFirst.length === 0) return list
    const later = list.filter((q) => trainedToday(records.get(q.id), now))
    return [...freshFirst, ...later]
  }
  const duePool = preferNotTrainedToday(duePoolRaw)
  const wrongPool = preferNotTrainedToday(wrongPoolRaw)
  const freshPool = preferNotTrainedToday(freshPoolRaw)

  const objTarget = Math.max(0, Math.min(size, objective.length))
  const shortfall = Math.max(0, size - objTarget)

  // 50% due, 25% wrong, remainder fresh. `MIN_PER_POOL` only applies while the
  // bank can actually supply it, so a tiny bank is never over-quota'd.
  let dueQuota = Math.min(duePool.length, Math.ceil(objTarget * DUE_SHARE))
  let wrongQuota = Math.min(wrongPool.length, Math.ceil(objTarget * WRONG_SHARE))
  let freshQuota = Math.min(freshPool.length, Math.max(0, objTarget - dueQuota - wrongQuota))

  // Refund unused capacity, in priority order: wrong first (a known failure is
  // more valuable than more new material), then due, then fresh.
  let spare = objTarget - dueQuota - wrongQuota - freshQuota
  if (spare > 0) {
    const extraWrong = Math.min(wrongPool.length - wrongQuota, spare)
    wrongQuota += extraWrong
    spare -= extraWrong
  }
  if (spare > 0) {
    const extraDue = Math.min(duePool.length - dueQuota, spare)
    dueQuota += extraDue
    spare -= extraDue
  }
  if (spare > 0) {
    const extraFresh = Math.min(freshPool.length - freshQuota, spare)
    freshQuota += extraFresh
  }

  const picks: Question[] = []
  const seen = new Set<string>()
  const push = (list: Question[]) => {
    for (const q of list) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        picks.push(q)
      }
    }
  }

  // Due questions are taken oldest-first, but questions already trained today go
  // last so a second plan in one day does not repeat the same work.
  const notToday = duePool.filter((q) => !trainedToday(records.get(q.id), now))
  const today = duePool.filter((q) => trainedToday(records.get(q.id), now))
  const orderedDue = [...orderDueOldestFirst(notToday, records), ...orderDueOldestFirst(today, records)]
  push(orderedDue.slice(0, dueQuota))
  const dueTaken = picks.length
  push(selectQuestions({ pool: wrongPool, records, now, count: wrongQuota, rng: mulberry32(11) }))
  push(selectQuestions({ pool: freshPool, records, now, count: freshQuota, rng: mulberry32(13) }))

  const objectivePicks = picks.slice(0, objTarget)
  // Due questions that did not fit today, deferred to the next plan.
  const deferredDue = Math.max(0, duePool.length - Math.min(dueTaken, objectivePicks.length))

  // One extra subjective question, drawn deterministically. Independent of the
  // objective quota so writing practice is never crowded out.
  let subjectivePicks: Question[] = []
  if (subjective.length > 0) {
    const idx = Math.min(subjective.length - 1, Math.floor(rng() * subjective.length))
    subjectivePicks = [subjective[idx]]
  }

  return {
    questions: [...objectivePicks, ...subjectivePicks],
    pools,
    deferredDue,
    shortfall,
  }
}
