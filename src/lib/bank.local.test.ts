import { describe, it, expect } from 'vitest'
import { allQuestions, objectiveQuestions, bank, usingSampleBank } from './bank'

/**
 * LOCAL-ONLY full-bank validation.
 * This file is git-ignored (`*.local.test.ts`) and never enters the public repo.
 *
 * It runs only when a full course bank is installed via `npm run bank:local`,
 * and re-checks the specific expectations for the licensed 1000-question bank.
 */
const maybeDescribe = usingSampleBank ? describe.skip : describe

maybeDescribe('full bank integrity (local only)', () => {
  it('is the licensed full bank, not the demo bank', () => {
    expect(usingSampleBank).toBe(false)
  })

  it('has 1000 questions with unique ids', () => {
    expect(allQuestions.length).toBe(1000)
    expect(new Set(allQuestions.map((q) => q.id)).size).toBe(1000)
  })

  it('has expected type counts', () => {
    const c = bank.countsByType
    expect(c.single).toBe(414)
    expect(c.multi).toBe(257)
    expect(c.judge).toBe(262)
    expect(c.short).toBe(32)
    expect(c.material).toBe(35)
  })

  it('chapter numbers are contiguous from 1 within each chapter', () => {
    const byCh = new Map<string, number[]>()
    for (const q of objectiveQuestions) {
      const arr = byCh.get(q.chapter) ?? []
      arr.push(q.bankNo)
      byCh.set(q.chapter, arr)
    }
    for (const [ch, nums] of byCh) {
      const sorted = nums.slice().sort((a, b) => a - b)
      expect(sorted[0], ch).toBe(1)
      for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1], ch).toBe(1)
    }
  })

  it('objective questions pass stem-option-answer binding', () => {
    for (const q of objectiveQuestions) {
      expect(q.isFlagged, q.id).toBe(false)
      expect(q.answerNorm, q.id).not.toBe(null)
      if (q.type === 'single' || q.type === 'multi') {
        const letters = String(q.answerNorm).split('')
        expect(letters.length, q.id).toBeGreaterThan(0)
        for (const l of letters) {
          expect(l.charCodeAt(0) - 65, `${q.id} letter ${l}`).toBeLessThan(q.options.length)
        }
      }
    }
  })

  it('subjective questions are all flagged as having no official answer', () => {
    const subj = allQuestions.filter((q) => q.type === 'short' || q.type === 'material')
    expect(subj.length).toBe(67)
    for (const q of subj) {
      expect(q.hasOfficialAnswer, q.id).toBe(false)
      expect(q.isFlagged, q.id).toBe(true)
    }
  })
})
