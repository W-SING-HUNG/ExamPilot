import { useState } from 'react'
import { useStore } from '../store/StoreContext'
import { CardPad, PageHead, useToast } from '../components/ui'
import type { AppSettings } from '../lib/types'

export function SettingsPage({ params: _params }: { params: Record<string, string> }) {
  const { settings, ready, updateSettings, resetAllProgress } = useStore()
  const { toast, el } = useToast()
  const [draft, setDraft] = useState<AppSettings>(settings)

  if (!ready) return null

  return (
    <>
      <PageHead title="偏好设置" desc="学习参数与外观设置，保存在本地浏览器中。" />

      <CardPad>
        <div className="card-title">外观</div>
        <div className="btn-row">
          {(
            [
              ['light', '浅色'],
              ['dark', '深色'],
              ['auto', '跟随系统'],
            ] as const
          ).map(([v, l]) => (
            <button
              key={v}
              className={`btn btn-sm ${draft.theme === v ? 'btn-primary' : ''}`}
              onClick={() => setDraft((d) => ({ ...d, theme: v }))}
            >
              {l}
            </button>
          ))}
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">学习参数</div>
        <div className="grid grid-3">
          <label className="field">
            <span className="field-label">每日目标题量</span>
            <input
              className="input"
              type="number"
              min={1}
              max={500}
              value={draft.dailyGoalQuestions}
              onChange={(e) => setDraft((d) => ({ ...d, dailyGoalQuestions: Number(e.target.value) || 30 }))}
            />
          </label>
          <label className="field">
            <span className="field-label">每日目标时长（分钟）</span>
            <input
              className="input"
              type="number"
              min={5}
              max={600}
              value={draft.studyTarget}
              onChange={(e) => setDraft((d) => ({ ...d, studyTarget: Number(e.target.value) || 30 }))}
            />
          </label>
          <label className="field">
            <span className="field-label">复习间隔基数</span>
            <input
              className="input"
              type="number"
              min={1}
              max={10}
              value={draft.reviewIntervalBase}
              onChange={(e) => setDraft((d) => ({ ...d, reviewIntervalBase: Number(e.target.value) || 1 }))}
            />
          </label>
        </div>
        <div className="btn-row">
          <button
            className="btn btn-primary"
            onClick={() => {
              void updateSettings(draft)
              toast('设置已保存')
            }}
          >
            保存设置
          </button>
          <button className="btn btn-ghost" onClick={() => setDraft(settings)}>
            还原
          </button>
        </div>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">危险操作</div>
        <div className="muted" style={{ marginBottom: 10 }}>
          重置将删除全部学习记录、历史、模拟考试与 AI 评阅，且不可恢复。建议先在「导入导出」中备份。
        </div>
        <button
          className="btn btn-danger"
          onClick={() => {
            if (confirm('确定要清空全部学习数据吗？此操作不可恢复。')) {
              void resetAllProgress()
              toast('已重置')
            }
          }}
        >
          重置全部学习数据
        </button>
      </CardPad>

      <CardPad style={{ marginTop: 14 }}>
        <div className="card-title">关于</div>
        <div className="muted">
          ExamPilot 习概 — 《习近平新时代中国特色社会主义思想概论》期末智能复习。题库解析自指定 PDF，
          客观题答案以题库为准；AI 功能通过本地服务端代理访问你自己的网关，密钥不暴露在前端。
        </div>
      </CardPad>
      {el}
    </>
  )
}
