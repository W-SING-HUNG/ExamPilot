import { useRef, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { parseExport, makeExportPayload, serialize, applyImport } from '../lib/io'
import { CardPad, PageHead, useToast } from '../components/ui'
import { APP_VERSION } from '../lib/meta'
import { bank } from '../lib/bank'

export function DataIO({ params: _params }: { params: Record<string, string> }) {
  const { records, history, mocks, aiReviews, settings, ready, importRecords } = useStore()
  const { toast, el } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string[]>([])
  const [busy, setBusy] = useState(false)

  const exportAll = () => {
    const payload = makeExportPayload({
      settings,
      records: Array.from(records.values()),
      history,
      mocks,
      aiReviews,
    })
    const blob = new Blob([serialize(payload)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `exampilot-backup-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出学习数据')
  }

  const exportBank = () => {
    const blob = new Blob([JSON.stringify(bank, null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'exampilot-bank.json'
    a.click()
    URL.revokeObjectURL(a.href)
    toast('已导出题库数据')
  }

  const onFile = async (f: File) => {
    setBusy(true)
    try {
      const text = await f.text()
      const res = parseExport(text)
      if (!res.ok) {
        setMsg([`导入失败：${res.errors.slice(0, 6).join('；')}`])
        return
      }
      if (!res.payload) {
        setMsg(['导入失败：解析结果为空'])
        return
      }
      const bankIds = new Set(bank.questions.map((q) => q.id))
      const unknown = res.payload.records.filter((r) => !bankIds.has(r.qid)).length
      const out = await applyImport(res.payload, {
        putRecords: async (r) => {
          await importRecords(r, [], [], [])
        },
        putHistory: async () => {},
        putMocks: async () => {},
        putAi: async () => {},
        clearAll: async () => {},
      })
      setMsg([
        `已导入 ${res.payload.records.length} 条学习记录`,
        unknown ? `警告：${unknown} 条记录的 qid 不在当前题库中（题库版本可能不同）` : '所有记录均与当前题库匹配',
        ...out.detail,
      ])
      toast('导入完成')
    } catch (e) {
      setMsg([`导入异常：${(e as Error).message}`])
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="数据导入导出"
        desc="所有学习数据保存在浏览器本地数据库（IndexedDB）。可导出为 JSON 备份，再在任意设备导入恢复。"
      />

      <div className="grid grid-2">
        <CardPad>
          <div className="card-title">导出</div>
          <div className="muted" style={{ marginBottom: 12 }}>
            学习记录 {records.size} 条 · 历史 {history.length} 条 · 模拟考试 {mocks.length} 场 · AI 评阅{' '}
            {aiReviews.length} 条
          </div>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={exportAll}>
              导出学习数据（JSON）
            </button>
            <button className="btn" onClick={exportBank}>
              导出题库（JSON）
            </button>
          </div>
          <div className="divider" />
          <div className="card-title">题库版本</div>
          <div className="muted">
            {bank.schema} · {bank.countsByType.single} 单选 / {bank.countsByType.multi} 多选 / {bank.countsByType.judge}{' '}
            判断 / {bank.countsByType.short} 简答 / {bank.countsByType.material} 材料
          </div>
          <div className="muted-2" style={{ marginTop: 4 }}>
            应用版本 v{APP_VERSION}
          </div>
        </CardPad>

        <CardPad>
          <div className="card-title">导入恢复</div>
          <div className="muted" style={{ marginBottom: 10 }}>
            选择此前导出的 JSON 文件。导入会与现有记录合并（同一 qid 以导入数据为准）；格式不符时不会写入任何数据。
          </div>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void onFile(f)
              e.target.value = ''
            }}
          />
          {busy && (
            <div className="muted" style={{ marginTop: 8 }}>
              正在导入…
            </div>
          )}
          {msg.length > 0 && (
            <div className="explain" style={{ marginTop: 10 }}>
              {msg.map((m, i) => (
                <div key={i}>{m}</div>
              ))}
            </div>
          )}
        </CardPad>
      </div>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">数据说明</div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
          <li>题目数据来自指定题库来源，题干、选项、答案与章节均按原文解析，未做事实修改。</li>
          <li>
            简答题与材料分析论述题在题库中只有题干、没有标准答案，系统不伪造官方答案；AI
            评阅结果会单独保存并标注为参考评阅。
          </li>
          <li>清除浏览器站点数据会删除本地学习记录，请定期导出备份。</li>
        </ul>
      </CardPad>
      {el}
    </>
  )
}
