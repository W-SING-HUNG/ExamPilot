import { describe, it, expect } from 'vitest'
import { parseExport, planImport, describePlan, makeExportPayload, serialize, bankFingerprint } from './io'
import type { QRecord, HistoryEntry, MockRun, AiReview, BankData, Question } from './types'

const mkre = (qid: string, i: number): QRecord => ({
  qid,
  status: 'learning',
  attempts: i,
  correctCount: i,
  wrongCount: 0,
  lastSeenAt: 1,
  lastCorrect: true,
  lastAnswer: 'B',
  intervalDays: 1,
  ease: 2,
  nextReviewAt: 1,
})

const mkhist = (id: string, qid: string): HistoryEntry => ({
  id,
  qid,
  mode: 'practice',
  sessionId: 's',
  answer: 'B',
  isCorrect: true,
  submittedAt: 1,
  usedAI: false,
})

const mkmock = (id: string): MockRun => ({
  id,
  startedAt: 1,
  endedAt: 2,
  config: {
    singleCount: 1,
    multiCount: 0,
    judgeCount: 0,
    shortCount: 0,
    singleScore: 1,
    multiScore: 2,
    judgeScore: 1,
    shortScore: 15,
    durationMin: 10,
    chapters: 'all',
  },
  submissions: {},
  graded: true,
  score: 1,
  maxScore: 1,
  objectiveMaxScore: 1,
  subjectiveMaxScore: 0,
  perQuestion: {},
})

const mkai = (id: string, qid: string): AiReview => ({
  id,
  qid,
  userAnswer: 'x',
  createdAt: 1,
  provider: 'stub',
  model: 'm',
  result: {
    score: 80,
    maxScore: 100,
    hitPoints: [],
    missedPoints: [],
    deductions: [],
    suggestions: [],
    structureNote: '',
    disclaimer: '',
  },
})

const payload = (over: Partial<ReturnType<typeof makeExportPayload>> = {}) => ({
  ...makeExportPayload({
    settings: { theme: 'dark' },
    records: [mkre('q1', 1)],
    history: [mkhist('h1', 'q1')],
    mocks: [mkmock('m1')],
    aiReviews: [mkai('a1', 'q1')],
    bankFingerprint: 'fp',
    bankCount: 1,
  }),
  ...over,
})

describe('io / parseExport strictness', () => {
  it('rejects malformed JSON', () => {
    const r = parseExport('not json')
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('JSON'))).toBe(true)
  })

  it('rejects an unknown schema instead of guessing', () => {
    const r = parseExport(JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/不支持的备份格式/)
  })

  it('rejects a payload with missing arrays (no silent partial import)', () => {
    const r = parseExport(JSON.stringify({ schema: 'exampilot.export.v1', records: 'nope' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/records/)
    expect(r.errors.join(';')).toMatch(/history/)
  })

  it('detects duplicate ids in every collection', () => {
    const dupRec = parseExport(serialize(payload({ records: [mkre('q1', 1), mkre('q1', 2)] })))
    expect(dupRec.ok).toBe(false)
    expect(dupRec.errors.join(';')).toMatch(/重复 qid/)

    const dupHist = parseExport(serialize(payload({ history: [mkhist('h1', 'q1'), mkhist('h1', 'q2')] })))
    expect(dupHist.ok).toBe(false)
    expect(dupHist.errors.join(';')).toMatch(/重复 id/)

    const dupMock = parseExport(serialize(payload({ mocks: [mkmock('m1'), mkmock('m1')] })))
    expect(dupMock.ok).toBe(false)
    expect(dupMock.errors.join(';')).toMatch(/重复 id/)
  })

  it('warns (not fails) when the bank fingerprint is absent', () => {
    const p = payload() as Record<string, unknown>
    delete p.bankFingerprint
    const r = parseExport(JSON.stringify(p))
    expect(r.ok).toBe(true)
    expect(r.warnings.join(';')).toMatch(/bankFingerprint/)
  })

  it('round-trips a valid payload with all five collections', () => {
    const r = parseExport(serialize(payload()))
    expect(r.ok).toBe(true)
    expect(r.payload?.records).toHaveLength(1)
    expect(r.payload?.history).toHaveLength(1)
    expect(r.payload?.mocks).toHaveLength(1)
    expect(r.payload?.aiReviews).toHaveLength(1)
    expect(r.payload?.settings).toEqual({ theme: 'dark' })
  })
})

