import { useMemo, useState } from 'react'
import { allQuestions, chapterOrder, TYPE_LABEL } from '../lib/bank'
import { CardPad, PageHead, Tag, Empty } from '../components/ui'
import { answerText } from '../lib/scoring'
import type { Question, QuestionType } from '../lib/types'

export function BankPage({ params: _params }: { params: Record<string, string> }) {
  const [chapter, setChapter] = useState('')
  const [type, setType] = useState<QuestionType | ''>('')
  const [kw, setKw] = useState('')
  const [onlyFlagged, setOnlyFlagged] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const filtered = useMemo(() => {
    let list = allQuestions
    if (chapter) list = list.filter((q) => q.chapter === chapter)
    if (type) list = list.filter((q) => q.type === type)
    if (onlyFlagged) list = list.filter((q) => q.isFlagged)
    if (kw.trim()) {
      const k = kw.trim()
      list = list.filter((q) => q.stem.includes(k) || q.options.some((o) => o.includes(k)) || q.answer?.includes(k))
    }
    return list
  }, [chapter, type, kw, onlyFlagged])

  return (
    <>
      <PageHead
        title="题库查阅"
        desc="完整题库检索，含 PDF 页码追溯与数据校验标记。原题干、原选项、原答案均保持题库原样。"
      />

      <CardPad>
        <div className="card-title">检索条件</div>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 240 }}
            placeholder="搜索题干 / 选项 / 答案"
            value={kw}
            onChange={(e) => setKw(e.target.value)}
          />
          <select
            className="select"
            style={{ maxWidth: 150 }}
            value={chapter}
            onChange={(e) => setChapter(e.target.value)}
          >
            <option value="">全部章节</option>
            {chapterOrder.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
            <option value="全册">全册（主观题）</option>
          </select>
          <select
            className="select"
            style={{ maxWidth: 140 }}
            value={type}
            onChange={(e) => setType(e.target.value as QuestionType | '')}
          >
            <option value="">全部题型</option>
            <option value="single">单选题</option>
            <option value="multi">多选题</option>
            <option value="judge">判断题</option>
            <option value="short">简答题</option>
            <option value="material">材料分析题</option>
          </select>
          <label className="row" style={{ gap: 6, fontSize: 13 }}>
            <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} />
            仅看待校验标记
          </label>
          <span className="muted-2">共 {filtered.length} 题</span>
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        {filtered.length === 0 ? (
          <Empty text="没有符合条件的题目。" />
        ) : (
          <div className="col" style={{ gap: 8 }}>
            {filtered.slice(0, 200).map((q) => (
              <BankRow
                key={q.id}
                q={q}
                open={expanded === q.id}
                onToggle={() => setExpanded(expanded === q.id ? null : q.id)}
              />
            ))}
            {filtered.length > 200 && <div className="muted-2">仅显示前 200 条，请使用筛选缩小范围。</div>}
          </div>
        )}
      </CardPad>
    </>
  )
}

function BankRow({ q, open, onToggle }: { q: Question; open: boolean; onToggle: () => void }) {
  return (
    <div className="card card-pad" style={{ boxShadow: 'none' }}>
      <button
        className="row-between"
        style={{ background: 'none', border: 'none', width: '100%', textAlign: 'left' }}
        onClick={onToggle}
      >
        <span className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Tag tone="accent">{TYPE_LABEL[q.type]}</Tag>
          <Tag>{q.chapter}</Tag>
          <span className="code">{q.bankNo}</span>
          {q.pageStart && <span className="muted-2">P{q.pageStart}</span>}
          {q.isFlagged && <Tag tone="warn">待校验</Tag>}
        </span>
        <span className="muted-2">{open ? '收起' : '展开'}</span>
      </button>
      <div className="q-stem" style={{ fontSize: 14.5, marginTop: 6 }}>
        {q.stem.split('\n')[0]}
      </div>
      {open && (
        <div style={{ marginTop: 8 }}>
          {q.options.length > 0 && (
            <ol style={{ margin: '0 0 8px', paddingLeft: 22, fontSize: 14, lineHeight: 1.9 }}>
              {q.options.map((o, i) => (
                <li
                  key={i}
                  style={{
                    fontWeight: q.answerNorm && String(q.answerNorm).includes(String.fromCharCode(65 + i)) ? 700 : 400,
                  }}
                >
                  {o}
                </li>
              ))}
            </ol>
          )}
          <div className="explain">
            <div>
              <b>答案：</b>
              {q.hasOfficialAnswer ? answerText(q) : '（题库未提供标准答案）'}
            </div>
            {q.flagReason && <div className="muted-2">校验说明：{q.flagReason}</div>}
            <div className="muted-2">
              ID: {q.id} · 来源 PDF 第 {q.pageStart ?? '?'}
              {q.pageEnd && q.pageEnd !== q.pageStart ? `–${q.pageEnd}` : ''} 页
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
