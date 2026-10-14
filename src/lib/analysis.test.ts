import { describe, it, expect } from 'vitest'
import { bank, allQuestions, objectiveQuestions, usingSampleBank } from './bank'
import type { QRecord } from './types'
import { freshRecord, applyAttempt } from './scheduler'

/**
 * Tests for the PUBLIC sample bank.
 *
 * These assertions must hold for any valid bank (sample or full), so they are
 * structural rather than size-specific. Full-bank-specific validation lives in
 * `src/lib/bank.local.test.ts`, which is git-ignored and only runs locally.
 */
describe('sample bank integrity', () => {
  it('ships a non-empty demo bank', () => {
    expect(allQuestions.length).toBeGreaterThan(0)
    expect(bank.chapterOrder.length).toBeGreaterThan(0)
  })

  it('has unique question ids', () => {
    expect(new Set(allQuestions.map((q) => q.id)).size).toBe(allQuestions.length)
  })

  it('countsByType matches the actual questions', () => {
    for (const [type, n] of Object.entries(bank.countsByType)) {
      const actual = allQuestions.filter((q) => q.type === type).length
      expect(actual, `type ${type}`).toBe(n)
    }
  })

  it('covers all five question types', () => {
    for (const t of ['single', 'multi', 'judge', 'short', 'material']) {
      expect(
        allQuestions.some((q) => q.type === t),
        t,
      ).toBe(true)
    }
  })

  it('objective questions all have answers and options', () => {
    for (const q of objectiveQuestions) {
      expect(q.hasOfficialAnswer, q.id).toBe(true)
      if (q.type === 'single' || q.type === 'multi') {
        expect(q.options.length, q.id).toBeGreaterThanOrEqual(2)
        const letters = String(q.answerNorm).split('')
        expect(
          letters.every((l) => l.charCodeAt(0) - 65 < q.options.length),
          q.id,
        ).toBe(true)
      }
    }
  })

  it('multi answers have at least two letters', () => {
    for (const q of allQuestions.filter((x) => x.type === 'multi')) {
      expect(String(q.answerNorm).length, q.id).toBeGreaterThanOrEqual(2)
    }
  })

  it('subjective questions have no fabricated official answers', () => {
    for (const q of allQuestions.filter((x) => x.type === 'short' || x.type === 'material')) {
      expect(q.hasOfficialAnswer, q.id).toBe(false)
      expect(q.answerNorm, q.id).toBe(null)
    }
  })

  it('every question has PDF page traceability', () => {
    for (const q of allQuestions) {
      expect(q.pageStart, q.id).toBeGreaterThan(0)
      expect(q.pageEnd ?? q.pageStart!, q.id).toBeGreaterThanOrEqual(q.pageStart!)
    }
  })

  it('judge answers are boolean-normalized', () => {
    for (const q of allQuestions.filter((x) => x.type === 'judge')) {
      expect(typeof q.answerNorm, q.id).toBe('boolean')
    }
  })

  it('reports whether the demo bank is in use', () => {
    expect(typeof usingSampleBank).toBe('boolean')
  })
})

describe('analysis (sample bank)', () => {
  const recs = (ids: string[], fn: (r: QRecord) => QRecord) => new Map(ids.map((id) => [id, fn(freshRecord(id))]))

  it('reports zero coverage when nothing attempted', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.overall.attempted).toBe(0)
    expect(d.overall.coverage).toBe(0)
    expect(d.overall.correctRate).toBe(0)
  })

  it('computes correct rate from real attempts only', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const some = objectiveQuestions.slice(0, 4)
    const d = computeDiagnosis(
      allQuestions,
      recs(
        some.map((q) => q.id),
        (r) => applyAttempt(r, true),
      ),
    )
    expect(d.overall.attempted).toBe(4)
    expect(d.overall.correctRate).toBe(1)
    expect(d.overall.wrong).toBe(0)
  })

  it('does not count blank/unattempted as mastered', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const some = objectiveQuestions.slice(0, 4)
    const d = computeDiagnosis(
      allQuestions,
      recs(
        some.map((q) => q.id),
        (r) => r,
      ),
    )
    expect(d.overall.attempted).toBe(0)
    expect(d.overall.ourMastered).toBe(0)
    expect(d.overall.coverage).toBe(0)
  })

  it('type stats cover all five types', async () => {
    const { computeDiagnosis } = await import('./analysis')
    const d = computeDiagnosis(allQuestions, new Map())
    expect(d.types.map((t) => t.type)).toEqual(['single', 'multi', 'judge', 'short', 'material'])
    expect(d.types.reduce((s, t) => s + t.total, 0)).toBe(allQuestions.length)
  })
})
