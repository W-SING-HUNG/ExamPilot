import { useRef, useState } from 'react'
import type { Question } from '../lib/types'
import { aiAskQuestion, aiGrade } from '../lib/ai'
import { useStore } from '../store/StoreContext'
import { Tag, TypingDots } from './ui'

/**
 * AI Q&A for the current question.
 *
 * The request is genuinely cancellable: `ask` keeps its AbortController so the
 * Stop button aborts the fetch rather than merely hiding the spinner. Partial
 * output is never fabricated — this endpoint returns one JSON document, so the
 * answer appears in one piece once it arrives.
 */
export function AiQaPanel({ q, userAnswer }: { q: Question; userAnswer: string }) {
  const [loading, setLoading] = useState(false)
  const [out, setOut] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [cancelled, setCancelled] = useState(false)
  const ctrlRef = useRef<AbortController | null>(null)

  const ask = async () => {
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    setOut(null)
    setReason(null)
    setCancelled(false)
    const res = await aiAskQuestion(
      {
        question: {
          type: q.type,
          stem: q.stem,
          options: q.options,
          answer: q.hasOfficialAnswer
            ? String(q.answerNorm === true ? '正确' : q.answerNorm === false ? '错误' : q.answerNorm)
            : null,
        },
        userAnswer,
        questionContext: { chapter: q.chapter, bankNo: q.bankNo },
      },
      ctrl.signal,
    )
    // A cancelled request must not overwrite the panel with an error.
    if (ctrl.signal.aborted) {
      setLoading(false)
      setCancelled(true)
      return
    }
    setLoading(false)
    if (res.ok) setOut(res.answer ?? '')
    else setReason(res.reason ?? '未知错误')
  }

  const stop = () => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
  }

  return (
    <div className="ai-box" style={{ marginTop: 12 }}>
      <div className="ai-head">
        <strong style={{ fontSize: 13.5 }}>AI 答疑</strong>
        <div className="btn-row">
          {loading ? (
            <button className="btn btn-sm" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="btn btn-sm" onClick={() => void ask()} disabled={loading}>
              提问
            </button>
          )}
        </div>
      </div>
      <div className="muted-2" style={{ marginBottom: 8 }}>
        客观题答案以题库为准，AI 仅解释原因，不会覆盖答案。
      </div>

      {loading && (
        <div className="bubble row" style={{ gap: 8, padding: '4px 0' }}>
          <TypingDots label="AI 正在思考…" />
        </div>
      )}

      {cancelled && !loading && (
        <div className="bubble muted-2" role="status">
          已取消本次请求。
        </div>
      )}

      {out && (
        <div className="ai-out bubble" role="region" aria-label="AI 答疑内容">
          {out}
        </div>
      )}

      {reason && !loading && (
        <div className="bubble muted" style={{ color: 'var(--bad)' }} role="alert">
          AI 不可用：{reason}
        </div>
      )}
    </div>
  )
}

/** AI reference grading for short/material questions. */
export function AiGradePanel({
  q,
  userAnswer,
  sessionId = 'ai-panel',
}: {
  q: Question
  userAnswer: string
  sessionId?: string
}) {
  const { saveAiReviewForQuestion } = useStore()
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<null | {
    score: number
    maxScore: number
    hitPoints: string[]
    missedPoints: string[]
    deductions: string[]
    suggestions: string[]
    structureNote: string
    disclaimer: string
  }>(null)
  const [reason, setReason] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const ctrlRef = useRef<AbortController | null>(null)

  const grade = async () => {
    const ctrl = new AbortController()
    ctrlRef.current = ctrl
    setLoading(true)
    setResult(null)
    setReason(null)
    setSaved(false)
    setCancelled(false)
    try {
      const r = await aiGrade(
        {
          qid: q.id,
          stem: q.stem,
          userAnswer,
          chapter: q.chapter,
          kind: q.type === 'short' ? 'short' : 'material',
        },
        ctrl.signal,
      )
      if (ctrl.signal.aborted) {
        setCancelled(true)
        return
      }
      if (r.ok && r.result) {
        setResult(r.result)
        // Saved in ONE transaction: the review row is keyed by (sessionId, qid),
        // and the training attempt is only created if this question has not
        // already been attempted in this session. Repeated reviews therefore
        // never inflate the attempt count.
        try {
          await saveAiReviewForQuestion(q, userAnswer, sessionId, r.provider ?? 'sub2api', r.model ?? '', r.result)
          setSaved(true)
        } catch (e) {
          setReason(`评阅结果已生成，但保存失败：${(e as Error).message}`)
        }
      } else {
        setReason(r.reason ?? '未知错误')
      }
    } finally {
      setLoading(false)
    }
  }

  const stop = () => {
    ctrlRef.current?.abort()
    ctrlRef.current = null
  }

  return (
    <div className="ai-box" style={{ marginTop: 12 }}>
      <div className="ai-head">
        <strong style={{ fontSize: 13.5 }}>AI 参考评阅</strong>
        <div className="btn-row">
          {loading ? (
            <button className="btn btn-sm" onClick={stop}>
              停止评阅
            </button>
          ) : (
            <button className="btn btn-sm btn-primary" onClick={() => void grade()} disabled={loading}>
              提交 AI 评阅
            </button>
          )}
        </div>
      </div>
      <div className="muted-2" style={{ marginBottom: 8 }}>
        AI 评阅仅为参考评阅，非官方标准分数；题库未提供本题标准答案。
      </div>

      {loading && (
        <div className="bubble" style={{ padding: '4px 0' }} role="status" aria-live="polite">
          <TypingDots label="AI 正在评阅…" />
        </div>
      )}

      {cancelled && !loading && (
        <div className="bubble muted-2" role="status">
          已取消本次评阅，未产生分数与记录。
        </div>
      )}

      {result && (
        <div className="col bubble" style={{ gap: 12 }}>
          <div className="row" style={{ gap: 10 }}>
            <span className="stat-num" style={{ fontSize: 26 }}>
              {result.score}
            </span>
            <span className="muted">/ {result.maxScore}（参考分）</span>
            <Tag tone="accent">参考评阅</Tag>
          </div>
          <List title="命中的采分点" items={result.hitPoints} tone="ok" />
          <List title="遗漏内容" items={result.missedPoints} tone="bad" />
          <List title="扣分依据" items={result.deductions} tone="warn" />
          <List title="修改建议" items={result.suggestions} tone="accent" />
          {result.structureNote && <div className="explain">结构点评：{result.structureNote}</div>}
          <div className="muted-2">{result.disclaimer}</div>
          {saved && (
            <div className="muted-2" role="status">
              已保存你的原作答与本次评阅结果。
            </div>
          )}
        </div>
      )}

      {reason && !loading && (
        <div className="bubble muted" style={{ color: 'var(--bad)' }} role="alert">
          评阅未完成：{reason}
        </div>
      )}
    </div>
  )
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'bad' | 'warn' | 'accent' }) {
  if (!items.length) return null
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 650, marginBottom: 4 }}>
        <Tag tone={tone}>{title}</Tag>
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  )
}
