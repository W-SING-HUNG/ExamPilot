import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, questionsOfType, TYPE_LABEL } from '../lib/bank'
import { computeDiagnosis } from '../lib/analysis'
import { selectQuestions } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { Bar, CardPad, PageHead, Tag } from '../components/ui'
import type { Question, QuestionType } from '../lib/types'

const TYPES: QuestionType[] = ['single', 'multi', 'judge']
const TYPE_TIP: Record<string, string> = {
  single: '单选题：只选一个最符合题意的选项。',
  multi: '多选题：必须与答案集合完全一致，错选、漏选均判错。',
  judge: '判断题：注意绝对化表述与偷换概念。',
}

export function Special({ params }: { params: Record<string, string> }) {
  const { records, ready } = useStore()
  const [type, setType] = useState<QuestionType>((params.type as QuestionType) ?? 'single')
  const [count, setCount] = useState(15)
  const [chapters, setChapters] = useState<string[]>([])
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')

  const diag = useMemo(() => computeDiagnosis(allQuestions, records as never), [records])
  const typeStat = diag.types.find((t) => t.type === type)!

  const pool = useMemo(() => {
    const base = questionsOfType(type)
    return chapters.length ? base.filter((q) => chapters.includes(q.chapter)) : base
  }, [type, chapters])

  const chapterOptions = useMemo(() => {
    const set = new Set<string>()
    for (const q of questionsOfType(type)) set.add(q.chapter)
    return Array.from(set)
  }, [type])

  const start = () => {
    if (pool.length === 0) return
    const picked = selectQuestions({
      pool,
      records: records as never,
      now: Date.now(),
      count: Math.min(count, pool.length),
    })
    setSession(picked)
    setSessionId(`s-${Date.now()}`)
  }

  const toggleChapter = (ch: string) =>
    setChapters((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]))

  if (!ready) return null

  return (
    <>
      <PageHead
        title="专项训练"
        desc="针对单选、多选、判断三类客观题进行专项强化。选题优先覆盖未做与做错的题目，而不是只刷已掌握的题。"
      />

      {!session && (
        <CardPad>
          <div className="card-title">选择题型</div>
          <div className="btn-row" style={{ marginBottom: 10 }}>
            {TYPES.map((t) => (
              <button key={t} className={`btn ${type === t ? 'btn-primary' : ''}`} onClick={() => setType(t)}>
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
          <div className="muted" style={{ marginBottom: 14 }}>
            {TYPE_TIP[type]}
          </div>

          <div className="row-between" style={{ marginBottom: 14 }}>
            <div className="muted">
              共 {typeStat.total} 题 · 已练 {typeStat.attempted} · 正确率{' '}
              {typeStat.correctRate ? Math.round(typeStat.correctRate * 100) + '%' : '—'} · 难点 {typeStat.struggling}
            </div>
            <Tag tone={typeStat.coverage > 0.8 ? 'ok' : 'warn'}>覆盖率 {Math.round(typeStat.coverage * 100)}%</Tag>
          </div>
          <Bar value={typeStat.coverage} tone={typeStat.coverage > 0.8 ? 'ok' : 'accent'} />

          <div className="divider" />
          <div className="card-title">章节范围（不选 = 全部）</div>
          <div className="pill-scroll" style={{ marginBottom: 14 }}>
            {chapterOptions.map((ch) => (
              <button
                key={ch}
                className={`btn btn-sm ${chapters.includes(ch) ? 'btn-primary' : ''}`}
                onClick={() => toggleChapter(ch)}
              >
                {ch}
              </button>
            ))}
            {chapters.length > 0 && (
              <button className="btn btn-sm btn-ghost" onClick={() => setChapters([])}>
                清空
              </button>
            )}
          </div>

          <div className="card-title">每组题量</div>
          <div className="btn-row">
            {[10, 15, 20, 30, 50, 100].map((n) => (
              <button key={n} className={`btn btn-sm ${count === n ? 'btn-primary' : ''}`} onClick={() => setCount(n)}>
                {n} 题
              </button>
            ))}
            <span className="muted-2">可用 {pool.length} 题</span>
          </div>

          <div className="divider" />
          <button className="btn btn-primary btn-lg" onClick={start} disabled={pool.length === 0}>
            开始专项训练（{Math.min(count, pool.length)} 题）
          </button>
        </CardPad>
      )}

      {session && (
        <QuestionRunner
          questions={session}
          mode="special"
          sessionId={sessionId}
          immediateFeedback
          onFinish={() => setSession(null)}
          finishLabel="完成本组"
        />
      )}
    </>
  )
}
