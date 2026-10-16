import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { createDb, snapshotDb, type ExamPilotDB } from './database'
import { submitMockRun, attemptIdFor, aiReviewIdFor, saveAiReviewWithAttempt, recordAttempt } from '../lib/session'
import { freshRecord } from '../lib/scheduler'
import type { MockConfig, Question, QuestionType } from '../lib/types'

/**
 * Fault-injection tests for transactional, idempotent mock-exam submission.
 * Each test owns its database, so real user learning data is never touched.
 */

let dbName: string
let db: ExamPilotDB

beforeEach(() => {
  dbName = `exampilot-mock-${Math.random().toString(36).slice(2, 10)}`
  db = createDb(dbName)
})

afterEach(async () => {
  await db.delete()
})

const mkq = (id: string, type: QuestionType = 'single'): Question => ({
  id,
  chapter: '瀵艰',
  chapterIndex: 0,
  type,
  bankNo: 1,
  pageStart: 1,
  pageEnd: 1,
  stem: `stem-${id}`,
  options: type === 'single' || type === 'multi' ? ['a', 'b', 'c', 'd'] : [],
  answer: type === 'judge' ? '姝ｇ‘' : 'A',
  answerNorm: type === 'judge' ? true : 'A',
  hasOfficialAnswer: type !== 'short' && type !== 'material',
  isFlagged: false,
  flagReason: '',
})

const config: MockConfig = {
  singleCount: 3,
  multiCount: 0,
  judgeCount: 0,
  shortCount: 1,
  singleScore: 1,
  multiScore: 2,
  judgeScore: 1,
  shortScore: 15,
  durationMin: 10,
  chapters: 'all',
}

const PAPER: Question[] = [mkq('q1'), mkq('q2'), mkq('q3'), mkq('q4', 'short')]

const baseInput = (over: Partial<Parameters<typeof submitMockRun>[1]> = {}) => ({
  runId: 'run-1',
  paper: PAPER,
  submissions: { q1: 'A', q2: 'A', q3: 'A', q4: '鎴戠殑浣滅瓟' } as Record<string, string | null>,
  config,
  startedAt: 1000,
  endedAt: 2000,
  ...over,
})

describe('submitMockRun / happy path', () => {
  it('persists records, history and the mock row in one commit', async () => {
    const out = await submitMockRun(db, baseInput())
    expect(out.status).toBe('committed')
    expect(out.written.records).toBe(4) // 3 objective + 1 subjective
    expect(out.written.history).toBe(4)

    const snap = await snapshotDb(db)
    expect(snap.records).toHaveLength(4)
    expect(snap.history).toHaveLength(4)
    expect(snap.mocks).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === 'q1')?.correctCount).toBe(1)
    expect(snap.records.find((r) => r.qid === 'q4')?.correctCount).toBe(0)
  })
})