describe('io / bankFingerprint', () => {
  const mkBank = (ids: string[], type: Question['type'] = 'single'): BankData =>
    ({
      schema: 'examPilot.bank.v1',
      source: 'x',
      generatedAt: '',
      chapterOrder: ['导论'],
      countsByType: {},
      questions: ids.map((id) => ({
        id,
        chapter: '导论',
        chapterIndex: 0,
        type,
        bankNo: 1,
        pageStart: 1,
        pageEnd: 1,
        stem: 's',
        options: ['a', 'b'],
        answer: 'A',
        answerNorm: 'A',
        hasOfficialAnswer: true,
        isFlagged: false,
        flagReason: '',
      })),
    }) as unknown as BankData

  it('changes when the question set changes', () => {
    const a = bankFingerprint(mkBank(['a', 'b']))
    const b = bankFingerprint(mkBank(['a', 'c']))
    const c = bankFingerprint(mkBank(['a', 'b', 'c']))
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  it('is stable for identical banks', () => {
    expect(bankFingerprint(mkBank(['a', 'b']))).toBe(bankFingerprint(mkBank(['a', 'b'])))
  })

  it('changes when question types change', () => {
    expect(bankFingerprint(mkBank(['a'], 'single'))).not.toBe(bankFingerprint(mkBank(['a'], 'multi')))
  })
})

describe('io / planImport strategies', () => {
  it('replace mode returns exactly the payload contents (clear-then-write)', () => {
    const plan = planImport(payload(), 'replace', {
      records: [mkre('old', 9)],
      history: [mkhist('old', 'old')],
      mocks: [mkmock('old')],
      aiReviews: [mkai('old', 'old')],
    })
    expect(plan.records.map((r) => r.qid)).toEqual(['q1'])
    expect(plan.history.map((h) => h.id)).toEqual(['h1'])
    expect(plan.mocks.map((m) => m.id)).toEqual(['m1'])
    expect(plan.aiReviews.map((a) => a.id)).toEqual(['a1'])
  })

  it('merge mode unions collections and lets the payload win on conflict', () => {
    const plan = planImport(payload({ records: [mkre('q1', 5)] }), 'merge', {
      records: [mkre('q1', 1), mkre('q2', 2)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'q2')],
      mocks: [mkmock('m1')],
      aiReviews: [mkai('a1', 'q1')],
    })
    expect(plan.records).toHaveLength(2)
    expect(plan.records.find((r) => r.qid === 'q1')?.attempts).toBe(5) // payload wins
    expect(plan.history).toHaveLength(2)
    expect(plan.mocks).toHaveLength(1)
    expect(plan.aiReviews).toHaveLength(1)
  })

  it('reports dropped invalid entries instead of silently discarding them', () => {
    const bad = payload({
      records: [{ qid: '' } as QRecord, mkre('q1', 1)],
      history: [{ id: 'h1' } as HistoryEntry],
    })
    const plan = planImport(bad, 'replace')
    expect(plan.records).toHaveLength(1)
    expect(plan.history).toHaveLength(0)
    expect(plan.dropped.length).toBe(2)
    expect(describePlan(plan, 'replace').join(';')).toMatch(/已丢弃 2 条/)
  })

  it('describePlan states the mode explicitly', () => {
    expect(describePlan(planImport(payload(), 'replace'), 'replace').join(';')).toMatch(/替换/)
    expect(describePlan(planImport(payload(), 'merge'), 'merge').join(';')).toMatch(/合并/)
  })
})
