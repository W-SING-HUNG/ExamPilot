import { useMemo, useState } from 'react'
import type { Question } from '../lib/types'
import { TYPE_LABEL } from '../lib/bank'
import { answerText } from '../lib/scoring'
import { Tag } from './ui'
import { AiQaPanel } from './AiQaPanel'

interface Props {
  q: Question
  /** current selection, controlled by parent so mock-exam persistence works */
  value: string | null
  onChange: (v: string | null) => void
  /** show correctness feedback */
  reveal?: boolean
  isCorrect?: boolean | null
  /** display the answer block after submit */
  showAnswer?: boolean
  /** subjective mode: free text area */
  freeText?: boolean
}

export function QuestionCard({
  q,
  value,
  onChange,
  reveal = false,
  isCorrect = null,
  showAnswer = false,
  freeText = false,
}: Props) {
  const [showAi, setShowAi] = useState(false)

  const selected = useMemo(() => {
    if (q.type === 'judge') return value
    return value ?? ''
  }, [value, q.type])

  const answerSet = useMemo(() => {
    if (q.type !== 'single' && q.type !== 'multi') return new Set<string>()
    return new Set(String(q.answerNorm ?? '').split(''))
  }, [q.answerNorm, q.type])
  const chosenSet = useMemo(() => new Set((selected ?? '').split('')), [selected])

  const head = (
    <>
      <div className="q-stem">{q.stem}</div>
      <div className="q-meta">
        <Tag tone="accent">{TYPE_LABEL[q.type]}</Tag>
        <Tag>{q.chapter}</Tag>
        <Tag>原题 {q.bankNo}</Tag>
        {q.pageStart && (
          <Tag>
            PDF 第 {q.pageStart}
            {q.pageEnd && q.pageEnd !== q.pageStart ? `–${q.pageEnd}` : ''} 页
          </Tag>
        )}
        {q.isFlagged && <Tag tone="warn">{q.flagReason || '需人工确认'}</Tag>}
      </div>
    </>
  )

  return (
    <div className="card card-pad">
      {head}
      {reveal && (
        <div className={`result-banner ${isCorrect === true ? 'ok' : isCorrect === false ? 'bad' : 'warn'}`}>
          {isCorrect === true ? '回答正确' : isCorrect === false ? '回答错误' : '本题未自动评分'}
          {showAnswer && q.hasOfficialAnswer && (
            <span style={{ fontWeight: 400 }}>
              正确答案：<b>{answerText(q)}</b>
            </span>
          )}
        </div>
      )}

      {freeText || q.type === 'short' || q.type === 'material' ? (
        <textarea
          className="textarea"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value || null)}
          placeholder="请作答：建议分点书写，先列核心概念，再结合材料分析……"
          disabled={reveal}
        />
      ) : q.type === 'judge' ? (
        <div className="judge-row">
          {[
            ['正确', 'true'],
            ['错误', 'false'],
          ].map(([label, v]) => {
            const isSel = selected === v
            const cls = reveal
              ? v === (q.answerNorm ? 'true' : 'false')
                ? 'correct'
                : isSel
                  ? 'wrong'
                  : ''
              : isSel
                ? 'selected'
                : ''
            return (
              <button key={v} className={`judge-btn ${cls}`} onClick={() => onChange(v)} disabled={reveal}>
                {label}
              </button>
            )
          })}
        </div>
      ) : (
        <div role={q.type === 'multi' ? 'group' : 'radiogroup'} aria-label="选项">
          {q.options.map((opt, i) => {
            const key = String.fromCharCode(65 + i)
            const isSel = chosenSet.has(key)
            let cls = ''
            if (reveal) {
              if (answerSet.has(key)) cls = 'correct'
              else if (isSel) cls = 'wrong'
            } else if (isSel) cls = 'selected'
            const stateLabel = reveal ? (answerSet.has(key) ? '（正确答案）' : isSel ? '（你的选择，错误）' : '') : ''
            return (
              <button
                key={key}
                type="button"
                className={`opt ${cls}`}
                aria-pressed={q.type === 'multi' ? isSel : undefined}
                aria-checked={q.type === 'single' ? isSel : undefined}
                role={q.type === 'multi' ? 'checkbox' : q.type === 'single' ? 'radio' : undefined}
                onClick={() => {
                  if (reveal) return
                  if (q.type === 'single') onChange(key)
                  else {
                    const cur = new Set((value ?? '').split(''))
                    if (cur.has(key)) cur.delete(key)
                    else cur.add(key)
                    onChange(Array.from(cur).sort().join(''))
                  }
                }}
                disabled={reveal}
              >
                <span className="opt-key" aria-hidden="true">
                  {key}
                </span>
                <span className="opt-text">
                  {opt}
                  {stateLabel && <span className="sr-only">{stateLabel}</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {reveal && (
        <>
          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn btn-sm" onClick={() => setShowAi((s) => !s)}>
              {showAi ? '收起 AI 答疑' : 'AI 题目答疑 / 错误原因'}
            </button>
            {!q.hasOfficialAnswer && <Tag tone="warn">本题题库无标准答案，AI 仅作参考</Tag>}
          </div>
          {showAi && <AiQaPanel q={q} userAnswer={value ?? ''} />}
        </>
      )}
    </div>
  )
}
