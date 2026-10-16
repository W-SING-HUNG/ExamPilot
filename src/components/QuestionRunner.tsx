import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Question } from '../lib/types'
import { QuestionCard } from './QuestionCard'
import { AiGradePanel } from './AiQaPanel'
import { Bar, Tag } from './ui'
import { useStore } from '../store/StoreContext'

export interface RunnerHandle {
  /** Reserved for parent-driven control (e.g. mock-exam timer callbacks). */
  readonly _brand?: unique symbol
}

interface Props {
  questions: Question[]
  mode: string
  sessionId: string
  /** immediate feedback (practice modes) vs deferred (mock) */
  immediateFeedback?: boolean
  /** mock mode: no per-question history write until submit-all */
  deferred?: boolean
  /** answer map controlled externally (mock exam) */
  answers?: Record<string, string | null>
  onAnswer?: (qid: string, v: string | null) => void
  onFinish?: () => void
  finishLabel?: string
  /** used for AI-review persistence */
  saveAiReview?: (qid: string, answer: string, result: unknown) => Promise<void>
}

export function QuestionRunner({
  questions,
  mode,
  sessionId,
  immediateFeedback = true,
  deferred = false,
  answers,
  onAnswer,
  onFinish,
  finishLabel = '完成训练',
  saveAiReview,
}: Props) {
  const { submitAnswer, saveSubjectiveAttempt } = useStore()
  const [idx, setIdx] = useState(0)
  const [reveal, setReveal] = useState(false)
  const [lastResult, setLastResult] = useState<{ isCorrect: boolean | null } | null>(null)
  const [results, setResults] = useState<Record<string, boolean | null>>({})
  const local = useRef<Record<string, string | null>>({})
  const answersRef = useRef<Record<string, string | null>>(answers ?? {})

  const q = questions[Math.min(idx, questions.length - 1)]
  const value = (deferred ? answers?.[q.id] : local.current[q.id]) ?? null

  const setValue = useCallback(
    (v: string | null) => {
      if (deferred) {
        answersRef.current[q.id] = v
        onAnswer?.(q.id, v)
      } else {
        local.current[q.id] = v
        setTick((t) => t + 1)
      }
    },
    [deferred, onAnswer, q.id],
  )

  // force re-render when local answers change
  const [, setTick] = useState(0)

  useEffect(() => {
    setReveal(false)
    setLastResult(null)
  }, [idx])

  const stats = useMemo(() => {
    const done = Object.keys(results).length
    const ok = Object.values(results).filter((v) => v === true).length
    return { done, ok, bad: done - ok }
  }, [results])

  const submit = async () => {
    if (!q) return
    if (q.type === 'short' || q.type === 'material') {
      const ans = value ?? ''
      if (!deferred) {
        await saveSubjectiveAttempt(q, ans, mode, sessionId, !!saveAiReview)
      }
      setResults((r) => ({ ...r, [q.id]: null }))
      setLastResult({ isCorrect: null })
      if (immediateFeedback) setReveal(true)
      return
    }
    if (deferred) {
      setResults((r) => ({ ...r, [q.id]: null }))
      setLastResult({ isCorrect: null })
      setReveal(true)
      return
    }
    const out = await submitAnswer(q, value, mode, sessionId, !!saveAiReview)
    setResults((r) => ({ ...r, [q.id]: out.isCorrect }))
    setLastResult(out)
    if (immediateFeedback) setReveal(true)
  }

  const next = () => {
    if (idx + 1 >= questions.length) {
      onFinish?.()
      return
    }
    setIdx((i) => i + 1)
  }

  if (!q) return null

  const isSubjective = q.type === 'short' || q.type === 'material'

  return (
    <div>
      <div className="row-between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="muted">
            第 {idx + 1} / {questions.length} 题
          </span>
          <Tag tone="plain">{mode === 'mock' ? '模拟考试' : mode === 'review' ? '错题复刷' : '练习'}</Tag>
        </div>
        <div className="muted-2">
          已答 {stats.done} · 对 {stats.ok} · 错 {stats.bad}
        </div>
      </div>
      <Bar value={questions.length ? stats.done / questions.length : 0} tone="accent" />
      <div className="progress-dots">
        {questions.map((qq, i) => {
          const r = results[qq.id]
          const cls = r === true ? 'ok' : r === false ? 'bad' : r === null ? 'ok' : ''
          return <i key={qq.id} className={`${cls} ${i === idx ? 'cur' : ''}`} />
        })}
      </div>

      <QuestionCard
        q={q}
        value={value}
        onChange={setValue}
        reveal={reveal}
        isCorrect={lastResult?.isCorrect ?? null}
        showAnswer
      />

      {reveal && isSubjective && (
        <div style={{ marginTop: 12 }}>
          <AiGradePanel q={q} userAnswer={value ?? ''} sessionId={sessionId} />
        </div>
      )}

      <div className="btn-row" style={{ marginTop: 16 }}>
        {!reveal ? (
          <button className="btn btn-primary btn-lg" onClick={submit} disabled={!value}>
            提交答案
          </button>
        ) : (
          <>
            <button className="btn btn-primary btn-lg" onClick={next}>
              {idx + 1 >= questions.length ? finishLabel : '下一题'}
            </button>
            {immediateFeedback && !deferred && (
              <button
                className="btn"
                onClick={() => {
                  setReveal(false)
                }}
                disabled
              >
                重新作答不可用
              </button>
            )}
          </>
        )}
        <button
          className="btn btn-ghost"
          onClick={() => {
            setIdx((i) => Math.max(0, i - 1))
          }}
          disabled={idx === 0}
        >
          上一题
        </button>
      </div>
    </div>
  )
}