describe('submitMockRun / fault injection', () => {
  it('FAILURE BEFORE ANY WRITE: aborts and leaves the database untouched', async () => {
    // Seed a pre-existing row so we can prove it survives.
    await db.records.put({
      qid: 'seeded',
      status: 'learning',
      attempts: 1,
      correctCount: 1,
      wrongCount: 0,
      lastSeenAt: 1,
      lastCorrect: true,
      lastAnswer: 'A',
      intervalDays: 1,
      ease: 2,
      nextReviewAt: 1,
    })
    const before = await snapshotDb(db)

    // Make the very first read throw, i.e. failure before any write.
    const originalGet = db.mocks.get.bind(db.mocks)
    db.mocks.get = () => {
      throw new Error('injected failure before first write')
    }

    await expect(submitMockRun(db, baseInput())).rejects.toThrow(/injected failure/)
    db.mocks.get = originalGet

    const after = await snapshotDb(db)
    expect(after.records).toHaveLength(before.records.length)
    expect(after.history).toHaveLength(0)
    expect(after.mocks).toHaveLength(0)
  })

  it('FAILURE MID-TRANSACTION: rolls back every question already processed', async () => {
    const before = await snapshotDb(db)

    // Fail when writing the third objective question's record, i.e. after some
    // rows have already been written inside the transaction.
    const originalPut = db.records.put.bind(db.records)
    let puts = 0
    db.records.put = ((value: unknown) => {
      puts++
      if (puts === 3) throw new Error('injected failure mid-transaction')
      return originalPut(value as never)
    }) as typeof db.records.put

    await expect(submitMockRun(db, baseInput())).rejects.toThrow(/injected failure mid-transaction/)
    db.records.put = originalPut

    const after = await snapshotDb(db)
    // Full rollback: nothing from this submission survives.
    expect(after.records).toHaveLength(before.records.length)
    expect(after.history).toHaveLength(0)
    expect(after.mocks).toHaveLength(0)
    expect(puts).toBeGreaterThanOrEqual(3)
  })

  it('REPLAY AFTER COMMIT: the same runId is a no-op and counters do not move', async () => {
    const first = await submitMockRun(db, baseInput())
    expect(first.status).toBe('committed')
    const afterFirst = await snapshotDb(db)

    const second = await submitMockRun(db, baseInput())
    expect(second.status).toBe('already-submitted')
    expect(second.written.records).toBe(0)
    expect(second.written.history).toBe(0)

    const afterSecond = await snapshotDb(db)
    expect(afterSecond.records).toEqual(afterFirst.records)
    expect(afterSecond.history).toEqual(afterFirst.history)
    expect(afterSecond.mocks).toHaveLength(1)

    // counters unchanged: no double counting
    expect(afterSecond.records.find((r) => r.qid === 'q1')?.attempts).toBe(1)
    expect(afterSecond.records.find((r) => r.qid === 'q1')?.correctCount).toBe(1)
    expect(afterSecond.history.filter((h) => h.qid === 'q1')).toHaveLength(1)
  })

  it('CONCURRENT SUBMITS (double click / timer + manual): exactly one commit wins', async () => {
    const results = await Promise.all([
      submitMockRun(db, baseInput({ runId: 'race' })),
      submitMockRun(db, baseInput({ runId: 'race' })),
      submitMockRun(db, baseInput({ runId: 'race' })),
    ])
    const committed = results.filter((r) => r.status === 'committed')
    const replayed = results.filter((r) => r.status === 'already-submitted')
    expect(committed).toHaveLength(1)
    expect(replayed).toHaveLength(2)

    const snap = await snapshotDb(db)
    expect(snap.mocks).toHaveLength(1)
    expect(snap.history).toHaveLength(4)
    expect(snap.records.find((r) => r.qid === 'q1')?.attempts).toBe(1)
  })

  it('RETRY AFTER FAILURE: a retry with the same runId commits exactly once', async () => {
    const originalPut = db.records.put.bind(db.records)
    let fail = true
    db.records.put = ((value: unknown) => {
      if (fail) throw new Error('injected transient failure')
      return originalPut(value as never)
    }) as typeof db.records.put

    await expect(submitMockRun(db, baseInput({ runId: 'retry' }))).rejects.toThrow(/injected transient/)
    fail = false
    db.records.put = originalPut

    const retry = await submitMockRun(db, baseInput({ runId: 'retry' }))
    expect(retry.status).toBe('committed')

    const snap = await snapshotDb(db)
    expect(snap.mocks).toHaveLength(1)
    expect(snap.history).toHaveLength(4)
    // no duplication from the failed first attempt
    expect(snap.records.find((r) => r.qid === 'q1')?.attempts).toBe(1)
  })

  it('BLANK QUESTIONS: never persisted, never counted wrong', async () => {
    const out = await submitMockRun(db, baseInput({ submissions: { q1: 'A', q2: null, q3: '', q4: null } }))
    expect(out.status).toBe('committed')

    const snap = await snapshotDb(db)
    // only q1 is a real attempt
    expect(snap.records.map((r) => r.qid).sort()).toEqual(['q1'])
    expect(snap.history.map((h) => h.qid)).toEqual(['q1'])
    // blanks are not wrong
    expect(snap.records.find((r) => r.qid === 'q1')?.wrongCount).toBe(0)
    expect(snap.history.some((h) => h.qid === 'q2' || h.qid === 'q3')).toBe(false)
  })

  it('a wrong answer is counted once and appears in the wrong bank', async () => {
    await submitMockRun(db, baseInput({ submissions: { q1: 'B', q2: 'A', q3: 'A', q4: null } }))
    const snap = await snapshotDb(db)
    const q1 = snap.records.find((r) => r.qid === 'q1')
    expect(q1?.wrongCount).toBe(1)
    expect(q1?.correctCount).toBe(0)
    expect(snap.history.find((h) => h.qid === 'q1')?.isCorrect).toBe(false)
  })

  it('computes progress from the DB, not a stale snapshot', async () => {
    // Pre-existing progress that a stale React snapshot would not know about.
    await db.records.put({
      qid: 'q1',
      status: 'learning',
      attempts: 5,
      correctCount: 5,
      wrongCount: 0,
      lastSeenAt: 1,
      lastCorrect: true,
      lastAnswer: 'A',
      intervalDays: 1,
      ease: 2,
      nextReviewAt: 1,
    })
    await submitMockRun(db, baseInput({ submissions: { q1: 'A', q2: null, q3: null, q4: null } }))
    const q1 = (await snapshotDb(db)).records.find((r) => r.qid === 'q1')
    // 5 prior attempts + this one = 6 (would be 1 if computed from an empty snapshot)
    expect(q1?.attempts).toBe(6)
    expect(q1?.correctCount).toBe(6)
  })

  it('produces exactly one mock history row per answered question', async () => {
    await submitMockRun(db, baseInput())
    const snap = await snapshotDb(db)
    for (const qid of ['q1', 'q2', 'q3', 'q4']) {
      const rows = snap.history.filter((h) => h.qid === qid)
      expect(rows, `history rows for ${qid}`).toHaveLength(1)
      expect(rows[0].id).toBe(attemptIdFor('run-1', qid))
    }
  })
})

