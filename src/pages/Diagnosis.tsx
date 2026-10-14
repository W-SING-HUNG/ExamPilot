import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, objectiveQuestions, subjectiveQuestions, TYPE_LABEL } from '../lib/bank'
import { computeDiagnosis, groupActivity } from '../lib/analysis'
import { Bar, CardPad, PageHead, Tag, Empty } from '../components/ui'
import type { RouteName } from '../store/router'

export function Diagnosis({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { records, history, ready } = useStore()
  const [tab, setTab] = useState<'chapter' | 'type' | 'activity'>('chapter')

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const activity = useMemo(() => groupActivity(history, 30), [history])

  const perQuestionWrong = useMemo(() => {
    const list: { qid: string; stem: string; chapter: string; type: string; wrong: number }[] = []
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (r && r.wrongCount > 0)
        list.push({ qid: q.id, stem: q.stem.split('\n')[0], chapter: q.chapter, type: q.type, wrong: r.wrongCount })
    }
    return list.sort((a, b) => b.wrong - a.wrong)
  }, [records])

  if (!ready) return null

  return (
    <>
      <PageHead
        title="学习诊断与薄弱点分析"
        desc="全部指标来自真实作答数据：覆盖率、正确率、错误次数与复习间隔。系统不生成预测分数，也不虚构掌握率。"
      />

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <CardPad>
          <div className="stat-num">{diag.overall.attempted}</div>
          <div className="stat-label">已练客观题</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">{diag.overall.correct + diag.overall.wrong}</div>
          <div className="stat-label">累计客观题作答</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">{diag.overall.wrong}</div>
          <div className="stat-label">累计答错</div>
        </CardPad>
        <CardPad>
          <div className="stat-num">
            {diag.overall.correctRate ? Math.round(diag.overall.correctRate * 100) + '%' : '—'}
          </div>
          <div className="stat-label">客观题正确率</div>
        </CardPad>
      </div>

      <CardPad>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          {(
            [
              ['chapter', '按章节'],
              ['type', '按题型'],
              ['activity', '学习活动'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} className={`btn btn-sm ${tab === k ? 'btn-primary' : ''}`} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>

        {tab === 'chapter' && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>章节</th>
                  <th>题量</th>
                  <th>已练</th>
                  <th>覆盖率</th>
                  <th>作答</th>
                  <th>答错</th>
                  <th>正确率</th>
                  <th>掌握</th>
                  <th>难点</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {diag.chapters.map((c) => (
                  <tr key={c.chapter}>
                    <td>
                      <b>{c.chapter}</b>
                    </td>
                    <td>{c.total}</td>
                    <td>{c.attempted}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div style={{ width: 64 }}>
                          <Bar
                            value={c.coverage}
                            tone={c.coverage > 0.8 ? 'ok' : c.coverage > 0.4 ? 'accent' : 'bad'}
                          />
                        </div>
                        <span>{Math.round(c.coverage * 100)}%</span>
                      </div>
                    </td>
                    <td>{c.correct + c.wrong}</td>
                    <td style={{ color: c.wrong ? 'var(--bad)' : undefined }}>{c.wrong}</td>
                    <td>{c.correct + c.wrong ? Math.round(c.correctRate * 100) + '%' : '—'}</td>
                    <td>{c.mastered}</td>
                    <td style={{ color: c.struggling ? 'var(--bad)' : undefined }}>{c.struggling}</td>
                    <td>
                      <button className="btn btn-sm" onClick={() => nav('practice', { chapter: c.chapter })}>
                        练习
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'type' && (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>题型</th>
                  <th>题量</th>
                  <th>已练</th>
                  <th>覆盖率</th>
                  <th>作答</th>
                  <th>正确率</th>
                  <th>掌握</th>
                  <th>难点</th>
                </tr>
              </thead>
              <tbody>
                {diag.types.map((t) => (
                  <tr key={t.type}>
                    <td>
                      <b>{t.label}</b>
                    </td>
                    <td>{t.total}</td>
                    <td>{t.attempted}</td>
                    <td>
                      <div className="row" style={{ gap: 8 }}>
                        <div style={{ width: 64 }}>
                          <Bar value={t.coverage} tone={t.coverage > 0.8 ? 'ok' : 'accent'} />
                        </div>
                        <span>{Math.round(t.coverage * 100)}%</span>
                      </div>
                    </td>
                    <td>{t.correct + t.wrong}</td>
                    <td>
                      {t.correct + t.wrong
                        ? Math.round(t.correctRate * 100) + '%'
                        : t.type === 'short' || t.type === 'material'
                          ? 'AI 参考评阅'
                          : '—'}
                    </td>
                    <td>{t.mastered}</td>
                    <td>{t.struggling}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {tab === 'activity' && (
          <>
            <div className="col" style={{ gap: 6 }}>
              {activity
                .slice()
                .reverse()
                .map((d) => (
                  <div key={d.date} className="row-between">
                    <span className="muted" style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {d.date}
                    </span>
                    <div style={{ flex: 1, margin: '0 10px' }}>
                      <Bar value={d.count / Math.max(20, ...activity.map((x) => x.count), 1)} tone="accent" />
                    </div>
                    <span className="muted-2" style={{ width: 110, textAlign: 'right' }}>
                      {d.count} 题（对 {d.correct} / 错 {d.wrong}）
                    </span>
                  </div>
                ))}
            </div>
            <div className="divider" />
            <div className="muted">
              主观题训练进度：{diag.overall.subjectiveAttempted} / {subjectiveQuestions.length} 道已训练。
            </div>
          </>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">薄弱点排序（基于真实数据）</div>
        {diag.weakPoints.length === 0 ? (
          <Empty text="暂无足够数据生成薄弱点排序，先完成一些练习。" />
        ) : (
          <div className="grid grid-2">
            {diag.weakPoints.map((w, i) => (
              <div key={w.chapter} className="card card-pad row-between" style={{ boxShadow: 'none' }}>
                <div>
                  <div className="row" style={{ gap: 8 }}>
                    <b>
                      {i + 1}. {w.chapter}
                    </b>
                    <Tag tone={w.score < 50 ? 'bad' : w.score < 70 ? 'warn' : 'ok'}>掌握指数 {w.score}</Tag>
                  </div>
                  <div className="muted-2" style={{ marginTop: 4 }}>
                    {w.detail}
                  </div>
                </div>
                <button className="btn btn-sm" onClick={() => nav('practice', { chapter: w.chapter })}>
                  练习
                </button>
              </div>
            ))}
          </div>
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">高频错误题目 TOP 15</div>
        {perQuestionWrong.length === 0 ? (
          <Empty text="还没有错题记录。" />
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>章节</th>
                  <th>题型</th>
                  <th>题干</th>
                  <th>答错次数</th>
                  <th>最近状态</th>
                </tr>
              </thead>
              <tbody>
                {perQuestionWrong.slice(0, 15).map((w) => {
                  const r = records.get(w.qid)!
                  return (
                    <tr key={w.qid}>
                      <td>{w.chapter}</td>
                      <td>
                        <Tag>{TYPE_LABEL[w.type as keyof typeof TYPE_LABEL] ?? w.type}</Tag>
                      </td>
                      <td style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {w.stem}
                      </td>
                      <td>
                        <b style={{ color: 'var(--bad)' }}>{w.wrong}</b>
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

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">下一步建议</div>
        <div className="col" style={{ gap: 8 }}>
          {diag.overall.coverage < 0.6 && (
            <Advice
              text={`题库覆盖率仅 ${Math.round(diag.overall.coverage * 100)}%：先用分章练习或专项训练把未做题目补齐，避免只刷错题。`}
              action={{ label: '分章练习', route: 'practice' }}
              nav={nav}
            />
          )}
          {diag.types.find((t) => t.type === 'multi')!.correctRate < 0.7 &&
            diag.types.find((t) => t.type === 'multi')!.attempted > 0 && (
              <Advice
                text="多选题正确率偏低：多选必须选项集合完全一致，错选漏选都判错。建议专项训练并逐项核对选项。"
                action={{ label: '多选专项', route: 'special', params: { type: 'multi' } }}
                nav={nav}
              />
            )}
          {diag.overall.subjectiveAttempted < 3 && (
            <Advice
              text="主观题训练不足：简答与材料题需要练习答题结构与采分点组织，建议每天至少 1 题。"
              action={{ label: '主观题训练', route: 'subjective' }}
              nav={nav}
            />
          )}
          {diag.weakPoints.length > 0 && (
            <Advice
              text={`优先补强：${diag.weakPoints
                .slice(0, 3)
                .map((w) => w.chapter)
                .join('、')}。`}
              action={{ label: '复习计划', route: 'plan' }}
              nav={nav}
            />
          )}
          {diag.weakPoints.length === 0 && diag.overall.coverage > 0.9 && (
            <Advice
              text="覆盖良好，可进入全真模拟考试检验整体表现与时间分配。"
              action={{ label: '全真模拟', route: 'mock' }}
              nav={nav}
            />
          )}
        </div>
      </CardPad>
    </>
  )
}

function Advice({
  text,
  action,
  nav,
}: {
  text: string
  action: { label: string; route: RouteName; params?: Record<string, string> }
  nav: (r: RouteName, p?: Record<string, string>) => void
}) {
  return (
    <div className="row-between">
      <span className="muted" style={{ flex: 1 }}>
        • {text}
      </span>
      <button className="btn btn-sm" onClick={() => nav(action.route, action.params)}>
        {action.label}
      </button>
    </div>
  )
}
