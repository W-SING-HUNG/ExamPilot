import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { objectiveQuestions, subjectiveQuestions, allQuestions } from '../lib/bank'
import { selectQuestions, mulberry32 } from '../lib/scheduler'
import { computeDiagnosis } from '../lib/analysis'
import { QuestionRunner } from '../components/QuestionRunner'
import { CardPad, PageHead, Empty } from '../components/ui'
import { Question } from '../lib/types'

interface Rec {
  qid: string
  status: string
  wrongCount: number
  attempts: number
  nextReviewAt: number
  lastSeenAt: number
}

/**
 * Build a daily plan from real data:
 *  1) due-for-review questions (highest priority)
 *  2) wrong / struggling questions
 *  3) never-attempted questions (coverage — avoids "only drilling wrong questions")
 *  4) one subjective question for writing practice
 */
function buildPlan(records: Map<string, Rec>, size: number): Question[] {
  const now = Date.now()
  const due = objectiveQuestions.filter((q) => {
    const r = records.get(q.id)
    return r && r.attempts > 0 && r.nextReviewAt <= now
  })
  const wrong = objectiveQuestions.filter((q) => {
    const r = records.get(q.id)
    return r && r.attempts > 0 && r.wrongCount > 0 && !due.includes(q)
  })
  const fresh = objectiveQuestions.filter((q) => {
    const r = records.get(q.id)
    return !r || r.attempts === 0
  })

  const picks: Question[] = []
  const seen = new Set<string>()
  const push = (list: Question[]) => {
    for (const q of list) {
      if (!seen.has(q.id)) {
        seen.add(q.id)
        picks.push(q)
      }
    }
  }

  const duePicks = selectQuestions({
    pool: due,
    records: records as never,
    now,
    count: Math.max(3, Math.round(size * 0.3)),
    rng: mulberry32(7),
  })
  push(duePicks)
  const wrongPicks = selectQuestions({
    pool: wrong,
    records: records as never,
    now,
    count: Math.max(3, Math.round(size * 0.4)),
    rng: mulberry32(11),
  })
  push(wrongPicks)
  const freshPicks = selectQuestions({
    pool: fresh,
    records: records as never,
    now,
    count: Math.max(4, Math.round(size * 0.5)),
    rng: mulberry32(13),
  })
  push(freshPicks)

  const objPicks = picks.slice(0, size)
  const sub = subjectiveQuestions.length
    ? [subjectiveQuestions[Math.floor(Math.random() * subjectiveQuestions.length)]]
    : []
  return [...objPicks, ...sub].slice(0, size + 1)
}

export function Plan({ params: _params }: { params: Record<string, string> }) {
  const { records, ready } = useStore()
  const [session, setSession] = useState<Question[] | null>(null)
  const [size, setSize] = useState(20)
  const sessionId = `s-${Date.now()}`

  const diag = useMemo(() => computeDiagnosis(allQuestions, records as never), [records])
  const now = Date.now()
  const dueCount = objectiveQuestions.filter((q) => {
    const r = records.get(q.id)
    return r && r.attempts > 0 && r.nextReviewAt <= now
  }).length
  const freshCount = objectiveQuestions.filter((q) => (records.get(q.id)?.attempts ?? 0) === 0).length

  const plan = useMemo(() => {
    if (!ready) return null
    return buildPlan(records as unknown as Map<string, Rec>, size)
  }, [records, size, ready])

  if (!ready) return null

  return (
    <>
      <PageHead
        title="智能复习计划"
        desc="按间隔复习、错题再测与覆盖均衡三类原则生成当日任务：到期复习优先，错题再测其次，未做题目补漏。"
      />

      <div className="grid grid-3" style={{ marginBottom: 14 }}>
        <CardPad>
          <div className="stat-num">{dueCount}</div>
          <div className="stat-label">今日到期复习</div>
        </CardPad>
        <CardPad>
          <div className="stat-num" style={{ color: diag.weakPoints.length ? 'var(--bad)' : undefined }}>
            {diag.weakPoints.length}
          </div>
          <div className="stat-label">薄弱章节</div>
        </CardPad>
        <CardPad>
          <div className="stat-num" style={{ color: freshCount ? 'var(--warn)' : undefined }}>
            {freshCount}
          </div>
          <div className="stat-label">从未练过的题目</div>
        </CardPad>
      </div>

      <CardPad>
        <div className="card-title">今日任务量</div>
        <div className="btn-row" style={{ marginBottom: 14 }}>
          {[10, 20, 30, 50].map((n) => (
            <button key={n} className={`btn btn-sm ${size === n ? 'btn-primary' : ''}`} onClick={() => setSize(n)}>
              {n} 题
            </button>
          ))}
        </div>

        {plan && plan.length > 0 ? (
          <>
            <div className="card-title">计划预览（{plan.length} 题）</div>
            <div className="col" style={{ gap: 8 }}>
              {plan.slice(0, 8).map((q, i) => (
                <div
                  key={q.id}
                  className="row-between"
                  style={{ borderBottom: '1px solid var(--border)', paddingBottom: 6 }}
                >
                  <span className="muted" style={{ fontSize: 13 }}>
                    {i + 1}. [{q.chapter}] {q.stem.split('\n')[0].slice(0, 50)}
                  </span>
                  <span className="muted-2">{q.type === 'short' || q.type === 'material' ? '主观题' : '客观题'}</span>
                </div>
              ))}
              {plan.length > 8 && <div className="muted-2">……</div>}
            </div>
            <div className="divider" />
            <button className="btn btn-primary btn-lg" onClick={() => setSession(plan)}>
              开始今日复习（{plan.length} 题）
            </button>
          </>
        ) : (
          <Empty text="题库已全部练完且无到期复习，可进入模拟考试检验。" />
        )}
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">复习方法说明</div>
        <div className="col" style={{ gap: 8 }}>
          <MethodRow title="主动回忆" desc="先作答再看解析，避免被动浏览；主观题要求完整书写而不是列要点。" />
          <MethodRow title="间隔复习" desc="答对后按 1→2→4 天递增间隔再次出现，答错立即回到最短间隔。" />
          <MethodRow title="错题再测" desc="答错过两次以上的题目标记为难点，优先复刷直到连续答对。" />
          <MethodRow title="混合练习" desc="章节、题型混合抽取，避免短期重复同一知识块造成的“熟练错觉”。" />
          <MethodRow title="覆盖均衡" desc="每次任务都包含未做题目，防止只刷错题导致大量题目从未覆盖。" />
        </div>
      </CardPad>

      {session && (
        <div style={{ marginTop: 14 }}>
          <QuestionRunner
            questions={session}
            mode="plan"
            sessionId={sessionId}
            immediateFeedback
            onFinish={() => setSession(null)}
            finishLabel="完成今日任务"
          />
        </div>
      )}
    </>
  )
}

function MethodRow({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="row-between">
      <b style={{ fontSize: 13.5, width: 90 }}>{title}</b>
      <span className="muted" style={{ flex: 1 }}>
        {desc}
      </span>
    </div>
  )
}
