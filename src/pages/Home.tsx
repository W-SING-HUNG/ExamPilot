import { useMemo } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, objectiveQuestions, subjectiveQuestions, chapterOrder } from '../lib/bank'
import { computeDiagnosis, groupActivity } from '../lib/analysis'
import { isDue } from '../lib/scheduler'
import { Bar, CardPad, PageHead, Stat, Tag, Empty, Reveal, SkStats, useDeferred } from '../components/ui'
import type { RouteName } from '../store/router'

/** A labelled progress row, used three times on this page. */
function ProgressLine({
  label,
  value,
  tone,
  text,
}: {
  label: string
  value: number
  tone: 'accent' | 'ok' | 'warn'
  text: string
}) {
  return (
    <div>
      <div className="row-between" style={{ marginBottom: 6 }}>
        <span className="muted" style={{ fontSize: 13 }}>
          {label}
        </span>
        <span className="muted-2" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {text}
        </span>
      </div>
      <Bar value={value} tone={tone} />
    </div>
  )
}

export function Home({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { records, history, mocks, ready } = useStore()

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const activity = useMemo(() => groupActivity(history, 7), [history])
  const todayCount = activity[activity.length - 1]?.count ?? 0

  // Due-ness uses the scheduler's own predicate so this counter can never
  // disagree with the plan or the review queue about what counts as overdue.
  const dueCount = useMemo(() => {
    const now = Date.now()
    let n = 0
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (r && isDue(r, now)) n++
    }
    return n
  }, [records])

  const neverTouched = useMemo(
    () => objectiveQuestions.filter((q) => !records.get(q.id) || records.get(q.id)!.attempts === 0).length,
    [records],
  )

  const masteredRatio = objectiveQuestions.length ? diag.overall.ourMastered / objectiveQuestions.length : 0
  const coverage = diag.overall.coverage
  const showSkeleton = useDeferred(!ready)

  if (showSkeleton) {
    return (
      <>
        <PageHead title="学习总览" desc="正在读取题库与学习记录…" />
        <SkStats n={4} />
        <div className="grid grid-2" style={{ marginTop: 14 }}>
          <CardPad>
            <div className="sk sk-title" />
            <div className="sk sk-line w-80" />
            <div className="sk sk-line w-60" />
            <div className="sk sk-block" style={{ marginTop: 12 }} />
          </CardPad>
          <CardPad>
            <div className="sk sk-title" />
            <div className="sk sk-line w-80" />
            <div className="sk sk-line w-60" />
            <div className="sk sk-block" style={{ marginTop: 12 }} />
          </CardPad>
        </div>
      </>
    )
  }

  return (
    <>
      <PageHead
        title="学习总览"
        desc="以 100 分为目标：题库全覆盖、错题清零、主观题有结构。先看数据，再练薄弱环节。"
        extra={
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => nav('plan')}>
              开始今日复习
            </button>
            <button className="btn" onClick={() => nav('mock')}>
              全真模拟
            </button>
          </div>
        }
      />

      <Reveal>
        <div className="grid grid-4" style={{ marginBottom: 14 }}>
          <Stat
            value={`${Math.round(coverage * 100)}%`}
            label="题库覆盖率"
            hint={`${diag.overall.attempted} / ${objectiveQuestions.length} 道已练`}
            tone="accent"
          />
          <Stat
            value={diag.overall.correctRate ? `${Math.round(diag.overall.correctRate * 100)}%` : '—'}
            label="客观题正确率"
            hint={`对 ${diag.overall.correct} · 错 ${diag.overall.wrong}`}
          />
          <Stat value={diag.overall.ourMastered} label="已掌握题目" hint={`目标 ${objectiveQuestions.length}`} />
          <Stat
            value={dueCount}
            label="今日待复习"
            hint={`今日已答 ${todayCount} 题`}
            tone={dueCount > 0 ? 'warn' : undefined}
          />
        </div>

        <div className="grid grid-2">
          <CardPad>
            <div className="card-title">复习完成度（题库覆盖）</div>
            <div className="col" style={{ gap: 14 }}>
              <ProgressLine
                label="已练题目"
                value={coverage}
                tone="accent"
                text={`${diag.overall.attempted} / ${objectiveQuestions.length}`}
              />
              <ProgressLine
                label="掌握题目"
                value={masteredRatio}
                tone="ok"
                text={`${diag.overall.ourMastered} / ${objectiveQuestions.length}`}
              />
              <ProgressLine
                label="主观题训练"
                value={subjectiveQuestions.length ? diag.overall.subjectiveAttempted / subjectiveQuestions.length : 0}
                tone="warn"
                text={`${diag.overall.subjectiveAttempted} / ${subjectiveQuestions.length}`}
              />
            </div>
            <div className="divider" />
            <div className="muted">
              还有 <b>{neverTouched}</b> 道客观题从未练过。避免只刷错题：先用「分章练习 /
              专项训练」扩大覆盖，再用「错题本」定点清除。
            </div>
            <div className="btn-row" style={{ marginTop: 14 }}>
              <button className="btn btn-primary" onClick={() => nav('practice')}>
                分章练习
              </button>
              <button className="btn" onClick={() => nav('special')}>
                专项训练
              </button>
              <button className="btn" onClick={() => nav('wrong')}>
                错题本
              </button>
            </div>
          </CardPad>

          <CardPad>
            <div className="card-title">近 7 天学习记录</div>
            {todayCount === 0 && history.length === 0 ? (
              <Empty text="还没有练习记录，开始第一组练习吧。">
                <button className="btn btn-primary" onClick={() => nav('plan')}>
                  生成复习计划
                </button>
              </Empty>
            ) : (
              <>
                <div className="col" style={{ gap: 10 }}>
                  {activity.map((d) => (
                    <div key={d.date} className="row-between">
                      <span className="muted" style={{ width: 76, fontFamily: 'var(--mono)', fontSize: 12 }}>
                        {d.date.slice(5)}
                      </span>
                      <div style={{ flex: 1, margin: '0 12px' }}>
                        <Bar value={d.count / Math.max(20, ...activity.map((x) => x.count), 1)} tone="accent" />
                      </div>
                      <span className="muted-2" style={{ width: 56, textAlign: 'right' }}>
                        {d.count} 题
                      </span>
                    </div>
                  ))}
                </div>
                <div className="divider" />
                <div className="row-between">
                  <span className="muted">已完成模拟考试</span>
                  <span className="row" style={{ gap: 6 }}>
                    <b style={{ fontVariantNumeric: 'tabular-nums' }}>{mocks.filter((m) => m.graded).length}</b>
                    <span className="muted-2">场</span>
                    {mocks.length > 0 && <Tag tone="accent">查看复盘</Tag>}
                  </span>
                </div>
              </>
            )}
          </CardPad>
        </div>
      </Reveal>

      {diag.weakPoints.length > 0 && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: 12 }}>
            <div className="card-title" style={{ margin: 0 }}>
              需优先处理的薄弱环节
            </div>
            <button className="btn btn-sm" onClick={() => nav('diagnosis')}>
              查看完整诊断
            </button>
          </div>
          <div className="grid grid-3">
            {diag.weakPoints.slice(0, 3).map((w) => (
              <div key={w.chapter} className="chapter-item" style={{ cursor: 'default' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="ci-name">{w.chapter}</div>
                  <div className="ci-sub">{w.detail}</div>
                </div>
                <Tag tone={w.kind === 'uncovered' ? 'warn' : 'bad'}>{w.kind === 'uncovered' ? '未覆盖' : '待清除'}</Tag>
              </div>
            ))}
          </div>
        </CardPad>
      )}

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">题库信息</div>
        <div className="muted">
          共 {allQuestions.length} 题：单选 {diag.types[0].total} · 多选 {diag.types[1].total} · 判断{' '}
          {diag.types[2].total} · 简答 {diag.types[3].total} · 材料分析 {diag.types[4].total}；{chapterOrder.length}{' '}
          个章节。数据来自指定 PDF，原始题干/选项/答案均未改动。
        </div>
      </CardPad>
    </>
  )
}
