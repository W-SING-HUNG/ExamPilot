import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { buildPaper } from '../lib/scheduler'
import { scoreAnswer } from '../lib/scoring'
import { CardPad, PageHead, Tag, Empty, Bar, useToast } from '../components/ui'
import { QuestionCard } from '../components/QuestionCard'
import { AiGradePanel } from '../components/AiQaPanel'
import type { MockConfig, MockRun, Question } from '../lib/types'
import type { RouteName } from '../store/router'

const DEFAULT_CONFIG: MockConfig = {
  singleCount: 20,
  multiCount: 10,
  judgeCount: 10,
  shortCount: 1,
  singleScore: 1,
  multiScore: 2,
  judgeScore: 1,
  shortScore: 15,
  durationMin: 90,
  chapters: 'all',
}

type Phase = 'config' | 'running' | 'done'

export function MockExam({
  nav,
}: {
  nav: (r: RouteName, p?: Record<string, string>) => void
  params: Record<string, string>
}) {
  const { ready, saveMockRun, submitAnswer, saveSubjectiveAttempt } = useStore()
  const [config, setConfig] = useState<MockConfig>(DEFAULT_CONFIG)
  const [phase, setPhase] = useState<Phase>('config')
  const [paper, setPaper] = useState<Question[]>([])
  const [answers, setAnswers] = useState<Record<string, string | null>>({})
  const [idx, setIdx] = useState(0)
  const [endsAt, setEndsAt] = useState(0)
  const [now, setNow] = useState(Date.now())
  const [runId, setRunId] = useState('')
  const [result, setResult] = useState<MockRun | null>(null)
  const [aiQid, setAiQid] = useState<string | null>(null)
  const { toast, el } = useToast()
  const submitting = useRef(false)

  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [phase])

  const remaining = phase === 'running' ? Math.max(0, endsAt - now) : 0
  const mm = Math.floor(remaining / 60000)
  const ss = Math.floor((remaining % 60000) / 1000)

  const maxScore = useMemo(() => {
    const paperSingles = paper.filter((q) => q.type === 'single').length
    const paperMultis = paper.filter((q) => q.type === 'multi').length
    const paperJudges = paper.filter((q) => q.type === 'judge').length
    const paperShorts = paper.filter((q) => q.type === 'short' || q.type === 'material').length
    return (
      paperSingles * config.singleScore +
      paperMultis * config.multiScore +
      paperJudges * config.judgeScore +
      paperShorts * config.shortScore
    )
  }, [paper, config])

  const start = () => {
    const p = buildPaper(allQuestions, {
      singleCount: config.singleCount,
      multiCount: config.multiCount,
      judgeCount: config.judgeCount,
      shortCount: config.shortCount,
      chapters: config.chapters,
    })
    if (p.length === 0) {
      toast('组卷失败：题库不足')
      return
    }
    setPaper(p)
    setAnswers(Object.fromEntries(p.map((q) => [q.id, null])))
    setIdx(0)
    setEndsAt(Date.now() + config.durationMin * 60000)
    setNow(Date.now())
    setRunId(`m-${Date.now()}`)
    setPhase('running')
  }

  /** Grade and persist into the SAME shared records/history (single progress system). */
  const submitAll = async (auto = false) => {
    if (submitting.current) return
    submitting.current = true
    const perQuestion: MockRun['perQuestion'] = {}
    let score = 0
    for (const q of paper) {
      const ans = answers[q.id] ?? null
      if (q.type === 'short' || q.type === 'material') {
        perQuestion[q.id] = { isCorrect: null, points: 0 }
        if (ans) await saveSubjectiveAttempt(q, ans, 'mock', runId, false)
        continue
      }
      const ok = scoreAnswer(q, ans) === true
      const pts = ok
        ? q.type === 'multi'
          ? config.multiScore
          : q.type === 'judge'
            ? config.judgeScore
            : config.singleScore
        : 0
      score += pts
      perQuestion[q.id] = { isCorrect: ok, points: pts }
      await submitAnswer(q, ans, 'mock', runId)
    }
    const run: MockRun = {
      id: runId,
      startedAt: endsAt - config.durationMin * 60000,
      endedAt: Date.now(),
      config,
      submissions: answers,
      graded: true,
      score,
      maxScore,
      perQuestion,
    }
    await saveMockRun(run)
    setResult(run)
    setPhase('done')
    submitting.current = false
    if (auto) toast('考试时间到，已自动交卷')
  }

  const submitAllRef = useRef(submitAll)
  submitAllRef.current = submitAll

  useEffect(() => {
    if (phase === 'running' && remaining <= 0) void submitAllRef.current(true)
  }, [remaining, phase])

  if (!ready) return null

  const q = paper[idx]
  const answeredCount = Object.values(answers).filter((v) => v).length
  const finalScore = result?.score ?? 0
  const finalMax = result?.maxScore ?? 1

  return (
    <>
      <PageHead
        title="全真模拟考试"
        desc="题型、题量、分值与时长均可配置——未获知正式考试要求时，默认值只是模板，不代表真实考纲。成绩与练习共用同一套学习记录。"
      />

      {phase === 'config' && (
        <>
          <CardPad>
            <div className="card-title">组卷配置</div>
            <div className="grid grid-3">
              <NumField
                label="单选题数量"
                value={config.singleCount}
                max={allQuestions.filter((q) => q.type === 'single').length}
                onChange={(v) => setConfig((c) => ({ ...c, singleCount: v }))}
              />
              <NumField
                label="多选题数量"
                value={config.multiCount}
                max={allQuestions.filter((q) => q.type === 'multi').length}
                onChange={(v) => setConfig((c) => ({ ...c, multiCount: v }))}
              />
              <NumField
                label="判断题数量"
                value={config.judgeCount}
                max={allQuestions.filter((q) => q.type === 'judge').length}
                onChange={(v) => setConfig((c) => ({ ...c, judgeCount: v }))}
              />
              <NumField
                label="主观题数量"
                value={config.shortCount}
                max={allQuestions.filter((q) => q.type === 'short' || q.type === 'material').length}
                onChange={(v) => setConfig((c) => ({ ...c, shortCount: v }))}
              />
              <NumField
                label="单选每题分值"
                value={config.singleScore}
                max={100}
                onChange={(v) => setConfig((c) => ({ ...c, singleScore: v }))}
              />
              <NumField
                label="多选每题分值"
                value={config.multiScore}
                max={100}
                onChange={(v) => setConfig((c) => ({ ...c, multiScore: v }))}
              />
              <NumField
                label="判断每题分值"
                value={config.judgeScore}
                max={100}
                onChange={(v) => setConfig((c) => ({ ...c, judgeScore: v }))}
              />
              <NumField
                label="主观题每题分值"
                value={config.shortScore}
                max={100}
                onChange={(v) => setConfig((c) => ({ ...c, shortScore: v }))}
              />
              <NumField
                label="考试时长（分钟）"
                value={config.durationMin}
                max={300}
                onChange={(v) => setConfig((c) => ({ ...c, durationMin: v }))}
              />
            </div>

            <div className="card-title" style={{ marginTop: 6 }}>
              章节范围
            </div>
            <div className="pill-scroll">
              <button
                className={`btn btn-sm ${config.chapters === 'all' ? 'btn-primary' : ''}`}
                onClick={() => setConfig((c) => ({ ...c, chapters: 'all' }))}
              >
                全部章节
              </button>
              {chapterOrder.map((ch) => (
                <button
                  key={ch}
                  className={`btn btn-sm ${Array.isArray(config.chapters) && config.chapters.includes(ch) ? 'btn-primary' : ''}`}
                  onClick={() =>
                    setConfig((c) => {
                      const cur = c.chapters === 'all' ? [] : [...c.chapters]
                      const next = cur.includes(ch) ? cur.filter((x) => x !== ch) : [...cur, ch]
                      return { ...c, chapters: next.length ? next : 'all' }
                    })
                  }
                >
                  {ch}
                </button>
              ))}
            </div>

            <div className="divider" />
            <div className="row-between">
              <div className="muted">
                试卷总分按当前配置计算：单选 {config.singleCount}×{config.singleScore} + 多选 {config.multiCount}×
                {config.multiScore} + 判断 {config.judgeCount}×{config.judgeScore} + 主观 {config.shortCount}×
                {config.shortScore} ={' '}
                <b>
                  {config.singleCount * config.singleScore +
                    config.multiCount * config.multiScore +
                    config.judgeCount * config.judgeScore +
                    config.shortCount * config.shortScore}
                </b>{' '}
                分
              </div>
              <button className="btn btn-primary btn-lg" onClick={start}>
                开始考试
              </button>
            </div>
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">历史模拟成绩</div>
            <HistoryList />
          </CardPad>
        </>
      )}

      {phase === 'running' && q && (
        <>
          <CardPad>
            <div className="row-between" style={{ marginBottom: 10 }}>
              <div className="row" style={{ gap: 12 }}>
                <span className="muted">
                  第 {idx + 1} / {paper.length} 题
                </span>
                <span className="muted-2">已答 {answeredCount}</span>
              </div>
              <div className={`timer ${remaining < 5 * 60000 ? 'urgent' : ''}`}>
                {String(mm).padStart(2, '0')}:{String(ss).padStart(2, '0')}
              </div>
            </div>
            <Bar value={answeredCount / paper.length} tone="accent" />
            <div className="progress-dots">
              {paper.map((qq, i) => (
                <i key={qq.id} className={`${answers[qq.id] ? 'ok' : ''} ${i === idx ? 'cur' : ''}`} />
              ))}
            </div>
          </CardPad>

          <div style={{ marginTop: 14 }}>
            <QuestionCard
              q={q}
              value={answers[q.id] ?? null}
              onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))}
              reveal={false}
            />
          </div>

          <div className="btn-row" style={{ marginTop: 14 }}>
            <button className="btn" onClick={() => setIdx((i) => Math.max(0, i - 1))} disabled={idx === 0}>
              上一题
            </button>
            <button
              className="btn"
              onClick={() => setIdx((i) => Math.min(paper.length - 1, i + 1))}
              disabled={idx === paper.length - 1}
            >
              下一题
            </button>
            <button className="btn btn-ghost" onClick={() => setAnswers((a) => ({ ...a, [q.id]: null }))}>
              清除本题
            </button>
            <span style={{ flex: 1 }} />
            <button className="btn btn-primary" onClick={() => void submitAll(false)}>
              交卷并评分
            </button>
          </div>

          <div className="pill-scroll" style={{ marginTop: 12 }}>
            {paper.map((qq, i) => (
              <button
                key={qq.id}
                className={`btn btn-sm ${i === idx ? 'btn-primary' : answers[qq.id] ? '' : 'btn-ghost'}`}
                onClick={() => setIdx(i)}
                title={qq.stem.slice(0, 40)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </>
      )}

      {phase === 'done' && result && (
        <>
          <CardPad>
            <div className="row-between" style={{ marginBottom: 12 }}>
              <div>
                <div className="card-title">考试结果</div>
                <div className="muted">
                  得分{' '}
                  <b
                    style={{
                      fontSize: 26,
                      color:
                        finalScore / finalMax >= 0.8
                          ? 'var(--ok)'
                          : finalScore / finalMax >= 0.6
                            ? 'var(--warn)'
                            : 'var(--bad)',
                    }}
                  >
                    {finalScore}
                  </b>{' '}
                  / {result.maxScore} （{Math.round((finalScore / Math.max(1, result.maxScore)) * 100)}%）
                </div>
              </div>
              <div className="btn-row">
                <button
                  className="btn"
                  onClick={() => {
                    setPhase('config')
                    setResult(null)
                  }}
                >
                  再考一场
                </button>
                <button className="btn btn-primary" onClick={() => nav('diagnosis')}>
                  查看诊断
                </button>
              </div>
            </div>
            <Bar
              value={finalScore / Math.max(1, result.maxScore)}
              tone={finalScore / finalMax >= 0.8 ? 'ok' : finalScore / finalMax >= 0.6 ? 'warn' : 'bad'}
            />
            <div className="muted-2" style={{ marginTop: 8 }}>
              客观题由题库答案严格判定；主观题未自动评分（题库无标准答案），可点击题目中的「AI
              参考评阅」。本次作答已计入同一套学习记录。
            </div>
          </CardPad>

          <CardPad style={{ marginTop: 14 }}>
            <div className="card-title">逐题复盘</div>
            <div className="col" style={{ gap: 12 }}>
              {paper.map((qq, i) => {
                const per = result.perQuestion[qq.id]
                const mine = result.submissions[qq.id]
                const isSub = qq.type === 'short' || qq.type === 'material'
                return (
                  <div key={qq.id} className="card card-pad" style={{ boxShadow: 'none' }}>
                    <div className="row-between" style={{ marginBottom: 8 }}>
                      <span className="muted">
                        第 {i + 1} 题 · {TYPE_LABEL[qq.type]} · {qq.chapter}
                      </span>
                      {isSub ? (
                        <Tag tone="warn">主观题 · 未自动评分</Tag>
                      ) : per?.isCorrect ? (
                        <Tag tone="ok">正确 +{per.points}</Tag>
                      ) : (
                        <Tag tone="bad">错误 0 分</Tag>
                      )}
                    </div>
                    <div className="q-stem" style={{ fontSize: 14.5 }}>
                      {qq.stem}
                    </div>
                    <div className="muted" style={{ marginTop: 6 }}>
                      你的作答：{mine || '（未作答）'}
                      {!isSub && (
                        <span style={{ marginLeft: 8 }}>
                          正确答案：
                          <b>{qq.answerNorm === true ? '正确' : qq.answerNorm === false ? '错误' : qq.answerNorm}</b>
                        </span>
                      )}
                    </div>
                    {isSub && (
                      <>
                        <button
                          className="btn btn-sm"
                          style={{ marginTop: 8 }}
                          onClick={() => setAiQid(aiQid === qq.id ? null : qq.id)}
                        >
                          {aiQid === qq.id ? '收起 AI 评阅' : 'AI 参考评阅'}
                        </button>
                        {aiQid === qq.id && <AiGradePanel q={qq} userAnswer={mine ?? ''} />}
                      </>
                    )}
                  </div>
                )
              })}
            </div>
          </CardPad>
        </>
      )}

      {el}
    </>
  )

  function HistoryList() {
    const { mocks, deleteMockRun } = useStore()
    if (mocks.length === 0) return <Empty text="还没有模拟考试记录。" />
    return (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>时间</th>
              <th>题量</th>
              <th>得分</th>
              <th>得分率</th>
              <th>时长</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {mocks.map((m) => {
              const sc = m.score ?? 0
              const mx = m.maxScore ?? 1
              return (
                <tr key={m.id}>
                  <td className="code">{new Date(m.startedAt).toLocaleString('zh-CN', { hour12: false })}</td>
                  <td>{Object.keys(m.submissions).length}</td>
                  <td>
                    <b>{sc}</b> / {m.maxScore}
                  </td>
                  <td>
                    <div className="row" style={{ gap: 8 }}>
                      <div style={{ width: 70 }}>
                        <Bar value={sc / Math.max(1, mx)} tone="accent" />
                      </div>
                      <span>{Math.round((sc / Math.max(1, mx)) * 100)}%</span>
                    </div>
                  </td>
                  <td>{Math.round(((m.endedAt ?? m.startedAt) - m.startedAt) / 60000)} 分钟</td>
                  <td>
                    <button className="btn btn-sm btn-ghost" onClick={() => void deleteMockRun(m.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }
}

function NumField({
  label,
  value,
  max,
  onChange,
}: {
  label: string
  value: number
  max: number
  onChange: (v: number) => void
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}（上限 {max}）
      </span>
      <input
        className="input"
        type="number"
        min={0}
        max={max}
        value={value}
        onChange={(e) => onChange(Math.max(0, Math.min(max, Number(e.target.value) || 0)))}
      />
    </label>
  )
}
