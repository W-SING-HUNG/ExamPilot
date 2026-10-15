import { useRef, useState } from 'react'
import { useStore } from '../store/StoreContext'
import {
  parseExport,
  makeExportPayload,
  serialize,
  planImport,
  diffImport,
  describePlan,
  checkBank,
  bankFingerprint,
  type RestoreMode,
  type ExportPayload,
  type ImportDiff,
  type BankCheck,
  type ImportPlan,
} from '../lib/io'
import { CardPad, PageHead, Tag, useToast } from '../components/ui'
import { APP_VERSION } from '../lib/meta'
import { bank } from '../lib/bank'

/**
 * Import is a two-step flow:
 *   1. select a file -> validate -> show a PREVIEW (contents, strategy, diff, risks)
 *   2. the user explicitly confirms -> one transaction writes everything
 *
 * Nothing is written before the user confirms, and a replace restore requires an
 * explicit overwrite acknowledgement.
 */
interface Preview {
  fileName: string
  payload: ExportPayload
  diff: ImportDiff
  bankCheck: BankCheck
  plan: ImportPlan
  warnings: string[]
}

export function DataIO({ params: _params }: { params: Record<string, string> }) {
  const { records, history, mocks, aiReviews, settings, ready, restoreBackup } = useStore()
  const { toast, el } = useToast()
  const fileRef = useRef<HTMLInputElement>(null)
  const [msg, setMsg] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<RestoreMode>('merge')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [overwriteAck, setOverwriteAck] = useState(false)
  const [mismatchAck, setMismatchAck] = useState(false)
  const [legacyAck, setLegacyAck] = useState(false)

  const currentData = () => ({
    records: Array.from(records.values()),
    history,
    mocks,
    aiReviews,
    settings,
  })

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

  /** Step 1: validate and build a preview. Writes NOTHING. */
  const onFile = async (f: File) => {
    setBusy(true)
    setMsg([])
    setPreview(null)
    setOverwriteAck(false)
    setMismatchAck(false)
    setLegacyAck(false)
    try {
      const text = await f.text()
      const res = parseExport(text)
      if (!res.ok || !res.payload) {
        setMsg(['导入失败：备份未通过校验，未写入任何数据。', ...res.errors.slice(0, 8)])
        return
      }
      const payload = res.payload
      const existing = currentData()
      const bankCheck = checkBank(
        payload,
        bankFingerprint(bank),
        bank.questions.length,
        new Set(bank.questions.map((q) => q.id)),
      )
      setPreview({
        fileName: f.name,
        payload,
        diff: diffImport(payload, mode, existing),
        bankCheck,
        plan: planImport(payload, mode, existing),
        warnings: res.warnings,
      })
    } catch (e) {
      setMsg([`导入失败：${(e as Error).message}`, '未写入任何数据。'])
    } finally {
      setBusy(false)
    }
  }

  /** Recompute the preview when the strategy changes. */
  const switchMode = (m: RestoreMode) => {
    setMode(m)
    setOverwriteAck(false)
    if (!preview) return
    const existing = currentData()
    setPreview({
      ...preview,
      diff: diffImport(preview.payload, m, existing),
      plan: planImport(preview.payload, m, existing),
    })
  }

  const cancelPreview = () => {
    setPreview(null)
    setMsg(['已取消导入，数据库未发生任何更改。'])
  }

  /** Step 2: the user confirmed — write everything in one transaction. */
  const confirmImport = async () => {
    if (!preview) return
    if (mode === 'replace' && !overwriteAck) {
      setMsg(['替换模式会清空现有学习数据，请先勾选确认。'])
      return
    }
    if (preview.bankCheck.status === 'mismatch' && !mismatchAck) {
      setMsg(['题库指纹不一致，请先确认你了解风险。'])
      return
    }
    if (preview.bankCheck.status === 'unknown' && !legacyAck) {
      setMsg(['旧版备份缺少题库指纹，请先确认你了解风险。'])
      return
    }
    setBusy(true)
    try {
      const { plan } = preview
      await restoreBackup({
        records: plan.records,
        history: plan.history,
        mocks: plan.mocks,
        aiReviews: plan.aiReviews,
        settings: plan.settings,
      })
      setMsg(['导入完成：学习记录、历史、模拟考试、AI 评阅与偏好设置已按所选策略恢复。', ...describePlan(plan, mode)])
      setPreview(null)
      toast('导入完成')
    } catch (e) {
      setMsg([`导入失败：${(e as Error).message}`, '数据库未发生任何更改（事务已回滚）。'])
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return null

  const needsAck =
    (mode === 'replace' && !overwriteAck) ||
    (preview?.bankCheck.status === 'mismatch' && !mismatchAck) ||
    (preview?.bankCheck.status === 'unknown' && !legacyAck) ||
    Boolean(preview && preview.bankCheck.unmatchedRecords + preview.bankCheck.unmatchedHistory > 0)

  return (
    <>
      <PageHead
        title="数据导入导出"
        desc="所有学习数据保存在浏览器本地数据库（IndexedDB）。导出为 JSON 备份后可在任意设备恢复。导入前会先展示预览并要求确认。"
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
          <div className="muted-2" style={{ marginTop: 4 }}>
            题库指纹 {bankFingerprint(bank).slice(0, 12)}…
          </div>
        </CardPad>

        <CardPad>
          <div className="card-title">导入恢复</div>
          <div className="muted" style={{ marginBottom: 10 }}>
            选择备份文件后，系统会先校验格式并展示内容预览、恢复策略、与现有数据的差异和风险；
            <b>在你点击「确认导入」之前不会写入任何数据</b>。
          </div>
          <div className="field">
            <span className="field-label">恢复策略</span>
            <div className="btn-row">
              <button
                className={`btn btn-sm ${mode === 'merge' ? 'btn-primary' : ''}`}
                onClick={() => switchMode('merge')}
              >
                合并（同 ID 以备份为准）
              </button>
              <button
                className={`btn btn-sm ${mode === 'replace' ? 'btn-primary' : ''}`}
                onClick={() => switchMode('replace')}
              >
                替换（清空后写入）
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
              处理中…
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

      {preview && (
        <CardPad style={{ marginTop: 14 }}>
          <div className="row-between" style={{ marginBottom: 10 }}>
            <div className="card-title" style={{ margin: 0 }}>
              导入预览 — {preview.fileName}
            </div>
            <Tag tone={preview.bankCheck.status === 'match' ? 'ok' : 'warn'}>
              {preview.bankCheck.status === 'match'
                ? '题库一致'
                : preview.bankCheck.status === 'mismatch'
                  ? '题库不一致'
                  : '题库未知（旧版备份）'}
            </Tag>
          </div>

          <div className="muted" style={{ marginBottom: 10 }}>
            {preview.bankCheck.message}
          </div>

          {preview.bankCheck.status === 'mismatch' && (
            <div className="result-banner bad" style={{ marginBottom: 10 }}>
              备份来自不同的题库。恢复后这些记录无法对应到当前题目，会污染覆盖率与正确率统计。系统不会自动执行恢复 ——
              请确认你了解风险后再继续。
            </div>
          )}
          {preview.bankCheck.status === 'unknown' && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              这是旧版备份（缺少题库指纹），无法确认题目是否一致。请确认后再继续。
            </div>
          )}
          {preview.bankCheck.unmatchedRecords + preview.bankCheck.unmatchedHistory > 0 && (
            <div className="result-banner warn" style={{ marginBottom: 10 }}>
              备份中有 {preview.bankCheck.unmatchedRecords} 条学习记录、
              {preview.bankCheck.unmatchedHistory} 条历史记录的题目不在当前题库中。这些条目无法可靠匹配，请谨慎继续。
            </div>
          )}

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>数据</th>
                  <th>备份中</th>
                  <th>现有</th>
                  <th>新增</th>
                  <th>覆盖</th>
                  <th>恢复后</th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    ['学习记录', preview.diff.records],
                    ['练习历史', preview.diff.history],
                    ['模拟考试', preview.diff.mocks],
                    ['AI 评阅', preview.diff.aiReviews],
                  ] as const
                ).map(([label, d]) => (
                  <tr key={label}>
                    <td>{label}</td>
                    <td>{d.incoming}</td>
                    <td>{d.existing}</td>
                    <td>{d.added}</td>
                    <td>{d.updated}</td>
                    <td>{mode === 'replace' ? d.incoming : d.existing + d.added}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divider" />
          <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
            {describePlan(preview.plan, mode).map((l, i) => (
              <li key={i}>{l}</li>
            ))}
            {preview.diff.settingsChanged && <li>偏好设置：备份中的设置与当前不同，将被应用。</li>}
            {mode === 'replace' && preview.diff.clearedInReplace > 0 && (
              <li style={{ color: 'var(--bad)' }}>
                替换将删除现有 {preview.diff.clearedInReplace} 条数据（学习记录 / 历史 / 模拟 / AI 评阅）。
              </li>
            )}
            {preview.warnings.map((w, i) => (
              <li key={`w${i}`} style={{ color: 'var(--warn)' }}>
                {w}
              </li>
            ))}
          </ul>

          <div className="divider" />
          {mode === 'replace' && (
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={overwriteAck} onChange={(e) => setOverwriteAck(e.target.checked)} />
              <span className="muted">我确认要用备份替换现有全部学习数据（现有数据将被删除，且不可撤销）</span>
            </label>
          )}
          {preview.bankCheck.status === 'mismatch' && (
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={mismatchAck} onChange={(e) => setMismatchAck(e.target.checked)} />
              <span className="muted">我确认题库不一致，仍要导入（可能导致统计失真）</span>
            </label>
          )}
          {preview.bankCheck.status === 'unknown' && (
            <label className="row" style={{ gap: 8, marginBottom: 8 }}>
              <input type="checkbox" checked={legacyAck} onChange={(e) => setLegacyAck(e.target.checked)} />
              <span className="muted">我确认这是旧版备份，无法校验题库一致性，仍要导入</span>
            </label>
          )}

          <div className="btn-row">
            <button className="btn btn-primary" onClick={confirmImport} disabled={busy || needsAck}>
              确认导入
            </button>
            <button className="btn" onClick={cancelPreview} disabled={busy}>
              取消
            </button>
            {needsAck && <span className="muted-2">请先完成上方确认项</span>}
          </div>
        </CardPad>
      )}

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">数据说明</div>
        <ul className="muted" style={{ margin: 0, paddingLeft: 20, lineHeight: 2 }}>
          <li>备份包含学习记录、练习历史、模拟考试成绩、AI 评阅与偏好设置，并附带题库指纹用于一致性校验。</li>
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
