import { describe, it, expect } from 'vitest'
import { buildPlan, planPools, orderDueOldestFirst, SUBJECTIVE_SLOTS } from './plan'
import { freshRecord, mulberry32 } from './scheduler'
import { objectiveQuestions, subjectiveQuestions, usingSampleBank } from './bank'
import type { Question, QRecord } from './types'

const DAY = 86400000

/** Deterministic, controllable inputs for the plan builder. */
function setup(o: { now?: number; size: number; objective?: Question[]; subjective?: Question[] }) {
  const now = o.now ?? 10 * DAY
  const objective = o.objective ?? objectiveQuestions
  const subjective = o.subjective ?? subjectiveQuestions
  const records = new Map<string, QRecord>()
  return { now, objective, subjective, records, size: o.size }
}

const objOf = (plan: Question[]) => plan.filter((q) => q.type !== 'short' && q.type !== 'material')
const subjOf = (plan: Question[]) => plan.filter((q) => q.type === 'short' || q.type === 'material')

/** Mark questions with a record, in bank order. */
function mark(
  records: Map<string, QRecord>,
  questions: Question[],
  fn: (q: Question, i: number) => Partial<QRecord>,
  now: number,
) {
  questions.forEach((q, i) => {
    records.set(q.id, { ...freshRecord(q.id, now), ...fn(q, i) })
  })
}

describe('plan / pools', () => {
  it('splits the bank into due / wrong / fresh, mutually exclusively', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 30)
    const records = new Map<string, QRecord>()
    mark(records, obj.slice(0, 10), () => ({ attempts: 5, correctCount: 5, nextReviewAt: now - DAY }), now) // due
    mark(
      records,
      obj.slice(10, 20),
      () => ({ attempts: 5, correctCount: 3, wrongCount: 2, nextReviewAt: now + 5 * DAY }),
      now,
    ) // wrong, not due
    mark(records, obj.slice(20, 30), () => ({ attempts: 0, nextReviewAt: now }), now) // fresh
    const { due, wrong, fresh } = planPools(obj, records, now)
    expect(due).toHaveLength(10)
    expect(wrong).toHaveLength(10)
    expect(fresh).toHaveLength(10)
    // No question appears twice.
    const ids = [...due, ...wrong, ...fresh].map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('a due question that was also answered wrong counts as due only', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 5)
    const records = new Map<string, QRecord>()
    mark(records, obj, () => ({ attempts: 5, correctCount: 1, wrongCount: 4, nextReviewAt: now - DAY }), now)
    const { due, wrong } = planPools(obj, records, now)
    expect(due).toHaveLength(5)
    expect(wrong).toHaveLength(0)
  })

  it('orders the due pool oldest-first with a stable tie-break', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 4)
    const records = new Map<string, QRecord>()
    // Intentionally inserted out of order.
    obj.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        attempts: 5,
        lastSeenAt: now - (4 - i) * DAY,
        nextReviewAt: now - DAY,
      })
    })
    const ordered = orderDueOldestFirst(obj, records)
    const seen = ordered.map((q) => records.get(q.id)!.lastSeenAt)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })
})

