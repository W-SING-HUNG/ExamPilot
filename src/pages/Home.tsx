import { useMemo } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, objectiveQuestions, subjectiveQuestions, chapterOrder } from '../lib/bank'
import { computeDiagnosis, groupActivity } from '../lib/analysis'
import { Bar, CardPad, PageHead, Stat, Tag, Empty } from '../components/ui'
import type { RouteName } from '../store/router'

export function Home({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { records, history, mocks } = useStore()

  const diag = useMemo(() => computeDiagnosis(allQuestions, records), [records])
  const activity = useMemo(() => groupActivity(history, 7), [history])
  const todayCount = activity[activity.length - 1]?.count ?? 0

  const dueCount = useMemo(() => {
    const now = Date.now()
    let n = 0
    for (const q of objectiveQuestions) {
      const r = records.get(q.id)
      if (r && r.nextReviewAt <= now) n++
    }
    return n
  }, [records])

  const neverTouched = useMemo(
    () => objectiveQuestions.filter((q) => !records.get(q.id) || records.get(q.id)!.attempts === 0).length,
    [records],
  )

  const masteredRatio = objectiveQuestions.length ? diag.overall.ourMastered / objectiveQuestions.length : 0
  const coverage = diag.overall.coverage

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

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Stat
          value={`${Math.round(coverage * 100)}%`}
          label="题库覆盖率"
          hint={`${diag.overall.attempted}/${objectiveQuestions.length} 道已练`}
        />
        <Stat
          value={diag.overall.correctRate ? `${Math.round(diag.overall.correctRate * 100)}%` : '—'}
          label="客观题正确率"
          hint={`对 ${diag.overall.correct} · 错 ${diag.overall.wrong}`}
        />
        <Stat value={diag.overall.ourMastered} label="已掌握题目" hint={`目标 ${objectiveQuestions.length}`} />
        <Stat value={dueCount} label="今日待复习" hint={`今日已答 ${todayCount} 题`} />
      </div>

      <div className="grid grid-2">
        <CardPad>
          <div className="card-title">复习完成度（题库覆盖）</div>
          <div className="col" style={{ gap: 10 }}>
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
          <div className="btn-row" style={{ marginTop: 12 }}>
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
              <div className="col" style={{ gap: 8 }}>
                {activity.map((d) => (
                  <div key={d.date} className="row-between">
                    <span className="muted" style={{ width: 90, fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {d.date.slice(5)}
                    </span>
                    <div style={{ flex: 1, margin: '0 10px' }}>
                      <Bar value={d.count / Math.max(20, ...activity.map((x) => x.count), 1)} tone="accent" />
                    </div>
                    <span className="muted-2" style={{ width: 62, textAlign: 'right' }}>
                      {d.count} 题
                    </span>
                  </div>
                ))}
              </div>
              <div className="divider" />
              <div className="row-between">
                <span className="muted">已完成模拟考试</span>
                <span className="row" style={{ gap: 6 }}>
                  <b>{mocks.filter((m) => m.graded).length}</b> 场
                  {mocks.length > 0 && <Tag tone="accent">查看复盘</Tag>}
                </span>
              </div>
            </>
          )}
        </CardPad>
      </div>

      {diag.weakPoints.length > 0 && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="card-title">优先薄弱点</div>
          <div className="grid grid-3">
            {diag.weakPoints.map((w) => (
              <div key={w.chapter} className="card card-pad" style={{ boxShadow: 'none' }}>
                <div className="row-between" style={{ marginBottom: 6 }}>
                  <b>{w.chapter}</b>
                  <Tag tone={w.score < 50 ? 'bad' : w.score < 70 ? 'warn' : 'ok'}>掌握指数 {w.score}</Tag>
                </div>
                <div className="muted-2" style={{ minHeight: 38 }}>
                  {w.detail}
                </div>
                <button
                  className="btn btn-sm"
                  style={{ marginTop: 8 }}
                  onClick={() => nav('practice', { chapter: w.chapter })}
                >
                  练习本章
                </button>
              </div>
            ))}
          </div>
          <div className="muted-2" style={{ marginTop: 8 }}>
            掌握指数由真实答题数据（覆盖率 + 正确率）计算，非预测成绩。
          </div>
        </CardPad>
      )}

      <div className="grid grid-4" style={{ marginTop: 14 }}>
        <MiniType
          title="单选题"
          n={diag.types[0].total}
          done={diag.types[0].attempted}
          ok={diag.types[0].correctRate}
          onClick={() => nav('special', { type: 'single' })}
        />
        <MiniType
          title="多选题"
          n={diag.types[1].total}
          done={diag.types[1].attempted}
          ok={diag.types[1].correctRate}
          onClick={() => nav('special', { type: 'multi' })}
        />
        <MiniType
          title="判断题"
          n={diag.types[2].total}
          done={diag.types[2].attempted}
          ok={diag.types[2].correctRate}
          onClick={() => nav('special', { type: 'judge' })}
        />
        <MiniType
          title="主观题"
          n={subjectiveQuestions.length}
          done={diag.overall.subjectiveAttempted}
          ok={null}
          onClick={() => nav('subjective')}
        />
      </div>

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
      <div className="row-between" style={{ marginBottom: 4 }}>
        <span style={{ fontSize: 13.5 }}>{label}</span>
        <span className="muted-2">{text}</span>
      </div>
      <Bar value={value} tone={tone} />
    </div>
  )
}

function MiniType({
  title,
  n,
  done,
  ok,
  onClick,
}: {
  title: string
  n: number
  done: number
  ok: number | null
  onClick: () => void
}) {
  const cov = n ? done / n : 0
  return (
    <button className="chapter-item" onClick={onClick}>
      <div>
        <div className="ci-name">{title}</div>
        <div className="ci-sub">
          {n} 题 · 已练 {done}
        </div>
      </div>
      <div style={{ width: 92, textAlign: 'right' }}>
        <div className="ci-sub" style={{ marginBottom: 4 }}>
          {ok === null ? '主观评阅' : `正确率 ${Math.round(ok * 100)}%`}
        </div>
        <Bar value={cov} tone={cov > 0.8 ? 'ok' : 'accent'} />
      </div>
    </button>
  )
}
