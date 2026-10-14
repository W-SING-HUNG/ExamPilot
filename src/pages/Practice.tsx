import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, questionsOfChapter, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { computeDiagnosis } from '../lib/analysis'
import { selectQuestions } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { Bar, CardPad, PageHead } from '../components/ui'
import type { Question, QuestionType } from '../lib/types'
import type { RouteName } from '../store/router'

export function Practice({
  nav,
  params,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { records, ready } = useStore()
  const [chapter, setChapter] = useState<string>(params.chapter ?? chapterOrder[0])
  const [types, setTypes] = useState<QuestionType[]>(['single', 'multi', 'judge'])
  const [count, setCount] = useState(10)
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')

  useEffect(() => {
    if (params.chapter) setChapter(params.chapter)
  }, [params.chapter])

  const chapterQs = useMemo(() => questionsOfChapter(chapter), [chapter])
  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const chapterStat = diag.chapters.find((c) => c.chapter === chapter)

  const pool = useMemo(() => chapterQs.filter((q) => types.includes(q.type)), [chapterQs, types])

  const start = () => {
    if (pool.length === 0) return
    const picked = selectQuestions({
      pool,
      records,
      now: Date.now(),
      count: Math.min(count, pool.length),
    })
    setSession(picked)
    setSessionId(`s-${Date.now()}`)
  }

  const toggleType = (t: QuestionType) => {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="分章练习"
        desc="按章节组织训练：先扩大覆盖，再定点强化错题。未做、正确、错误与掌握状态由真实作答驱动。"
      />

      {!session && (
        <>
          <CardPad>
            <div className="card-title">选择章节</div>
            <div className="pill-scroll" style={{ marginBottom: 14 }}>
              {chapterOrder.map((ch) => (
                <button
                  key={ch}
                  className={`btn btn-sm ${ch === chapter ? 'btn-primary' : ''}`}
                  onClick={() => setChapter(ch)}
                >
                  {ch}
                </button>
              ))}
            </div>

            {chapterStat && (
              <div className="row-between" style={{ marginBottom: 14 }}>
                <div className="muted">
                  {chapter}：{chapterStat.total} 题（单选 {chapterStat.single} · 多选 {chapterStat.multi} · 判断{' '}
                  {chapterStat.judge}）
                </div>
                <div className="row" style={{ gap: 12 }}>
                  <span className="muted-2">覆盖 {Math.round(chapterStat.coverage * 100)}%</span>
                  <span className="muted-2">
                    正确率 {chapterStat.attempted ? Math.round(chapterStat.correctRate * 100) + '%' : '—'}
                  </span>
                  <span className="muted-2">掌握 {chapterStat.mastered}</span>
                </div>
              </div>
            )}

            <div className="card-title">题型</div>
            <div className="btn-row" style={{ marginBottom: 14 }}>
              {(['single', 'multi', 'judge'] as QuestionType[]).map((t) => (
                <button
                  key={t}
                  className={`btn btn-sm ${types.includes(t) ? 'btn-primary' : ''}`}
                  onClick={() => toggleType(t)}
                >
                  {TYPE_LABEL[t]}
                </button>
              ))}
              <span className="muted-2">可选 {pool.length} 题</span>
            </div>

            <div className="card-title">每组题量</div>
            <div className="btn-row">
              {[5, 10, 20, 30, 50].map((n) => (
                <button
                  key={n}
                  className={`btn btn-sm ${count === n ? 'btn-primary' : ''}`}
                  onClick={() => setCount(n)}
                >
                  {n} 题
                </button>
              ))}
            </div>

            <div className="divider" />
            <div className="btn-row">
              <button className="btn btn-primary btn-lg" onClick={start} disabled={pool.length === 0}>
                开始练习（{Math.min(count, pool.length)} 题）
              </button>
              <button className="btn" onClick={() => nav('wrong')}>
                去看本章错题
              </button>
            </div>
            {pool.length === 0 && (
              <div className="muted" style={{ marginTop: 8, color: 'var(--warn)' }}>
                当前筛选下没有题目。
              </div>
            )}
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">本章各题型掌握情况</div>
            <div className="col" style={{ gap: 10 }}>
              {chapterQs.filter((q) => q.type !== 'short' && q.type !== 'material').length > 0 ? (
                (['single', 'multi', 'judge'] as QuestionType[]).map((t) => {
                  const list = chapterQs.filter((q) => q.type === t)
                  const recs = list.map((q) => records.get(q.id)).filter(Boolean)
                  const attempted = recs.filter((r) => r!.attempts > 0).length
                  const ok = recs.reduce((s, r) => s + r!.correctCount, 0)
                  const bad = recs.reduce((s, r) => s + r!.wrongCount, 0)
                  return (
                    <div key={t}>
                      <div className="row-between" style={{ marginBottom: 4 }}>
                        <span style={{ fontSize: 13.5 }}>{TYPE_LABEL[t]}</span>
                        <span className="muted-2">
                          {attempted}/{list.length} 已练 · 对 {ok} 错 {bad}
                        </span>
                      </div>
                      <Bar value={list.length ? attempted / list.length : 0} tone="accent" />
                    </div>
                  )
                })
              ) : (
                <div className="muted">本章题库无客观题。</div>
              )}
            </div>
          </CardPad>
        </>
      )}

      {session && (
        <QuestionRunner
          questions={session}
          mode="practice"
          sessionId={sessionId}
          immediateFeedback
          onFinish={() => setSession(null)}
          finishLabel="完成本组"
        />
      )}
    </>
  )
}
