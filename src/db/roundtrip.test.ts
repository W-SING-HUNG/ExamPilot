import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { createDb, restoreBackupInto, snapshotDb, DEFAULT_SETTINGS, type ExamPilotDB } from './database'
import { makeExportPayload, parseExport, serialize, planImport, bankFingerprint } from '../lib/io'
import type { QRecord, HistoryEntry, MockRun, AiReview, BankData, Question, AppSettings } from '../lib/types'

/** Read settings from a SPECIFIC database instance (the app's readSettings targets the singleton). */
async function readSettingsOf(target: ExamPilotDB): Promise<AppSettings> {
  const row = await target.settings.get('main')
  return row
    ? {
        theme: row.theme,
        reviewIntervalBase: row.reviewIntervalBase,
        studyTarget: row.studyTarget,
        dailyGoalQuestions: row.dailyGoalQuestions,
      }
    : { ...DEFAULT_SETTINGS }
}

/**
 * REAL IndexedDB round-trip test (via fake-indexeddb, which implements the
 * IndexedDB spec). Each test uses its OWN database name so real user learning
 * data in the browser is never touched.
 */

let dbName: string
let db: ExamPilotDB

beforeEach(() => {
  dbName = `exampilot-test-${Math.random().toString(36).slice(2, 10)}`
  db = createDb(dbName)
})

afterEach(async () => {
  await db.delete()
})

const rec = (qid: string, attempts: number): QRecord => ({
  qid,
  status: attempts > 2 ? 'mastered' : 'learning',
  attempts,
  correctCount: attempts - 1,
  wrongCount: 1,
  lastSeenAt: 1700000000000,
  lastCorrect: false,
  lastAnswer: 'AC',
  intervalDays: 3,
  ease: 2,
  nextReviewAt: 1700000000000 + 86400000,
})

const hist = (id: string, qid: string, isCorrect: boolean | null): HistoryEntry => ({
  id,
  qid,
  mode: 'mock',
  sessionId: 's1',
  answer: 'AC',
  isCorrect,
  submittedAt: 1700000000000,
  usedAI: false,
})

const mockRun = (): MockRun => ({
  id: 'm-1',
  startedAt: 1700000000000,
  endedAt: 1700000600000,
  config: {
    singleCount: 2,
    multiCount: 1,
    judgeCount: 0,
    shortCount: 1,
    singleScore: 1,
    multiScore: 2,
    judgeScore: 1,
    shortScore: 15,
    durationMin: 30,
    chapters: 'all',
  },
  submissions: { q1: 'B', q2: null, q3: 'AC', q4: '我的作答' },
  graded: true,
  score: 1,
  maxScore: 20,
  objectiveMaxScore: 5,
  subjectiveMaxScore: 15,
  perQuestion: {
    q1: { isCorrect: true, points: 1, unanswered: false },
    q2: { isCorrect: null, points: 0, unanswered: true },
    q3: { isCorrect: false, points: 0, unanswered: false },
    q4: { isCorrect: null, points: 0, unanswered: false },
  },
})

const aiReview = (): AiReview => ({
  id: 'a-1',
  qid: 'q4',
  userAnswer: '我的作答',
  createdAt: 1700000700000,
  provider: 'stub',
  model: 'stub-model',
  result: {
    score: 82,
    maxScore: 100,
    hitPoints: ['概念准确'],
    missedPoints: ['缺少材料联系'],
    deductions: ['结构不完整'],
    suggestions: ['补充分点'],
    structureNote: '总体清晰',
    disclaimer: '参考评阅',
  },
})

const settings: AppSettings = { theme: 'dark', reviewIntervalBase: 2, studyTarget: 45, dailyGoalQuestions: 25 }

