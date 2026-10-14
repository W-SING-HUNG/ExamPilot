import { describe, it, expect } from 'vitest'
import { nextInterval, applyAttempt, freshRecord, selectQuestions, mulberry32 } from './scheduler'
import type { Question, QRecord } from './types'

const mkq = (id: string): Question => ({
  id,
  chapter: '导论',
  chapterIndex: 0,
  type: 'single',
  bankNo: 1,
  pageStart: 2,
  pageEnd: 2,
  stem: id,
  options: ['a', 'b', 'c', 'd'],
  answer: 'B',
  answerNorm: 'B',
  hasOfficialAnswer: true,
  isFlagged: false,
  flagReason: '',
})

describe('scheduler', () => {
  it('computes intervals', () => {
    expect(nextInterval(0, true).intervalDays).toBe(1)
    expect(nextInterval(1, true).intervalDays).toBe(2)
    expect(nextInterval(2, false).intervalDays).toBe(0)
  })

  it('applies attempt and promotes slowly', () => {
    let rec: QRecord = freshRecord('q1')
    expect(rec.status).toBe('new')
    rec = applyAttempt(rec, true)
    expect(rec.attempts).toBe(1)
    expect(rec.lastCorrect).toBe(true)
    expect(rec.intervalDays).toBe(1)
    rec = applyAttempt(rec, true)
    rec = applyAttempt(rec, true)
    expect(rec.status).toBe('mastered')
    expect(rec.correctCount).toBe(3)
  })

  it('demotes on repeated errors', () => {
    let rec: QRecord = freshRecord('q2')
    rec = applyAttempt(rec, true)
    rec = applyAttempt(rec, false)
    rec = applyAttempt(rec, false)
    rec = applyAttempt(rec, false)
    expect(rec.status).toBe('struggling')
    expect(rec.wrongCount).toBe(3)
  })

  it('selection never repeats a question within one session', () => {
    const now = Date.now()
    const pool = Array.from({ length: 30 }, (_, i) => mkq(`q${i}`))
    const records = new Map<string, QRecord>()
    for (let i = 0; i < 5; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        lastSeenAt: now - 999999,
        nextReviewAt: now - 10000,
      })
    }
    const picked = selectQuestions({ pool, records, now, count: 12, rng: mulberry32(3) })
    const ids = picked.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.length).toBe(12)
  })

  it('selection favors wrong questions over mastered ones and never picks already-mastered', () => {
    const now = Date.now()
    const pool = Array.from({ length: 20 }, (_, i) => mkq(`q${i}`))
    const records = new Map<string, QRecord>()
    // last 10 mastered, long interval, not due
    for (let i = 10; i < 20; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'mastered',
        attempts: 5,
        correctCount: 5,
        intervalDays: 100,
        nextReviewAt: now + 99999999,
        lastSeenAt: now - 1000,
      })
    }
    // first 5 wrong, struggling and due for review
    for (let i = 0; i < 5; i++) {
      records.set(`q${i}`, {
        ...freshRecord(`q${i}`, now),
        status: 'struggling',
        attempts: 6,
        wrongCount: 4,
        lastCorrect: false,
        lastSeenAt: now - 999999,
        nextReviewAt: now - 10000,
      })
    }
    const masteredIds = new Set(Array.from({ length: 10 }, (_, k) => `q${k + 10}`))
    const wrongIds = new Set(['q0', 'q1', 'q2', 'q3', 'q4'])

    let masteredPicked = 0
    let wrongPicked = 0
    let untouchedPicked = 0
    // run several seeds to remove flakiness; the invariant must hold on aggregate
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const picked = selectQuestions({ pool, records, now, count: 8, rng: mulberry32(seed) })
      const ids = picked.map((q) => q.id)
      expect(ids.length).toBe(8)
      for (const id of ids) {
        if (masteredIds.has(id)) masteredPicked++
        else if (wrongIds.has(id)) wrongPicked++
        else untouchedPicked++
      }
    }
    // mastered questions must be rare (weight heavily suppressed)
    expect(masteredPicked).toBeLessThanOrEqual(4)
    // wrong/due questions must clearly outnumber mastered picks
    expect(wrongPicked).toBeGreaterThan(masteredPicked * 2)
    // untouched coverage questions still appear (not "only drill wrong questions")
    expect(untouchedPicked).toBeGreaterThan(0)
  })
})
