import { useState } from 'react'
import type { Question } from '../lib/types'
import { aiAskQuestion, aiGrade } from '../lib/ai'
import { Tag } from './ui'

/** AI Q&A for the current question. Objective answers always come from the bank. */
export function AiQaPanel({ q, userAnswer }: { q: Question; userAnswer: string }) {
  const [loading, setLoading] = useState(false)
  const [out, setOut] = useState<string | null>(null)
  const [reason, setReason] = useState<string | null>(null)

  const ask = async () => {
    setLoading(true)
    setOut(null)
    setReason(null)
    const res = await aiAskQuestion({
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
    })
    setLoading(false)
    if (res.ok) setOut(res.answer ?? '')
    else setReason(res.reason ?? '未知错误')
  }

  return (
    <div className="ai-box" style={{ marginTop: 10 }}>
      <div className="ai-head">
        <strong style={{ fontSize: 13.5 }}>AI 答疑</strong>
        <button className="btn btn-sm" onClick={ask} disabled={loading}>
          {loading ? '请求中…' : '提问'}
        </button>
      </div>
      <div className="muted-2" style={{ marginBottom: 6 }}>
        客观题答案以题库为准，AI 仅解释原因，不会覆盖答案。
      </div>
      {out && <div className="ai-out">{out}</div>}
      {reason && (
        <div className="muted" style={{ color: 'var(--bad)' }}>
          AI 不可用：{reason}
        </div>
      )}
    </div>
  )
}

/** AI reference grading for short/material questions. */
export function AiGradePanel({ q, userAnswer }: { q: Question; userAnswer: string }) {
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

  const grade = async () => {
    setLoading(true)
    setResult(null)
    setReason(null)
    const r = await aiGrade({
      qid: q.id,
      stem: q.stem,
      userAnswer,
      chapter: q.chapter,
      kind: q.type === 'short' ? 'short' : 'material',
    })
    setLoading(false)
    if (r.ok && r.result) setResult(r.result)
    else setReason(r.reason ?? '未知错误')
  }

  return (
    <div className="ai-box" style={{ marginTop: 10 }}>
      <div className="ai-head">
        <strong style={{ fontSize: 13.5 }}>AI 参考评阅</strong>
        <button className="btn btn-sm btn-primary" onClick={grade} disabled={loading}>
          {loading ? '评阅中…' : '提交 AI 评阅'}
        </button>
      </div>
      <div className="muted-2" style={{ marginBottom: 8 }}>
        AI 评阅仅为参考评阅，非官方标准分数；题库未提供本题标准答案。
      </div>
      {result && (
        <div className="col" style={{ gap: 10 }}>
          <div className="row" style={{ gap: 12 }}>
            <span className="stat-num" style={{ fontSize: 24 }}>
              {result.score}
            </span>
            <span className="muted">/ {result.maxScore}（参考分）</span>
          </div>
          <List title="命中的采分点" items={result.hitPoints} tone="ok" />
          <List title="遗漏内容" items={result.missedPoints} tone="bad" />
          <List title="扣分依据" items={result.deductions} tone="warn" />
          <List title="修改建议" items={result.suggestions} tone="accent" />
          {result.structureNote && <div className="explain">结构点评：{result.structureNote}</div>}
          <div className="muted-2">{result.disclaimer}</div>
        </div>
      )}
      {reason && (
        <div className="muted" style={{ color: 'var(--bad)' }}>
          AI 不可用：{reason}
        </div>
      )}
    </div>
  )
}

function List({ title, items, tone }: { title: string; items: string[]; tone: 'ok' | 'bad' | 'warn' | 'accent' }) {
  if (!items.length) return null
  return (
    <div>
      <div style={{ fontSize: 12.5, fontWeight: 700, marginBottom: 4 }}>
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
