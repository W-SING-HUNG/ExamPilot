import { useEffect, useState } from 'react'
import { useStore } from '../store/StoreContext'
import { aiStatus, type AiStatusResponse } from '../lib/ai'
import { CardPad, PageHead, Tag, useToast } from '../components/ui'

export function AiPage({ params: _params }: { params: Record<string, string> }) {
  const { aiReviews, ready } = useStore()
  const { toast, el } = useToast()
  const [status, setStatus] = useState<AiStatusResponse | null>(null)
  const [checking, setChecking] = useState(false)
  const [form, setForm] = useState({ baseUrl: '', apiKey: '', model: '', timeoutMs: 60000 })
  const [saving, setSaving] = useState(false)

  const check = async () => {
    setChecking(true)
    const s = await aiStatus()
    setStatus(s)
    setChecking(false)
  }

  useEffect(() => {
    void check()
  }, [])

  const save = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = await res.json()
      toast(data.message ?? '已保存')
      await check()
    } catch (e) {
      toast(`保存失败：${(e as Error).message}`)
    } finally {
      setSaving(false)
    }
  }

  if (!ready) return null

  return (
    <>
      <PageHead
        title="AI 助手"
        desc="接入你自己的 Sub2API 网关：密钥仅保存在服务端配置文件中，前端不接触密钥。AI 不可用时，刷题、评分与本地记录照常工作。"
      />

      <CardPad>
        <div className="row-between" style={{ marginBottom: 10 }}>
          <div className="card-title">网关状态</div>
          <button className="btn btn-sm" onClick={check} disabled={checking}>
            {checking ? '检测中…' : '重新检测'}
          </button>
        </div>
        {status ? (
          <>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <Tag tone={status.configured ? 'ok' : 'warn'}>{status.configured ? '已配置' : '未配置'}</Tag>
              {status.model && <Tag>{status.model}</Tag>}
            </div>
            <div className="muted">{status.message}</div>
          </>
        ) : (
          <div className="muted">正在检测…</div>
        )}
        <div className="divider" />
        <div className="muted-2">
          服务端代理需单独启动：<span className="code">npm run server</span>（默认 http://127.0.0.1:8787）。 开发模式下
          Vite 已将 <span className="code">/api</span> 代理到该端口。也可通过环境变量
          <span className="code">AI_BASE_URL</span> / <span className="code">AI_API_KEY</span> /{' '}
          <span className="code">AI_MODEL</span> 配置。
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">网关配置（保存在服务端）</div>
        <div className="grid grid-2">
          <label className="field">
            <span className="field-label">Base URL（OpenAI 兼容）</span>
            <input
              className="input"
              placeholder="https://your-sub2api-host/v1"
              value={form.baseUrl}
              onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">模型名称</span>
            <input
              className="input"
              placeholder="例如 gpt-4o-mini / deepseek-chat"
              value={form.model}
              onChange={(e) => setForm((f) => ({ ...f, model: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">API Key（仅写入服务端配置文件，不进入前端）</span>
            <input
              className="input"
              type="password"
              placeholder="sk-..."
              value={form.apiKey}
              onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
            />
          </label>
          <label className="field">
            <span className="field-label">超时（毫秒）</span>
            <input
              className="input"
              type="number"
              min={5000}
              max={300000}
              value={form.timeoutMs}
              onChange={(e) => setForm((f) => ({ ...f, timeoutMs: Number(e.target.value) || 60000 }))}
            />
          </label>
        </div>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存配置'}
        </button>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">能力范围</div>
        <div className="col" style={{ gap: 8 }}>
          <Capability
            title="题目答疑与错误原因"
            desc="基于当前题目解释答案依据、各选项对错原因；客观题答案始终以题库为准。"
          />
          <Capability
            title="简答 / 材料题参考评阅"
            desc="给出参考分、命中采分点、遗漏内容、扣分依据与修改建议，并保存你的原作答。"
          />
          <Capability
            title="不可用时的降级"
            desc="AI 离线时客观题仍由题库自动评分，学习记录本地持久化，AI 面板会显示具体原因。"
          />
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">我的 AI 评阅记录（{aiReviews.length}）</div>
        {aiReviews.length === 0 ? (
          <div className="muted">还没有 AI 评阅记录。在主观题训练中提交作答后即可获得参考评阅。</div>
        ) : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>题目</th>
                  <th>参考分</th>
                  <th>命中</th>
                  <th>遗漏</th>
                </tr>
              </thead>
              <tbody>
                {aiReviews.slice(0, 20).map((r) => (
                  <tr key={r.id}>
                    <td className="code" style={{ whiteSpace: 'nowrap' }}>
                      {new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </td>
                    <td style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.userAnswer.slice(0, 30) || '（空）'}
                    </td>
                    <td>
                      <b>{r.result.score}</b>/{r.result.maxScore}
                    </td>
                    <td>{r.result.hitPoints.length}</td>
                    <td>{r.result.missedPoints.length}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="muted-2" style={{ marginTop: 8 }}>
          AI 评阅均为参考评阅，非官方标准分数。
        </div>
      </CardPad>
      {el}
    </>
  )
}

function Capability({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="row-between">
      <b style={{ fontSize: 13.5, width: 170 }}>{title}</b>
      <span className="muted" style={{ flex: 1 }}>
        {desc}
      </span>
    </div>
  )
}
