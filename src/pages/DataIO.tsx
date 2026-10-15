import { useRef, useState } from 'react'
import { useStore } from '../store/StoreContext'
import {
  parseExport,
  makeExportPayload,
  serialize,
  planImport,
  describePlan,
  bankFingerprint,
  type RestoreMode,
} from '../lib/io'
import { CardPad, PageHead, useToast } from '../components/ui'
import { APP_VERSION } from '../lib/meta'
import { bank } from '../lib/bank'

export function DataIO({ params: _params }: { params: Record<string, string> }) {
  const { records, history, mocks, aiReviews, settings, ready, restoreBackup } = useStore()
  const { toast, el } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<RestoreMode>('replace')

  const exportAll = () => {
    const payload = makeExportPayload({
      settings,
      records: Array.from(records.values()),
      history,
      mocks,
      aiReviews,
      bankFingerprint: bankFingerprint(bank),
      bankCount: bank.questions.length,
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
    setMsg([])
    try {
      const text = await f.text()
      const res = parseExport(text)
      if (!res.ok || !res.payload) {
        setMsg([`导入失败：${res.errors.slice(0, 6).join('；')}`, '未写入任何数据。'])
        return
      }

      const localFp = bankFingerprint(bank)
      const bankMismatch = Boolean(res.payload.bankFingerprint) && res.payload.bankFingerprint !== localFp
      const unknownQids = res.payload.records.filter((r) => !bank.questions.some((q) => q.id === r.qid)).length

      // Preview the plan BEFORE writing anything.
      const plan = planImport(res.payload, mode, {
        records: Array.from(records.values()),
        history,
        mocks,
        aiReviews,
      })

      const lines: string[] = []
      if (bankMismatch) {
        lines.push(
          `警告：备份来自不同的题库（备份 ${res.payload.bankCount ?? '?'} 题，当前 ${bank.questions.length} 题）。` +
            `题库不一致时历史与模拟记录可能无法对应到题目。`,
        )
      }
      if (unknownQids > 0) {
        lines.push(`警告：${unknownQids} 条学习记录的 qid 不在当前题库中。`)
      }
      lines.push(...res.warnings, ...describePlan(plan, mode))

      if (
        plan.records.length === 0 &&
        plan.history.length === 0 &&
        plan.mocks.length === 0 &&
        plan.aiReviews.length === 0
      ) {
        lines.push('导入中止：备份中没有任何有效数据，未写入数据库。')
        setMsg(lines)
        return
      }

      // Single transaction — either everything is restored or nothing is.
      await restoreBackup({
        records: plan.records,
        history: plan.history,
        mocks: plan.mocks,
        aiReviews: plan.aiReviews,
        settings: (res.payload.settings as typeof settings | null) ?? null,
      })

      lines.push('导入完成：学习记录、历史、模拟考试、AI 评阅与偏好设置已全部恢复。')
      setMsg(lines)
      toast('导入完成')
    } catch (e) {
      // Transaction aborted: previous data is untouched.
      setMsg([`导入失败：${(e as Error).message}`, '数据库未发生任何更改（事务已回滚）。'])
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
            选择此前导出的 JSON 文件。导入前会先校验格式、题库一致性与数据有效性，并在同一事务中写入；
            任一步骤失败则整体回滚，不会留下半成品数据。
          </div>
          <div className="field">
            <span className="field-label">恢复策略</span>
            <div className="btn-row">
              <button
                className={`btn btn-sm ${mode === 'replace' ? 'btn-primary' : ''}`}
                onClick={() => setMode('replace')}
              >
                替换（清空后写入）
              </button>
              <button
                className={`btn btn-sm ${mode === 'merge' ? 'btn-primary' : ''}`}
                onClick={() => setMode('merge')}
              >
                合并（同 ID 以备份为准）
              </button>
            </div>
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
          <li>备份包含学习记录、练习历史、模拟考试成绩、AI 评阅与偏好设置，导出时附带题库指纹用于一致性校验。</li>
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
