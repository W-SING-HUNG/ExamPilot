import { describe, it, expect } from 'vitest'
import {
  parseExport,
  planImport,
  diffImport,
  describePlan,
  checkBank,
  makeExportPayload,
  serialize,
  bankFingerprint,
  sha256,
  validateSettings,
  type ExistingData,
} from './io'
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

const SETTINGS = { theme: 'dark' as const, reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 }

const payload = (over: Partial<ReturnType<typeof makeExportPayload>> = {}) => ({
  ...makeExportPayload({
    settings: SETTINGS,
    records: [mkre('q1', 1)],
    history: [mkhist('h1', 'q1')],
    mocks: [mkmock('m1')],
    aiReviews: [mkai('a1', 'q1')],
    bankFingerprint: 'fp',
    bankCount: 1,
  }),
  ...over,
})

const emptyExisting: ExistingData = { records: [], history: [], mocks: [], aiReviews: [], settings: null }

describe('io / sha256', () => {
  it('matches known vectors', () => {
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    )
  })
  it('handles multi-byte UTF-8 deterministically', () => {
    expect(sha256('中国特色社会主义')).toBe(sha256('中国特色社会主义'))
    expect(sha256('中国特色社会主义')).not.toBe(sha256('中国特色社会主'))
  })
})

describe('io / bankFingerprint (SHA-256 over full bank identity)', () => {
  const mkBank = (ids: string[], answers: Record<string, string> = {}, type: Question['type'] = 'single'): BankData =>
    ({
      schema: 'examPilot.bank.v1',
      source: 'x',
      generatedAt: '',
      chapterOrder: ['导论'],
      countsByType: {},
      questions: ids.map((id): Question => ({
        id,
        chapter: '导论',
        chapterIndex: 0,
        type,
        bankNo: 1,
        pageStart: 1,
        pageEnd: 1,
        stem: `stem-${id}`,
        options: ['a', 'b', 'c', 'd'],
        answer: answers[id] ?? 'A',
        answerNorm: answers[id] ?? 'A',
        hasOfficialAnswer: true,
        isFlagged: false,
        flagReason: '',
      })),
    }) as unknown as BankData

  it('is a 64-char hex SHA-256', () => {
    expect(bankFingerprint(mkBank(['a', 'b']))).toMatch(/^[0-9a-f]{64}$/)
  })

  it('REGRESSION: changes when an answer changes but the id stays the same', () => {
    const before = bankFingerprint(mkBank(['q1', 'q2', 'q3']))
    const after = bankFingerprint(mkBank(['q1', 'q2', 'q3'], { q2: 'D' }))
    expect(after).not.toBe(before)
  })

  it('REGRESSION: changes when only the LAST question changes (no truncation)', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`)
    const before = bankFingerprint(mkBank(ids))
    expect(bankFingerprint(mkBank(ids, { q39: 'C' }))).not.toBe(before)
  })

  it('changes when only the last question is appended', () => {
    const ids = Array.from({ length: 40 }, (_, i) => `q${i}`)
    const before = bankFingerprint(mkBank(ids))
    expect(bankFingerprint(mkBank([...ids, 'q40']))).not.toBe(before)
  })

  it('changes when options change for the same id and answer', () => {
    const a = mkBank(['q1'])
    const b = mkBank(['q1'])
    b.questions[0].options = ['a', 'b', 'c', 'e']
    expect(bankFingerprint(b)).not.toBe(bankFingerprint(a))
  })

  it('changes when the question type changes', () => {
    expect(bankFingerprint(mkBank(['a'], {}, 'single'))).not.toBe(bankFingerprint(mkBank(['a'], {}, 'multi')))
  })

  it('is stable for identical banks', () => {
    const ids = ['a', 'b', 'c']
    expect(bankFingerprint(mkBank(ids))).toBe(bankFingerprint(mkBank(ids)))
  })
})

describe('io / parseExport strictness', () => {
  it('rejects malformed JSON', () => {
    const r = parseExport('not json')
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('JSON'))).toBe(true)
  })
  it('rejects an unknown schema', () => {
    const r = parseExport(JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]).toMatch(/不支持的备份格式/)
  })
  it('rejects missing arrays', () => {
    const r = parseExport(JSON.stringify({ schema: 'exampilot.export.v1', records: 'nope' }))
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/records/)
    expect(r.errors.join(';')).toMatch(/history/)
  })
  it('rejects duplicate ids in every collection', () => {
    expect(parseExport(serialize(payload({ records: [mkre('q1', 1), mkre('q1', 2)] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ history: [mkhist('h1', 'q1'), mkhist('h1', 'q2')] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ mocks: [mkmock('m1'), mkmock('m1')] }))).ok).toBe(false)
    expect(parseExport(serialize(payload({ aiReviews: [mkai('a1', 'q1'), mkai('a1', 'q2')] }))).ok).toBe(false)
  })
  it('warns (not fails) when the bank fingerprint is absent', () => {
    const p = payload() as Record<string, unknown>
    delete p.bankFingerprint
    const r = parseExport(JSON.stringify(p))
    expect(r.ok).toBe(true)
    expect(r.warnings.join(';')).toMatch(/bankFingerprint|指纹/)
  })
  it('round-trips a valid payload with all five collections', () => {
    const r = parseExport(serialize(payload()))
    expect(r.ok).toBe(true)
    expect(r.payload?.records).toHaveLength(1)
    expect(r.payload?.settings).toEqual(SETTINGS)
  })
})

describe('io / validation of nested and malformed rows', () => {
  const parse1 = (over: Record<string, unknown>) => parseExport(JSON.stringify({ ...payload(), ...over }))

  it('rejects records with an invalid status', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), status: 'bogus' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/status/)
  })
  it('rejects records with negative counters', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), attempts: -1 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/attempts/)
  })
  it('rejects records where correct+wrong exceeds attempts', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), attempts: 1, correctCount: 5, wrongCount: 5 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/不得超过 attempts/)
  })
  it('rejects records with a null qid', () => {
    const r = parse1({ records: [{ ...mkre('q1', 1), qid: null }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/qid/)
  })
  it('rejects history with a non-boolean isCorrect', () => {
    const r = parse1({ history: [{ ...mkhist('h1', 'q1'), isCorrect: 'yes' }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/isCorrect/)
  })
  it('rejects mocks whose config is incomplete', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), config: { singleCount: 1 } }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/config\./)
  })
  it('rejects mocks whose score exceeds maxScore', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), score: 99, maxScore: 1 }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/score 不得超过 maxScore/)
  })
  it('rejects mocks whose perQuestion entry lacks unanswered', () => {
    const r = parse1({ mocks: [{ ...mkmock('m1'), perQuestion: { q1: { isCorrect: true, points: 1 } } }] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/unanswered/)
  })
  it('rejects AI reviews with an out-of-range score', () => {
    const bad = { ...mkai('a1', 'q1'), result: { ...mkai('a1', 'q1').result, score: 150 } }
    const r = parse1({ aiReviews: [bad] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/result\.score/)
  })
  it('rejects AI reviews whose result arrays contain non-strings', () => {
    const bad = { ...mkai('a1', 'q1'), result: { ...mkai('a1', 'q1').result, hitPoints: [1, 2] } }
    const r = parse1({ aiReviews: [bad] })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/result\.hitPoints/)
  })
  it('rejects settings with an invalid theme', () => {
    const r = parse1({ settings: { ...SETTINGS, theme: 'neon' } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/theme/)
  })
  it('rejects settings with out-of-range numbers', () => {
    const r = parse1({ settings: { ...SETTINGS, reviewIntervalBase: 0 } })
    expect(r.ok).toBe(false)
    expect(r.errors.join(';')).toMatch(/reviewIntervalBase/)
  })
  it('reports a problem count and imports nothing', () => {
    const r = parse1({ records: [{ qid: '' }, { qid: '' }] })
    expect(r.ok).toBe(false)
    expect(r.invalidCount).toBeGreaterThan(0)
    expect(r.payload).toBeUndefined()
  })
})

describe('io / validateSettings', () => {
  it('returns null for absent settings (allowed)', () => {
    expect(validateSettings(undefined)).toBe(null)
    expect(validateSettings(null)).toBe(null)
  })
  it('returns the normalized object for valid settings', () => {
    expect(validateSettings(SETTINGS)).toEqual(SETTINGS)
  })
  it('returns null and records issues for invalid settings', () => {
    const issues: { path: string; message: string }[] = []
    expect(validateSettings({ theme: 'x' }, 'settings', issues)).toBe(null)
    expect(issues.length).toBeGreaterThan(0)
  })
})

describe('io / checkBank', () => {
  it('reports match for an identical fingerprint', () => {
    expect(checkBank(payload({ bankFingerprint: 'abc' }), 'abc', 1, new Set(['q1'])).status).toBe('match')
  })
  it('reports mismatch for a different fingerprint', () => {
    const c = checkBank(payload({ bankFingerprint: 'abc' }), 'xyz', 99, new Set(['q1']))
    expect(c.status).toBe('mismatch')
    expect(c.message).toMatch(/不一致/)
  })
  it('reports unknown for a legacy backup without a fingerprint', () => {
    const p = payload() as Record<string, unknown>
    delete p.bankFingerprint
    const c = checkBank(p as never, 'xyz', 99, new Set(['q1']))
    expect(c.status).toBe('unknown')
    expect(c.message).toMatch(/旧版/)
  })
  it('counts rows that cannot be matched to any current question', () => {
    const p = payload({
      records: [mkre('q1', 1), mkre('ghost', 1)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'ghost')],
    })
    const c = checkBank(p, 'fp', 1, new Set(['q1']))
    expect(c.unmatchedRecords).toBe(1)
    expect(c.unmatchedHistory).toBe(1)
  })
  it('counts mocks referencing unknown questions', () => {
    const mock = { ...mkmock('m1'), submissions: { ghost: 'A' } }
    expect(checkBank(payload({ mocks: [mock] }), 'fp', 1, new Set(['q1'])).mocksWithUnmatchedQuestions).toBe(1)
  })
})

describe('io / planImport strategies and settings semantics', () => {
  it('replace returns exactly the backup contents', () => {
    const plan = planImport(payload(), 'replace', {
      records: [mkre('old', 9)],
      history: [mkhist('old', 'old')],
      mocks: [mkmock('old')],
      aiReviews: [mkai('old', 'old')],
      settings: SETTINGS,
    })
    expect(plan.records.map((r) => r.qid)).toEqual(['q1'])
    expect(plan.history.map((h) => h.id)).toEqual(['h1'])
    expect(plan.mocks.map((m) => m.id)).toEqual(['m1'])
    expect(plan.aiReviews.map((a) => a.id)).toEqual(['a1'])
  })

  it('merge unions collections and lets the backup win on conflict', () => {
    const plan = planImport(payload({ records: [mkre('q1', 5)] }), 'merge', {
      records: [mkre('q1', 1), mkre('q2', 2)],
      history: [mkhist('h1', 'q1'), mkhist('h2', 'q2')],
      mocks: [mkmock('m1')],
      aiReviews: [mkai('a1', 'q1')],
      settings: SETTINGS,
    })
    expect(plan.records).toHaveLength(2)
    expect(plan.records.find((r) => r.qid === 'q1')?.attempts).toBe(5)
    expect(plan.history).toHaveLength(2)
  })

  it('REGRESSION (settings): replace with a settings-less backup reports NOT written', () => {
    const p = payload() as Record<string, unknown>
    delete p.settings
    const plan = planImport(p as never, 'replace', { ...emptyExisting, settings: SETTINGS })
    expect(plan.settingsWritten).toBe(false)
    expect(plan.settings).toBe(null)
    expect(describePlan(plan, 'replace').join(';')).toMatch(/重置为默认值/)
  })

  it('replace with valid settings writes them', () => {
    const plan = planImport(payload(), 'replace', { ...emptyExisting, settings: { ...SETTINGS, theme: 'light' } })
    expect(plan.settingsWritten).toBe(true)
    expect(plan.settings?.theme).toBe('dark')
    expect(describePlan(plan, 'replace').join(';')).toMatch(/使用备份中的设置/)
  })

  it('merge without backup settings keeps the existing settings', () => {
    const p = payload() as Record<string, unknown>
    delete p.settings
    const plan = planImport(p as never, 'merge', { ...emptyExisting, settings: SETTINGS })
    expect(plan.settingsWritten).toBe(false)
    expect(describePlan(plan, 'merge').join(';')).toMatch(/保持当前设置不变/)
  })

  it('describePlan states the mode explicitly', () => {
    expect(describePlan(planImport(payload(), 'replace', emptyExisting), 'replace').join(';')).toMatch(/替换/)
    expect(describePlan(planImport(payload(), 'merge', emptyExisting), 'merge').join(';')).toMatch(/合并/)
  })
})

describe('io / diffImport', () => {
  it('counts added vs updated rows and rows destroyed by replace', () => {
    const d = diffImport(
      payload({ records: [mkre('q1', 1), mkre('q3', 1)], history: [mkhist('h1', 'q1'), mkhist('h9', 'q9')] }),
      'replace',
      {
        records: [mkre('q1', 1), mkre('q2', 1)],
        history: [mkhist('h1', 'q1')],
        mocks: [],
        aiReviews: [],
        settings: SETTINGS,
      },
    )
    expect(d.records.incoming).toBe(2)
    expect(d.records.added).toBe(1)
    expect(d.records.updated).toBe(1)
    expect(d.history.added).toBe(1)
    expect(d.clearedInReplace).toBe(3)
  })

  it('reports clearedInReplace as 0 in merge mode', () => {
    expect(diffImport(payload(), 'merge', emptyExisting).clearedInReplace).toBe(0)
  })

  it('flags a settings change only when the values actually differ', () => {
    expect(diffImport(payload(), 'merge', { ...emptyExisting, settings: SETTINGS }).settingsChanged).toBe(false)
    expect(
      diffImport(payload(), 'merge', { ...emptyExisting, settings: { ...SETTINGS, theme: 'light' } }).settingsChanged,
    ).toBe(true)
  })
})
