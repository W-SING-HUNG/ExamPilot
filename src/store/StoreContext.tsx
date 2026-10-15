import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { db, restoreBackupInto } from '../db/database'
import type { QRecord, HistoryEntry, MockRun, AiReview, AppSettings, AiGradeResult, MockConfig } from '../lib/types'
import { freshRecord, applyAttempt } from '../lib/scheduler'
import { scoreAnswer, isAnswerBlank } from '../lib/scoring'
import { submitMockRun as submitMockRunTx, saveAiReviewWithAttempt } from '../lib/session'
import type { Question } from '../lib/types'

export interface SubmitOutcome {
  isCorrect: boolean | null
  blank: boolean
}

export interface SubmitOptions {
  /** when true the attempt is NOT persisted (used by mock-exam blanks) */
  skipPersistence?: boolean
}

interface StoreValue {
  ready: boolean
  records: Map<string, QRecord>
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  settings: AppSettings
  submitAnswer: (
    q: Question,
    answer: string | null,
    mode: string,
    sessionId: string,
    usedAI?: boolean,
    options?: SubmitOptions,
  ) => Promise<SubmitOutcome>
  saveSubjectiveAttempt: (
    q: Question,
    answer: string,
    mode: string,
    sessionId: string,
    usedAI?: boolean,
  ) => Promise<void>
  getRecord: (qid: string) => QRecord | undefined
  saveAiReview: (r: AiReview) => Promise<void>
  /** Save an AI review and at most one training attempt for this session. */
  saveAiReviewForQuestion: (
    q: Question,
    userAnswer: string,
    sessionId: string,
    provider: string,
    model: string,
    result: AiGradeResult,
  ) => Promise<{ created: boolean }>
  /**
   * Persist a whole mock-exam submission transactionally and idempotently.
   * Re-submitting the same runId never double-counts learning data.
   */
  submitMockRun: (input: {
    runId: string
    paper: Question[]
    submissions: Record<string, string | null>
    config: MockConfig
    startedAt: number
    endedAt: number
  }) => Promise<{ status: 'committed' | 'already-submitted'; run: MockRun }>
  saveMockRun: (m: MockRun) => Promise<void>
  deleteMockRun: (id: string) => Promise<void>
  updateSettings: (s: Partial<AppSettings>) => Promise<void>
  clearHistory: () => Promise<void>
  resetAllProgress: () => Promise<void>
  importRecords: (records: QRecord[], history: HistoryEntry[], mocks: MockRun[], aiReviews: AiReview[]) => Promise<void>
  /** Full restore: records + history + mocks + aiReviews + settings, all-or-nothing. */
  restoreBackup: (input: {
    records: QRecord[]
    history: HistoryEntry[]
    mocks: MockRun[]
    aiReviews: AiReview[]
    settings: AppSettings | null
  }) => Promise<void>
  clearWrong: (qids: string[]) => Promise<void>
}