describe('plan / quota', () => {
  it('T1: a brand-new user gets exactly the requested objective count', () => {
    for (const size of [10, 20, 30, 50]) {
      const s = setup({ size })
      const plan = buildPlan({ ...s, rng: mulberry32(7) })
      expect(objOf(plan.questions)).toHaveLength(size)
      expect(plan.shortfall).toBe(0)
      expect(plan.pools.due).toBe(0)
      expect(plan.pools.wrong).toBe(0)
    }
  })

  it('T1: the subjective slot is extra and does not consume the objective quota', () => {
    const s = setup({ size: 20 })
    const plan = buildPlan({ ...s, rng: mulberry32(7) })
    expect(objOf(plan.questions)).toHaveLength(20)
    expect(subjOf(plan.questions)).toHaveLength(SUBJECTIVE_SLOTS)
    expect(plan.questions).toHaveLength(21)
  })

  it('T2: due questions take up to half the quota and fresh fills the rest', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    // 60 overdue struggling questions.
    mark(
      records,
      obj.slice(0, 60),
      () => ({
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        correctCount: 2,
        lastSeenAt: now - 10 * DAY,
        nextReviewAt: now - 5 * DAY,
      }),
      now,
    )
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 20,
      rng: mulberry32(7),
    })
    const dueInPlan = objOf(plan.questions).filter((q) => {
      const r = records.get(q.id)
      return !!r && r.attempts > 0 && r.nextReviewAt <= now
    }).length
    expect(dueInPlan).toBeGreaterThanOrEqual(10) // ceil(20 * 0.5)
    expect(dueInPlan).toBeLessThanOrEqual(20)
    expect(plan.pools.fresh).toBeGreaterThan(0)
  })

  it('T12: when due questions overflow the quota they are deferred, not dropped silently', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    mark(
      records,
      obj.slice(0, 500),
      (_, i) => ({
        status: 'learning',
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: now - 20 * DAY,
        nextReviewAt: now - (i + 1) * DAY,
      }),
      now,
    )
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 20,
      rng: mulberry32(7),
    })
    const objPicks = objOf(plan.questions)
    // The due quota (50% of 20) is filled by the oldest overdue questions.
    expect(objPicks).toHaveLength(20)
    const dueInPlan = objPicks.filter((q) => (records.get(q.id)?.nextReviewAt ?? Infinity) <= now).length
    expect(dueInPlan).toBe(10)
    // Everything else is reported as deferred, and the page can say so.
    expect(plan.deferredDue).toBe(500 - 10)
    expect(plan.pools.due).toBe(500)
    expect(plan.pools.fresh).toBeGreaterThan(0)
  })

  it('T12: the backlog drains oldest-first', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions.slice(0, 12)
    const records = new Map<string, QRecord>()
    obj.forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        attempts: 4,
        lastSeenAt: now - (12 - i) * DAY,
        nextReviewAt: now - DAY,
      })
    })
    const plan = buildPlan({ objective: obj, subjective: [], records, now, size: 5, rng: mulberry32(7) })
    const pickedAges = objOf(plan.questions).map((q) => records.get(q.id)!.lastSeenAt)
    expect(pickedAges).toEqual([...pickedAges].sort((a, b) => a - b))
  })

  it('T13: when nothing is due and nothing is fresh the plan is subjective only', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    mark(
      records,
      obj,
      () => ({
        status: 'mastered',
        attempts: 6,
        correctCount: 6,
        intervalDays: 90,
        lastSeenAt: now - 90 * DAY,
        nextReviewAt: now + 90 * DAY,
      }),
      now,
    )
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 20,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(0)
    expect(subjOf(plan.questions)).toHaveLength(1)
    expect(plan.pools.due).toBe(0)
    expect(plan.pools.fresh).toBe(0)
  })

  it('T14: an empty subjective bank yields no subjective slot and no error', () => {
    const s = setup({ size: 10, subjective: [] })
    const plan = buildPlan({ ...s, rng: mulberry32(7) })
    expect(subjOf(plan.questions)).toHaveLength(0)
    expect(objOf(plan.questions)).toHaveLength(10)
  })

  it('refunds unused quota instead of wasting capacity', () => {
    const now = 10 * DAY
    const obj = objectiveQuestions
    const records = new Map<string, QRecord>()
    // 100 due, 0 wrong, plenty fresh -> wrong quota flows to due then fresh.
    mark(
      records,
      obj.slice(0, 100),
      () => ({
        status: 'learning',
        attempts: 4,
        correctCount: 3,
        wrongCount: 1,
        lastSeenAt: now - DAY,
        nextReviewAt: now - DAY,
      }),
      now,
    )
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records,
      now,
      size: 30,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(30)
    expect(plan.shortfall).toBe(0)
  })
})