const bank: BankData = {
  schema: 'examPilot.bank.v1',
  source: 'sample',
  generatedAt: '',
  chapterOrder: ['导论'],
  countsByType: {},
  questions: ['q1', 'q2', 'q3', 'q4'].map((id): Question => ({
    id,
    chapter: '导论',
    chapterIndex: 0,
    type: 'single',
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
}

/** Write a full dataset, export it, wipe the DB, restore, and compare. */
async function seed(): Promise<void> {
  await db.records.bulkPut([rec('q1', 3), rec('q2', 1), rec('q3', 2)])
  await db.history.bulkPut([hist('h1', 'q1', true), hist('h2', 'q2', false), hist('h3', 'q4', null)])
  await db.mocks.put(mockRun())
  await db.aiReviews.put(aiReview())
  await db.settings.put({ ...settings, id: 'main' })
}

describe('IndexedDB round-trip: export 閳?clear 閳?import 閳?field-by-field compare', () => {
  it('restores records, history, mocks, aiReviews and settings completely', async () => {
    await seed()
    const before = await snapshotDb(db)

    // export exactly what the UI exports
    const payload = makeExportPayload({
      settings: before.settings,
      records: before.records,
      history: before.history,
      mocks: before.mocks,
      aiReviews: before.aiReviews,
      bankFingerprint: bankFingerprint(bank),
      bankCount: bank.questions.length,
    })
    const text = serialize(payload)
    const parsed = parseExport(text)
    expect(parsed.ok).toBe(true)

    // wipe everything (simulating a fresh browser / another device)
    await db.records.clear()
    await db.history.clear()
    await db.mocks.clear()
    await db.aiReviews.clear()
    await db.settings.clear()
    const emptied = await snapshotDb(db)
    expect(emptied.records).toHaveLength(0)
    expect(emptied.history).toHaveLength(0)
    expect(emptied.mocks).toHaveLength(0)
    expect(emptied.aiReviews).toHaveLength(0)
    expect(emptied.settings).toBe(null)

    // import
    const plan = planImport(parsed.payload!, 'replace')
    const counts = await restoreBackupInto(db, {
      records: plan.records,
      history: plan.history,
      mocks: plan.mocks,
      aiReviews: plan.aiReviews,
      settingsAction: plan.settingsAction,
      settings: plan.settings,
    })

    // every table written
    expect(counts.records).toBe(3)
    expect(counts.history).toBe(3)
    expect(counts.mocks).toBe(1)
    expect(counts.aiReviews).toBe(1)
    expect(counts.settings).toBe(1)

    const after = await snapshotDb(db)

    // field-by-field comparison (order-independent)
    const byKey = <T>(arr: T[], k: (x: T) => string) => arr.slice().sort((a, b) => k(a).localeCompare(k(b)))
    expect(byKey(after.records, (r) => r.qid)).toEqual(byKey(before.records, (r) => r.qid))
    expect(byKey(after.history, (h) => h.id)).toEqual(byKey(before.history, (h) => h.id))
    expect(byKey(after.mocks, (m) => m.id)).toEqual(byKey(before.mocks, (m) => m.id))
    expect(byKey(after.aiReviews, (a) => a.id)).toEqual(byKey(before.aiReviews, (a) => a.id))
    expect(after.settings).toEqual(before.settings)
  })

  it('preserves the original answer, mock score breakdown and AI review content', async () => {
    await seed()
    const before = await snapshotDb(db)
    const payload = makeExportPayload({
      settings: before.settings,
      records: before.records,
      history: before.history,
      mocks: before.mocks,
      aiReviews: before.aiReviews,
      bankFingerprint: bankFingerprint(bank),
      bankCount: 4,
    })
    await db.records.clear()
    await db.history.clear()
    await db.mocks.clear()
    await db.aiReviews.clear()
    await db.settings.clear()
    const plan = planImport(parseExport(serialize(payload)).payload!, 'replace')
    await restoreBackupInto(db, { ...plan, settingsAction: plan.settingsAction })
    const after = await snapshotDb(db)

    // original answers survive
    expect(after.records.find((r) => r.qid === 'q1')?.lastAnswer).toBe('AC')
    expect(after.history.find((h) => h.id === 'h1')?.answer).toBe('AC')

    // mock score breakdown survives, including unanswered vs wrong
    const m = after.mocks[0]
    expect(m.score).toBe(1)
    expect(m.objectiveMaxScore).toBe(5)
    expect(m.subjectiveMaxScore).toBe(15)
    expect(m.perQuestion.q2.unanswered).toBe(true)
    expect(m.perQuestion.q2.isCorrect).toBe(null)
    expect(m.perQuestion.q3.isCorrect).toBe(false)
    expect(m.perQuestion.q4.isCorrect).toBe(null)
    expect(m.submissions.q4).toBe('我的作答')

    // AI review content survives
    const a = after.aiReviews[0]
    expect(a.userAnswer).toBe('我的作答')
    expect(a.model).toBe('stub-model')
    expect(a.provider).toBe('stub')
    expect(a.result.score).toBe(82)
    expect(a.result.hitPoints).toEqual(['概念准确'])
    expect(a.result.missedPoints).toEqual(['缺少材料联系'])
  })

  it('merge mode keeps existing rows that are absent from the backup', async () => {
    await seed()
    const before = await snapshotDb(db)
    const payload = makeExportPayload({
      settings: before.settings,
      records: [rec('q9', 7)],
      history: [hist('h9', 'q9', true)],
      mocks: [],
      aiReviews: [],
      bankFingerprint: bankFingerprint(bank),
      bankCount: 4,
    })
    const plan = planImport(payload, 'merge', {
      records: before.records,
      history: before.history,
      mocks: before.mocks,
      aiReviews: before.aiReviews,
    })
    await restoreBackupInto(db, { ...plan, settingsAction: plan.settingsAction })
    const after = await snapshotDb(db)
    expect(after.records.map((r) => r.qid).sort()).toEqual(['q1', 'q2', 'q3', 'q9'])
    expect(after.history).toHaveLength(4)
    expect(after.mocks).toHaveLength(1) // kept from before
  })
})

describe('IndexedDB transaction atomicity', () => {
  it('rolls back completely when a write fails mid-restore', async () => {
    await seed()
    const before = await snapshotDb(db)

    // Force a failure on the last table by supplying a document without its key.
    const broken = {
      records: [rec('qNew', 1)],
      history: [hist('hNew', 'qNew', true)],
      mocks: [mockRun()],
      aiReviews: [aiReview()],
      settings,
    }
    // Remove the primary key so bulkPut throws inside the transaction.
    const badRecords = [{ ...rec('qNew', 1), qid: undefined } as unknown as QRecord]

    await expect(restoreBackupInto(db, { ...broken, records: badRecords })).rejects.toBeTruthy()

    const after = await snapshotDb(db)
    // Nothing changed: the transaction aborted and previous data survived.
    expect(after.records).toHaveLength(before.records.length)
    expect(after.history).toHaveLength(before.history.length)
    expect(after.mocks).toHaveLength(before.mocks.length)
    expect(after.aiReviews).toHaveLength(before.aiReviews.length)
    expect(after.settings).toEqual(before.settings)
  })
})

// ---------------------------------------------------------------------------
// Settings semantics: the DB must do exactly what the plan reported
// ---------------------------------------------------------------------------

describe('IndexedDB settings semantics', () => {
  it('REGRESSION: merge with settingsAction=keep PRESERVES the current settings', async () => {
    await seed()
    const before = await snapshotDb(db)
    expect(before.settings).toEqual(settings)

    // A merge whose backup carries no usable settings.
    const plan = planImport(
      makeExportPayload({
        settings: undefined,
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: bankFingerprint(bank),
        bankCount: 4,
      }),
      'merge',
      { ...before },
    )
    expect(plan.settingsAction).toBe('keep')

    await restoreBackupInto(db, {
      records: plan.records,
      history: plan.history,
      mocks: plan.mocks,
      aiReviews: plan.aiReviews,
      settingsAction: plan.settingsAction,
      settings: plan.settings,
    })

    // Settings must be UNCHANGED 鈥?this is the behaviour the old unconditional
    // clear broke.
    expect((await snapshotDb(db)).settings).toEqual(settings)
    expect((await readSettingsOf(db)).theme).toBe('dark')
  })

  it('REGRESSION: replace with settingsAction=reset falls back to DEFAULT_SETTINGS', async () => {
    await seed()
    const before = await snapshotDb(db)
    const plan = planImport(
      makeExportPayload({
        settings: undefined,
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
        bankFingerprint: bankFingerprint(bank),
        bankCount: 4,
      }),
      'replace',
      { ...before },
    )
    expect(plan.settingsAction).toBe('reset')

    await restoreBackupInto(db, {
      records: plan.records,
      history: plan.history,
      mocks: plan.mocks,
      aiReviews: plan.aiReviews,
      settingsAction: plan.settingsAction,
      settings: plan.settings,
    })

    expect((await snapshotDb(db)).settings).toBe(null)
    // readSettings() is what the UI uses, so it must report the defaults.
    expect(await readSettingsOf(db)).toEqual(DEFAULT_SETTINGS)
  })

  it('replace with settingsAction=set writes the backup settings', async () => {
    await seed()
    const next: AppSettings = { theme: 'light', reviewIntervalBase: 3, studyTarget: 10, dailyGoalQuestions: 5 }
    await restoreBackupInto(db, {
      records: [],
      history: [],
      mocks: [],
      aiReviews: [],
      settingsAction: 'set',
      settings: next,
    })
    expect(await readSettingsOf(db)).toEqual(next)
  })

  it('the settings row survives a simulated page reload (fresh read)', async () => {
    await seed()
    // A reload re-reads settings from IndexedDB; the value must be identical.
    const readAfterReload = await readSettingsOf(db)
    expect(readAfterReload).toEqual(settings)
  })

  it('a failure during a settings restore rolls the whole restore back', async () => {
    await seed()
    const before = await snapshotDb(db)

    const badRecords = [{ ...rec('qNew', 1), qid: undefined } as unknown as QRecord]
    await expect(
      restoreBackupInto(db, {
        records: badRecords,
        history: [],
        mocks: [],
        aiReviews: [],
        settingsAction: 'reset',
      }),
    ).rejects.toBeTruthy()

    const after = await snapshotDb(db)
    // settings were NOT reset, because the transaction aborted
    expect(after.settings).toEqual(before.settings)
    expect(after.records).toHaveLength(before.records.length)
  })
})
