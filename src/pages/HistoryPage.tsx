import { useMemo, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { questionById, TYPE_LABEL } from '../lib/bank'
import { CardPad, PageHead, Tag, Empty, useToast } from '../components/ui'

const MODE_LABEL: Record<string, string> = {
  practice: '分章练习',
  special: '专项训练',
  subjective: '主观题训练',
  review: '错题复刷',
  mock: '全真模拟',
  plan: '复习计划',
}

export function HistoryPage({ params: _params }: { params: Record<string, string> }) {
  const { history, records, ready, clearHistory } = useStore()
  const { toast, el } = useToast()
  const [mode, setMode] = useState('')
  const [result, setResult] = useState<'' | 'ok' | 'bad' | 'unscored'>('')
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    let list = history
    if (mode) list = list.filter((h) => h.mode === mode)
    if (result === 'ok') list = list.filter((h) => h.isCorrect === true)
    if (result === 'bad') list = list.filter((h) => h.isCorrect === false)
    if (result === 'unscored') list = list.filter((h) => h.isCorrect === null)
    if (q.trim()) {
      const k = q.trim()
      list = list.filter((h) => {
        const qq = questionById.get(h.qid)
        return qq && (qq.stem.includes(k) || qq.chapter.includes(k))
      })
    }
    return list
  }, [history, mode, result, q])

  const modes = useMemo(() => Array.from(new Set(history.map((h) => h.mode))), [history])

  const exportCsv = () => {
    const head = 'time,mode,chapter,type,bankNo,answer,result\n'
    const rows = filtered
      .map((h) => {
        const qq = questionById.get(h.qid)
        const t = new Date(h.submittedAt).toLocaleString('zh-CN', { hour12: false })
        const esc = (s: string) => `"${String(s).replace(/"/g, '""')}"`
        return [
          esc(t),
          esc(MODE_LABEL[h.mode] ?? h.mode),
          esc(qq?.chapter ?? ''),
          esc(qq ? TYPE_LABEL[qq.type] : ''),
          qq?.bankNo ?? '',
          esc(h.answer ?? ''),
          h.isCorrect === true ? 'correct' : h.isCorrect === false ? 'wrong' : 'unscored',
        ].join(',')
      })
      .join('\n')
    const blob = new Blob(['\ufeff' + head + rows], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `exampilot-history-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出 CSV')
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="练习历史"
        desc="每一次真实作答的完整记录，可按模式、结果与关键词筛选复盘。"
        extra={
          <div className="btn-row">
            <button className="btn" onClick={exportCsv} disabled={filtered.length === 0}>
              导出 CSV
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm(`确定清除全部 ${history.length} 条历史记录？`)) {
                  void clearHistory()
                  toast('历史已清除')
                }
              }}
              disabled={history.length === 0}
            >
              清空历史
            </button>
          </div>
        }
      />

      <CardPad>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="搜索题干/章节关键词"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select className="select" style={{ maxWidth: 150 }} value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="">全部模式</option>
            {modes.map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m] ?? m}
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ maxWidth: 150 }}
            value={result}
            onChange={(e) => setResult(e.target.value as typeof result)}
          >
            <option value="">全部结果</option>
            <option value="ok">仅正确</option>
            <option value="bad">仅错误</option>
            <option value="unscored">仅未评分</option>
          </select>
          <span className="muted-2">
            共 {filtered.length} 条（总 {history.length}）
          </span>
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        {filtered.length === 0 ? (
          <Empty text="没有符合条件的记录。" />
        ) : (
          <div className="tbl-wrap" style={{ maxHeight: 620, overflowY: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模式</th>
                  <th>章节</th>
                  <th>题型</th>
                  <th>题干</th>
                  <th>你的作答</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0, 500).map((h) => {
                  const qq = questionById.get(h.qid)
                  const r = records.get(h.qid)
                  return (
                    <tr key={h.id}>
                      <td className="code" style={{ whiteSpace: 'nowrap' }}>
                        {new Date(h.submittedAt).toLocaleString('zh-CN', { hour12: false })}
                      </td>
                      <td>{MODE_LABEL[h.mode] ?? h.mode}</td>
                      <td>{qq?.chapter ?? '—'}</td>
                      <td>{qq ? TYPE_LABEL[qq.type] : '—'}</td>
                      <td
                        style={{ maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={qq?.stem}
                      >
                        {qq ? qq.stem.split('\n')[0] : '（题目已不在题库）'}
                      </td>
                      <td
                        style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={h.answer ?? ''}
                      >
                        {h.answer || '（未作答）'}
                      </td>
                      <td>
                        {h.isCorrect === true ? (
                          <Tag tone="ok">正确</Tag>
                        ) : h.isCorrect === false ? (
                          <Tag tone="bad">错误</Tag>
                        ) : (
                          <Tag tone="warn">未评分</Tag>
                        )}
                        {r && r.attempts > 1 && (
                          <span className="muted-2" style={{ marginLeft: 4 }}>
                            ×{r.attempts}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardPad>
      {el}
    </>
  )
}
