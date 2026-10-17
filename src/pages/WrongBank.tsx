import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { selectQuestions } from '../lib/scheduler'
import { QuestionRunner } from '../components/QuestionRunner'
import { Bar, CardPad, PageHead, Tag, Empty, useConfirm } from '../components/ui'
import type { Question } from '../lib/types'
import type { RouteName } from '../store/router'

export function WrongBank({
  nav,
  params,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { records, ready, clearWrong } = useStore()
  const { confirm, confirmEl } = useConfirm()
  const [session, setSession] = useState<Question[] | null>(null)
  const [sessionId, setSessionId] = useState('')
  const [chapter, setChapter] = useState<string>(params.chapter ?? '')
  const [filter, setFilter] = useState<'wrong' | 'struggling' | 'all-attempted'>(params.chapter ? 'wrong' : 'wrong')
  const [count, setCount] = useState(10)

  const wrongQuestions = useMemo(() => {
    const list: Question[] = []
    for (const q of allQuestions) {
      const r = records.get(q.id)
      if (!r || r.attempts === 0) continue
      if (filter === 'wrong' && r.wrongCount > 0) list.push(q)
      else if (filter === 'struggling' && r.status === 'struggling') list.push(q)
      else if (filter === 'all-attempted') list.push(q)
    }
    if (chapter) return list.filter((q) => q.chapter === chapter)
    return list
  }, [records, filter, chapter])

  const byChapter = useMemo(() => {
    const m = new Map<string, { wrong: number; struggling: number; mastered: number; attempted: number }>()
    for (const q of allQuestions) {
      const r = records.get(q.id)
      if (!r || r.attempts === 0) continue
      const e = m.get(q.chapter) ?? { wrong: 0, struggling: 0, mastered: 0, attempted: 0 }
      if (r.wrongCount > 0) e.wrong++
      if (r.status === 'struggling') e.struggling++
      if (r.status === 'mastered') e.mastered++
      e.attempted++
      m.set(q.chapter, e)
    }
    return m
  }, [records])

  const totalWrong = useMemo(() => {
    let n = 0
    for (const q of allQuestions) {
      const r = records.get(q.id)
      if (r && r.wrongCount > 0) n++
    }
    return n
  }, [records])

  const start = () => {
    if (wrongQuestions.length === 0) return
    const picked = selectQuestions({
      pool: wrongQuestions,
      records,
      now: Date.now(),
      count: Math.min(count, wrongQuestions.length),
    })
    setSession(picked)
    setSessionId(`s-${Date.now()}`)
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="错题本"
        desc="只收录真实作答中答错的题目。未做过的题目不会出现在这里——它们应当通过覆盖训练补齐。"
        extra={<Tag tone={totalWrong > 0 ? 'bad' : 'ok'}>{totalWrong} 道待清除</Tag>}
      />

      {!session && (
        <>
          <CardPad>
            <div className="card-title">复刷范围</div>
            <div className="btn-row" style={{ marginBottom: 12 }}>
              {(
                [
                  ['wrong', '答错过'],
                  ['struggling', '难点题'],
                  ['all-attempted', '所有做过的'],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  className={`btn btn-sm ${filter === k ? 'btn-primary' : ''}`}
                  onClick={() => setFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="pill-scroll" style={{ marginBottom: 14 }}>
              <button className={`btn btn-sm ${chapter === '' ? 'btn-primary' : ''}`} onClick={() => setChapter('')}>
                全部章节
              </button>
              {chapterOrder.map((ch) => {
                const e = byChapter.get(ch)
                return (
                  <button
                    key={ch}
                    className={`btn btn-sm ${chapter === ch ? 'btn-primary' : ''}`}
                    onClick={() => setChapter(ch)}
                    disabled={!e}
                    title={e ? `错 ${e.wrong} · 难点 ${e.struggling}` : '暂无症状'}
                  >
                    {ch}
                    {e?.wrong ? ` (${e.wrong})` : ''}
                  </button>
                )
              })}
            </div>

            <div className="card-title">复刷题量</div>
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
              <span className="muted-2">符合条件 {wrongQuestions.length} 题</span>
            </div>

            <div className="divider" />
            <div className="btn-row">
              <button className="btn btn-primary btn-lg" onClick={start} disabled={wrongQuestions.length === 0}>
                开始复刷（{Math.min(count, wrongQuestions.length)} 题）
              </button>
              <button className="btn" onClick={() => nav('practice')}>
                补充覆盖训练
              </button>
              {totalWrong > 0 && (
                <button
                  className="btn btn-danger"
                  onClick={async () => {
                    const qids = allQuestions.filter((q) => (records.get(q.id)?.wrongCount ?? 0) > 0).map((q) => q.id)
                    const ok = await confirm({
                      title: '清空全部错题记录？',
                      body: `将从 ${qids.length} 道题上清除错误计数，这些题目会重新回到普通练习池。此操作不可撤销。`,
                      confirmLabel: '清空错题',
                      danger: true,
                    })
                    if (!ok) return
                    void clearWrong(qids)
                  }}
                >
                  清空错题记录
                </button>
              )}
            </div>
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">各章节错题分布</div>
            {byChapter.size === 0 ? (
              <Empty text="暂无错题记录。做错题目后会自动收录到这里。" />
            ) : (
              <div className="col" style={{ gap: 10 }}>
                {Array.from(byChapter.entries())
                  .sort((a, b) => b[1].wrong - a[1].wrong)
                  .map(([ch, e]) => (
                    <div key={ch}>
                      <div className="row-between" style={{ marginBottom: 4 }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          style={{ padding: '2px 6px' }}
                          onClick={() => setChapter(ch)}
                        >
                          {ch}
                        </button>
                        <span className="muted-2">
                          答错 {e.wrong} · 难点 {e.struggling} · 掌握 {e.mastered}
                        </span>
                      </div>
                      <Bar value={e.attempted ? e.wrong / e.attempted : 0} tone="bad" />
                    </div>
                  ))}
              </div>
            )}
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">错题清单（{wrongQuestions.length}）</div>
            {wrongQuestions.length === 0 ? (
              <Empty text="当前筛选下没有错题。" />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>题号</th>
                      <th>题型</th>
                      <th>章节</th>
                      <th>题干</th>
                      <th>答错次数</th>
                      <th>状态</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wrongQuestions.slice(0, 60).map((q) => {
                      const r = records.get(q.id)!
                      return (
                        <tr key={q.id}>
                          <td className="code">{q.bankNo}</td>
                          <td>
                            <Tag>{TYPE_LABEL[q.type]}</Tag>
                          </td>
                          <td>{q.chapter}</td>
                          <td
                            style={{
                              maxWidth: 340,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {q.stem.split('\n')[0]}
                          </td>
                          <td>
                            <b style={{ color: 'var(--bad)' }}>{r.wrongCount}</b>
                          </td>
                          <td>
                            <Tag tone={r.status === 'struggling' ? 'bad' : r.status === 'mastered' ? 'ok' : 'warn'}>
                              {r.status === 'struggling' ? '难点' : r.status === 'mastered' ? '已掌握' : '巩固中'}
                            </Tag>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardPad>
        </>
      )}

      {session && (
        <QuestionRunner
          questions={session}
          mode="review"
          sessionId={sessionId}
          immediateFeedback
          onFinish={() => setSession(null)}
          finishLabel="完成复刷"
        />
      )}
      {confirmEl}
    </>
  )
}