const StoreContext = createContext<StoreValue | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [records, setRecords] = useState<Map<string, QRecord>>(new Map())
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [mocks, setMocks] = useState<MockRun[]>([])
  const [aiReviews, setAiReviews] = useState<AiReview[]>([])
  const [settings, setSettings] = useState<AppSettings>({
    theme: 'auto',
    reviewIntervalBase: 1,
    studyTarget: 30,
    dailyGoalQuestions: 30,
  })

  const refresh = useCallback(async () => {
    const [recs, hist, mks, aiv] = await Promise.all([
      db.records.toArray(),
      db.history.toArray(),
      db.mocks.toArray(),
      db.aiReviews.toArray(),
    ])
    setRecords(new Map(recs.map((r) => [r.qid, r])))
    setHistory(hist.sort((a, b) => b.submittedAt - a.submittedAt))
    setMocks(mks.sort((a, b) => b.startedAt - a.startedAt))
    setAiReviews(aiv.sort((a, b) => b.createdAt - a.createdAt))
  }, [])

  useEffect(() => {
    let alive = true
    ;(async () => {
      await refresh()
      const s = await db.settings.get('main')
      if (alive && s) setSettings(s)
      if (alive) setReady(true)
    })()
    return () => {
      alive = false
    }
  }, [refresh])

  const getRecord = useCallback((qid: string) => records.get(qid), [records])

  /**
   * Persist a graded objective attempt.
   *
   * `blank` answers are reported distinctly from `wrong`: a blank is never
   * counted as an error, and never lands in the wrong-question bank.
   * With `options.skipPersistence` nothing is written at all (mock-exam blanks).
   */
  const submitAnswer = useCallback<StoreValue['submitAnswer']>(
    async (q, answer, mode, sessionId, usedAI = false, options) => {
      const now = Date.now()
      const blank = isAnswerBlank(q, answer)
      const isCorrect = scoreAnswer(q, answer)
      if (options?.skipPersistence) {
        return { isCorrect, blank }
      }
      const entry: HistoryEntry = {
        id: `h-${now}-${q.id}-${Math.random().toString(36).slice(2, 7)}`,
        qid: q.id,
        mode,
        sessionId,
        answer: answer ?? null,
        isCorrect,
        submittedAt: now,
        usedAI,
      }
      await db.transaction('rw', db.records, db.history, async () => {
        // Read the authoritative row INSIDE the transaction: the React snapshot
        // may be stale (concurrent tab, or a write not yet refreshed).
        const current = (await db.records.get(q.id)) ?? freshRecord(q.id, now)
        const merged: QRecord = applyAttempt(
          { ...current, ease: Math.max(current.ease, settings.reviewIntervalBase) },
          isCorrect === true,
          now,
        )
        merged.lastAnswer = answer ?? null
        merged.lastCorrect = isCorrect
        await db.records.put(merged)
        await db.history.add(entry)
      })
      await refresh()
      return { isCorrect, blank }
    },
    [refresh, settings.reviewIntervalBase],
  )

  const saveSubjectiveAttempt = useCallback<StoreValue['saveSubjectiveAttempt']>(
    async (q, answer, mode, sessionId, usedAI = false) => {
      const now = Date.now()
      const entry: HistoryEntry = {
        id: `h-${now}-${q.id}-${Math.random().toString(36).slice(2, 7)}`,
        qid: q.id,
        mode,
        sessionId,
        answer,
        isCorrect: null,
        submittedAt: now,
        usedAI,
      }
      // subjective attempts count as "attempted" but never auto-correct
      await db.transaction('rw', db.records, db.history, async () => {
        const current = (await db.records.get(q.id)) ?? freshRecord(q.id, now)
        await db.records.put({
          ...current,
          attempts: current.attempts + 1,
          lastSeenAt: now,
          lastCorrect: null,
          lastAnswer: answer,
          nextReviewAt: now + 24 * 3600 * 1000,
        })
        await db.history.add(entry)
      })
      await refresh()
    },
    [refresh],
  )

  const value = useMemo<StoreValue>(
    () => ({
      ready,
      records,
      history,
      mocks,
      aiReviews,
      settings,
      submitAnswer,
      saveSubjectiveAttempt,
      getRecord,
      saveAiReview: async (r: AiReview) => {
        await db.aiReviews.put(r)
        await refresh()
      },
      saveAiReviewForQuestion: async (q, userAnswer, sessionId, provider, model, result) => {
        const out = await saveAiReviewWithAttempt(db, {
          sessionId,
          qid: q.id,
          question: q,
          userAnswer,
          provider,
          model,
          result,
        })
        await refresh()
        return out
      },
      submitMockRun: async (input) => {
        const out = await submitMockRunTx(db, input)
        await refresh()
        return { status: out.status, run: out.run }
      },
      saveMockRun: async (m: MockRun) => {
        await db.mocks.put(m)
        await refresh()
      },
      deleteMockRun: async (id: string) => {
        await db.mocks.delete(id)
        await refresh()
      },
      updateSettings: async (s: Partial<AppSettings>) => {
        const merged = { ...settings, ...s }
        await db.settings.put({ ...merged, id: 'main' })
        setSettings(merged)
      },
      clearHistory: async () => {
        await db.history.clear()
        await refresh()
      },
      resetAllProgress: async () => {
        await db.transaction('rw', db.records, db.history, db.mocks, db.aiReviews, async () => {
          await db.records.clear()
          await db.history.clear()
          await db.mocks.clear()
          await db.aiReviews.clear()
        })
        await refresh()
      },
      importRecords: async (recs, hist, mks, aiv) => {
        await db.transaction('rw', db.records, db.history, db.mocks, db.aiReviews, async () => {
          await db.records.bulkPut(recs)
          await db.history.bulkPut(hist)
          await db.mocks.bulkPut(mks)
          await db.aiReviews.bulkPut(aiv)
        })
        await refresh()
      },
      /**
       * Full backup restore. All-or-nothing: if any write fails the transaction
       * aborts and the previous data stays intact, so a failed import can never
       * leave a half-restored database.
       */
      restoreBackup: async ({ records: recs, history: hist, mocks: mks, aiReviews: aiv, settings: s }) => {
        await restoreBackupInto(db, { records: recs, history: hist, mocks: mks, aiReviews: aiv, settings: s })
        if (s) setSettings(s)
        await refresh()
      },
      clearWrong: async (qids: string[]) => {
        await db.transaction('rw', db.records, db.history, async () => {
          for (const qid of qids) await db.records.delete(qid)
          await db.history.where('qid').anyOf(qids).delete()
        })
        await refresh()
      },
    }),
    [ready, records, history, mocks, aiReviews, settings, submitAnswer, saveSubjectiveAttempt, getRecord, refresh],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}