describe('plan / small bank', () => {
  it('T7: never exceeds the bank and never duplicates', () => {
    const obj = objectiveQuestions.slice(0, 14)
    const plan = buildPlan({
      objective: obj,
      subjective: subjectiveQuestions,
      records: new Map(),
      now: 10 * DAY,
      size: 50,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(14)
    expect(plan.questions).toHaveLength(15) // + 1 subjective
    expect(plan.shortfall).toBe(36)
    const ids = plan.questions.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('T7: a tiny bank still produces a non-empty plan', () => {
    const obj = objectiveQuestions.slice(0, 3)
    const plan = buildPlan({
      objective: obj,
      subjective: [],
      records: new Map(),
      now: 10 * DAY,
      size: 10,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(3)
    expect(plan.shortfall).toBe(7)
  })
})

describe('plan / scale', () => {
  const withFullBank = () => {
    // Uses whatever bank is installed: the public sample bank in CI, the
    // licensed full bank locally. Assertions below are size-relative.
    const now = 10 * DAY
    return { objective: objectiveQuestions, subjective: subjectiveQuestions, records: new Map<string, QRecord>(), now }
  }

  it('T8: the plan is built from the installed bank without error', () => {
    const s = withFullBank()
    const plan = buildPlan({ ...s, size: 20, rng: mulberry32(7) })
    expect(objOf(plan.questions).length).toBe(Math.min(20, s.objective.length))
  })

  it('T8: builds quickly enough to run on every render', () => {
    const s = withFullBank()
    const t0 = Date.now()
    for (let i = 0; i < 5; i++) buildPlan({ ...s, size: 50, rng: mulberry32(i) })
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('plan / determinism', () => {
  it('the same inputs and seed produce the same plan', () => {
    const mk = () => {
      const now = 10 * DAY
      const records = new Map<string, QRecord>()
      mark(
        records,
        objectiveQuestions.slice(0, 40),
        (_, i) => ({
          attempts: 4,
          correctCount: 3,
          wrongCount: 1,
          lastSeenAt: now - DAY,
          nextReviewAt: i < 10 ? now - DAY : now + 5 * DAY,
        }),
        now,
      )
      return { objective: objectiveQuestions, subjective: subjectiveQuestions, records, now, size: 20 }
    }
    const a = buildPlan({ ...mk(), rng: mulberry32(7) })
    const b = buildPlan({ ...mk(), rng: mulberry32(7) })
    expect(a.questions.map((q) => q.id)).toEqual(b.questions.map((q) => q.id))
  })

  it('T6: a second plan on the same day serves questions not yet trained today', () => {
    // 20 overdue questions; the first 10 were trained EARLIER TODAY, the other
    // 10 have not. The second plan must prefer the untrained ones.
    const now = 10 * DAY
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const earlierToday = startOfToday.getTime() + 3600_000 // 01:00 today
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 20).forEach((q, i) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        status: 'struggling',
        attempts: 5,
        wrongCount: 4,
        correctCount: 1,
        lastSeenAt: i < 10 ? earlierToday : now - 5 * DAY,
        nextReviewAt: now - 60_000,
      })
    })
    const trainedTodayIds = new Set(objectiveQuestions.slice(0, 10).map((q) => q.id))
    const args = { objective: objectiveQuestions, subjective: [], records, now, size: 10 }
    const plan = buildPlan({ ...args, rng: mulberry32(7) })
    const picks = objOf(plan.questions)
    expect(picks).toHaveLength(10)
    // None of the questions already trained today are re-served.
    expect(picks.filter((q) => trainedTodayIds.has(q.id))).toHaveLength(0)
  })

  it('T6: when every due question was already trained today the plan still fills up', () => {
    // Honest fallback: nothing left to rotate to, so the plan repeats rather
    // than shrinking to nothing.
    const now = 10 * DAY
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const records = new Map<string, QRecord>()
    objectiveQuestions.slice(0, 10).forEach((q) => {
      records.set(q.id, {
        ...freshRecord(q.id, now),
        status: 'struggling',
        attempts: 5,
        wrongCount: 4,
        correctCount: 1,
        lastSeenAt: startOfToday.getTime() + 3600_000,
        nextReviewAt: now - 60_000,
      })
    })
    const plan = buildPlan({
      objective: objectiveQuestions,
      subjective: [],
      records,
      now,
      size: 10,
      rng: mulberry32(7),
    })
    expect(objOf(plan.questions)).toHaveLength(10)
  })

  it('reports whether the demo or the full bank is in use', () => {
    expect(typeof usingSampleBank).toBe('boolean')
  })
})
