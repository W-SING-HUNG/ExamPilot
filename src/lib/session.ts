import type { ExamPilotDB } from '../db/database'
import type { AiGradeResult, HistoryEntry, MockConfig, MockRun, QRecord, Question } from './types'
import { gradeMockSubmission } from './mock-grading'
import { applyAttempt, freshRecord } from './scheduler'

export interface SubmitMockInput {
  /** Stable id for this exam attempt; re-submitting the same id is a no-op. */
  runId: string
  paper: Question[]
  submissions: Record<string, string | null>
  config: MockConfig
  startedAt: number
  endedAt: number
}

export interface SubmitMockResult {
  /** 'committed' = this call wrote the exam; 'already-submitted' = idempotent replay */
  status: 'committed' | 'already-submitted'
  run: MockRun
  /** rows actually written by THIS call (zero on replay) */
  written: { records: number; history: number }
}

/**
 * Deterministic history id for one answered question inside one exam run.
 *
 * Because the id is a pure function of (runId, qid), replaying the same run
 * cannot insert a second row for the same question — the primary key collides
 * and the transaction overwrites instead of duplicating.
 */
export function historyIdFor(runId: string, qid: string): string {
  return `h-mock-${runId}-${qid}`
}

/**
 * Deterministic AI-review id for one question inside one session, so pressing
 * "AI 评阅" repeatedly updates a single record instead of adding attempts.
 */
export function aiReviewIdFor(sessionId: string, qid: string): string {
  return `ai-${sessionId}-${qid}`
}

/**
 * Persist one mock-exam submission.
 *
 * Guarantees (all covered by fault-injection tests):
 *  1. Everything happens inside ONE Dexie transaction over records/history/mocks,
 *     so a failure anywhere rolls the whole submission back — there is never a
 *     partially-persisted exam.
 *  2. Progress is computed from records READ INSIDE the transaction, not from a
 *     possibly stale React snapshot.
 *  3. Re-submitting the same `runId` after a successful commit is a no-op: the
 *     mock row already exists, so the exam is returned as 'already-submitted'
 *     and no counters move.
 *  4. Blank objective answers are never persisted and never counted as wrong.
 */
export async function submitMockRun(db: ExamPilotDB, input: SubmitMockInput): Promise<SubmitMockResult> {
  const { runId, paper, submissions, config, startedAt, endedAt } = input
  const graded = gradeMockSubmission(paper, submissions, config)

  const run: MockRun = {
    id: runId,
    startedAt,
    endedAt,
    config,
    submissions,
    graded: true,
    score: graded.score,
    maxScore: graded.maxScore,
    objectiveMaxScore: graded.objectiveMaxScore,
    subjectiveMaxScore: graded.subjectiveMaxScore,
    perQuestion: graded.perQuestion,
  }

  let status: SubmitMockResult['status'] = 'committed'
  const written = { records: 0, history: 0 }

  await db.transaction('rw', db.records, db.history, db.mocks, async () => {
    // Idempotency gate: a committed run is never applied twice.
    const existing = await db.mocks.get(runId)
    if (existing) {
      status = 'already-submitted'
      return
    }

    // Answered objective questions: update the shared learning record.
    for (const { q, answer } of graded.persisted) {
      const current = (await db.records.get(q.id)) ?? freshRecord(q.id, endedAt)
      const isCorrect = graded.perQuestion[q.id]?.isCorrect ?? null
      const next: QRecord = applyAttempt(current, isCorrect === true, endedAt)
      next.lastAnswer = answer
      next.lastCorrect = isCorrect
      await db.records.put(next)
      written.records++

      const entry: HistoryEntry = {
        id: historyIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect,
        submittedAt: endedAt,
        usedAI: false,
      }
      await db.history.put(entry)
      written.history++
    }

    // Answered subjective questions count as a training attempt (no score).
    for (const { q, answer } of graded.subjective) {
      const current = (await db.records.get(q.id)) ?? freshRecord(q.id, endedAt)
      await db.records.put({
        ...current,
        attempts: current.attempts + 1,
        lastSeenAt: endedAt,
        lastCorrect: null,
        lastAnswer: answer,
        nextReviewAt: endedAt + 24 * 3600 * 1000,
      })
      written.records++

      const entry: HistoryEntry = {
        id: historyIdFor(runId, q.id),
        qid: q.id,
        mode: 'mock',
        sessionId: runId,
        answer,
        isCorrect: null,
        submittedAt: endedAt,
        usedAI: false,
      }
      await db.history.put(entry)
      written.history++
    }

    await db.mocks.put(run)
  })

  return { status, run, written }
}

/**
 * Persist an AI review together with (at most) one training attempt.
 *
 * - The AI review row id is deterministic per (sessionId, qid): repeated reviews
 *   update one row instead of accumulating.
 * - The training attempt is likewise keyed by (sessionId, qid) in history, so
 *   clicking "AI 评阅" repeatedly does NOT add repeated attempts. A question
 *   already submitted in this session keeps its original attempt.
 */
export async function saveAiReviewWithAttempt(
  db: ExamPilotDB,
  input: {
    sessionId: string
    qid: string
    question: Question
    userAnswer: string
    provider: string
    model: string
    result: AiGradeResult
    now?: number
  },
): Promise<{ created: boolean }> {
  const { sessionId, qid, userAnswer, provider, model, result } = input
  const now = input.now ?? Date.now()
  const reviewId = aiReviewIdFor(sessionId, qid)
  const attemptId = historyIdFor(sessionId, qid)
  let created = false

  await db.transaction('rw', db.records, db.history, db.aiReviews, async () => {
    const existing = await db.aiReviews.get(reviewId)
    created = !existing

    await db.aiReviews.put({ id: reviewId, qid, userAnswer, createdAt: now, provider, model, result })

    // Only record a training attempt the first time this question is reviewed in
    // this session; a re-review must not inflate attempts again.
    const alreadyAttempted = await db.history.get(attemptId)
    if (!alreadyAttempted) {
      const current = (await db.records.get(qid)) ?? freshRecord(qid, now)
      await db.records.put({
        ...current,
        attempts: current.attempts + 1,
        lastSeenAt: now,
        lastCorrect: null,
        lastAnswer: userAnswer,
        nextReviewAt: now + 24 * 3600 * 1000,
      })
      await db.history.put({
        id: attemptId,
        qid,
        mode: 'ai-review',
        sessionId,
        answer: userAnswer,
        isCorrect: null,
        submittedAt: now,
        usedAI: true,
      })
    }
  })

  return { created }
}