describe('saveAiReviewWithAttempt / idempotency', () => {
  const q = mkq('q4', 'short')

  it('REGRESSION: repeated AI reviews do not add repeated training attempts', async () => {
    const result = {
      score: 80,
      maxScore: 100,
      hitPoints: ['a'],
      missedPoints: [],
      deductions: [],
      suggestions: [],
      structureNote: 'ok',
      disclaimer: 'd',
    }
    const first = await saveAiReviewWithAttempt(db, {
      sessionId: 'sess-1',
      qid: q.id,
      question: q,
      userAnswer: '第一次作答',
      provider: 'stub',
      model: 'm',
      result,
      now: 1000,
    })
    expect(first.created).toBe(true)

    // review the SAME question three more times in the same session
    for (let i = 0; i < 3; i++) {
      await saveAiReviewWithAttempt(db, {
        sessionId: 'sess-1',
        qid: q.id,
        question: q,
        userAnswer: '第一次作答',
        provider: 'stub',
        model: 'm',
        result,
        now: 2000 + i,
      })
    }

    const snap = await snapshotDb(db)
    // exactly one review row and exactly one attempt
    expect(snap.aiReviews).toHaveLength(1)
    expect(snap.aiReviews[0].id).toBe(aiReviewIdFor('sess-1', q.id))
    expect(snap.history).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === q.id)?.attempts).toBe(1)
  })

  it('a different session creates its own review and attempt', async () => {
    const result = {
      score: 70,
      maxScore: 100,
      hitPoints: [],
      missedPoints: [],
      deductions: [],
      suggestions: [],
      structureNote: '',
      disclaimer: '',
    }
    await saveAiReviewWithAttempt(db, {
      sessionId: 'A',
      qid: q.id,
      question: q,
      userAnswer: 'x',
      provider: 'p',
      model: 'm',
      result,
      now: 1,
    })
    await saveAiReviewWithAttempt(db, {
      sessionId: 'B',
      qid: q.id,
      question: q,
      userAnswer: 'x',
      provider: 'p',
      model: 'm',
      result,
      now: 2,
    })
    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(2)
    expect(snap.records.find((r) => r.qid === q.id)?.attempts).toBe(2)
  })

  it('a failed save adds no attempt and no review', async () => {
    const originalPut = db.aiReviews.put.bind(db.aiReviews)
    db.aiReviews.put = (() => {
      throw new Error('injected ai save failure')
    }) as typeof db.aiReviews.put

    await expect(
      saveAiReviewWithAttempt(db, {
        sessionId: 'sess-x',
        qid: q.id,
        question: q,
        userAnswer: 'x',
        provider: 'p',
        model: 'm',
        result: {
          score: 50,
          maxScore: 100,
          hitPoints: [],
          missedPoints: [],
          deductions: [],
          suggestions: [],
          structureNote: '',
          disclaimer: '',
        },
        now: 1,
      }),
    ).rejects.toThrow(/injected ai save failure/)
    db.aiReviews.put = originalPut

    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(0)
    expect(snap.history).toHaveLength(0)
    expect(snap.records).toHaveLength(0)
  })

  it('does not add an attempt when the question was already submitted in this session', async () => {
    // Simulate a mock submission that already recorded this question.
    await submitMockRun(
      db,
      baseInput({ runId: 'sess-1', submissions: { q1: null, q2: null, q3: null, q4: '我的作答' } }),
    )
    const before = await snapshotDb(db)
    expect(before.records.find((r) => r.qid === 'q4')?.attempts).toBe(1)

    await saveAiReviewWithAttempt(db, {
      sessionId: 'sess-1',
      qid: 'q4',
      question: q,
      userAnswer: '第一次作答',
      provider: 'p',
      model: 'm',
      result: {
        score: 60,
        maxScore: 100,
        hitPoints: [],
        missedPoints: [],
        deductions: [],
        suggestions: [],
        structureNote: '',
        disclaimer: '',
      },
      now: 9,
    })

    const after = await snapshotDb(db)
    // the AI review is saved, but the attempt is NOT counted twice
    expect(after.aiReviews).toHaveLength(1)
    expect(after.records.find((r) => r.qid === 'q4')?.attempts).toBe(1)
    expect(after.history.filter((h) => h.qid === 'q4')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Review scenarios A–D: the REAL paths, not hand-crafted matching ids
// ---------------------------------------------------------------------------

const GRADE = {
  score: 80,
  maxScore: 100,
  hitPoints: ['a'],
  missedPoints: [],
  deductions: [],
  suggestions: [],
  structureNote: 'ok',
  disclaimer: 'd',
}

describe('attempt identity across real paths (scenarios A–D)', () => {
  const subj = mkq('q4', 'short')

  it('A. subjective submit once -> one AI review -> attempts stay 1', async () => {
    // Real path: QuestionRunner records the subjective attempt via recordAttempt,
    // then the AI panel reviews the SAME question in the same session.
    await recordAttempt(db, {
      sessionId: 'sess-A',
      qid: subj.id,
      answer: '我的作答',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    // the subject step does NOT mark usedAI, mirroring QuestionRunner
    expect((await snapshotDb(db)).records.find((r) => r.qid === subj.id)?.attempts).toBe(1)

    await saveAiReviewWithAttempt(db, {
      sessionId: 'sess-A',
      qid: subj.id,
      question: subj,
      userAnswer: '我的作答',
      provider: 'stub',
      model: 'm',
      result: GRADE,
      now: 5,
    })

    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === subj.id)?.attempts).toBe(1)
    expect(snap.history.filter((h) => h.qid === subj.id)).toHaveLength(1)
  })

  it('B. repeated AI reviews of the same answer -> attempts stay 1', async () => {
    for (let i = 0; i < 5; i++) {
      await saveAiReviewWithAttempt(db, {
        sessionId: 'sess-B',
        qid: subj.id,
        question: subj,
        userAnswer: '作答',
        provider: 'stub',
        model: 'm',
        result: GRADE,
        now: 100 + i,
      })
    }
    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === subj.id)?.attempts).toBe(1)
  })

  it('C. mock exam submit -> AI review -> attempts stay 1', async () => {
    const runId = 'run-C'
    await submitMockRun(db, baseInput({ runId, submissions: { q1: null, q2: null, q3: null, q4: '简答作答' } }))
    expect((await snapshotDb(db)).records.find((r) => r.qid === 'q4')?.attempts).toBe(1)

    // The UI now passes the SAME session id (the run id) to the AI panel.
    await saveAiReviewWithAttempt(db, {
      sessionId: runId,
      qid: 'q4',
      question: subj,
      userAnswer: '简答作答',
      provider: 'stub',
      model: 'm',
      result: GRADE,
      now: 50,
    })

    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === 'q4')?.attempts).toBe(1)
    expect(snap.history.filter((h) => h.qid === 'q4')).toHaveLength(1)
  })

  it('D. AI save failure leaves the original attempt and stats unchanged', async () => {
    await recordAttempt(db, {
      sessionId: 'sess-D',
      qid: subj.id,
      answer: '原作答',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    const before = await snapshotDb(db)

    const originalPut = db.aiReviews.put.bind(db.aiReviews)
    db.aiReviews.put = (() => {
      throw new Error('injected failure')
    }) as typeof db.aiReviews.put
    await expect(
      saveAiReviewWithAttempt(db, {
        sessionId: 'sess-D',
        qid: subj.id,
        question: subj,
        userAnswer: '原作答',
        provider: 'stub',
        model: 'm',
        result: GRADE,
        now: 70,
      }),
    ).rejects.toThrow(/injected failure/)
    db.aiReviews.put = originalPut

    const after = await snapshotDb(db)
    expect(after.records).toEqual(before.records)
    expect(after.history).toEqual(before.history)
    expect(after.aiReviews).toHaveLength(0)
  })

  it('LEGACY: a random-id attempt from an older version is still recognised', async () => {
    // Simulate a row written by an older build: random id, same (qid, sessionId).
    await db.history.put({
      id: 'h-1700000000-q4-abc12',
      qid: subj.id,
      mode: 'subjective',
      sessionId: 'sess-legacy',
      answer: '旧作答',
      isCorrect: null,
      submittedAt: 1,
      usedAI: false,
    })
    await db.records.put({
      ...freshRecord(subj.id, 1),
      attempts: 1,
      lastSeenAt: 1,
      lastAnswer: '旧作答',
    })

    const out = await saveAiReviewWithAttempt(db, {
      sessionId: 'sess-legacy',
      qid: subj.id,
      question: subj,
      userAnswer: '旧作答',
      provider: 'stub',
      model: 'm',
      result: GRADE,
      now: 80,
    })

    // The review is saved, but no second attempt is counted on top of the legacy row.
    expect(out.attemptCreated).toBe(false)
    const snap = await snapshotDb(db)
    expect(snap.aiReviews).toHaveLength(1)
    expect(snap.records.find((r) => r.qid === subj.id)?.attempts).toBe(1)
    expect(snap.history.filter((h) => h.qid === subj.id)).toHaveLength(1)
    // the legacy row is untouched (not deleted, not rewritten)
    expect(snap.history.find((h) => h.qid === subj.id)?.id).toBe('h-1700000000-q4-abc12')
  })

  it('recordAttempt is idempotent per (sessionId, qid)', async () => {
    const first = await recordAttempt(db, {
      sessionId: 's',
      qid: subj.id,
      answer: 'a',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    const second = await recordAttempt(db, {
      sessionId: 's',
      qid: subj.id,
      answer: 'b',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect((await snapshotDb(db)).records.find((r) => r.qid === subj.id)?.attempts).toBe(1)
  })

  it('a different session does create a separate attempt', async () => {
    await recordAttempt(db, {
      sessionId: 's1',
      qid: subj.id,
      answer: 'a',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    await recordAttempt(db, {
      sessionId: 's2',
      qid: subj.id,
      answer: 'a',
      mode: 'subjective',
      isCorrect: null,
      usedAI: false,
    })
    expect((await snapshotDb(db)).records.find((r) => r.qid === subj.id)?.attempts).toBe(2)
  })
})
