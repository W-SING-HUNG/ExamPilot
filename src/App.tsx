import { useEffect, useMemo } from 'react'
import { useStore } from './store/StoreContext'
import { useRoute, type RouteName } from './store/router'
import { Home } from './pages/Home'
import { Practice } from './pages/Practice'
import { Special } from './pages/Special'
import { Subjective } from './pages/Subjective'
import { WrongBank } from './pages/WrongBank'
import { Plan } from './pages/Plan'
import { MockExam } from './pages/MockExam'
import { Diagnosis } from './pages/Diagnosis'
import { HistoryPage } from './pages/HistoryPage'
import { DataIO } from './pages/DataIO'
import { AiPage } from './pages/AiPage'
import { SettingsPage } from './pages/SettingsPage'
import { BankPage } from './pages/BankPage'
import { APP_NAME, APP_DESC } from './lib/meta'
import { Spinner } from './components/ui'
import { ErrorBoundary } from './components/ErrorBoundary'

const NAV: { group: string; items: { r: RouteName; label: string }[] }[] = [
  {
    group: '总览',
    items: [
      { r: 'home', label: '学习总览' },
      { r: 'diagnosis', label: '学习诊断' },
      { r: 'plan', label: '复习计划' },
    ],
  },
  {
    group: '训练',
    items: [
      { r: 'practice', label: '分章练习' },
      { r: 'special', label: '专项训练' },
      { r: 'subjective', label: '主观题训练' },
      { r: 'wrong', label: '错题本' },
      { r: 'mock', label: '全真模拟' },
    ],
  },
  {
    group: '记录',
    items: [
      { r: 'history', label: '练习历史' },
      { r: 'bank', label: '题库查阅' },
    ],
  },
  {
    group: '设置',
    items: [
      { r: 'ai', label: 'AI 助手' },
      { r: 'io', label: '导入导出' },
      { r: 'settings', label: '偏好设置' },
    ],
  },
]

function NavItems({ route, nav }: { route: RouteName; nav: (r: RouteName) => void }) {
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group}>
          <div className="nav-group">{g.group}</div>
          {g.items.map((it) => (
            <button key={it.r} className={`nav-item ${route === it.r ? 'active' : ''}`} onClick={() => nav(it.r)}>
              {it.label}
            </button>
          ))}
        </div>
      ))}
    </>
  )
}

function ThemeApplier({ theme }: { theme: string }) {
  useEffect(() => {
    const apply = () => {
      const t =
        theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = t
    }
    apply()
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
  return null
}

export function App() {
  const { ready, settings } = useStore()
  const [route, nav, params] = useRoute()
  const current = useMemo(() => {
    switch (route) {
      case 'practice':
        return <Practice nav={nav} params={params} />
      case 'special':
        return <Special params={params} />
      case 'subjective':
        return <Subjective params={params} />
      case 'wrong':
        return <WrongBank nav={nav} params={params} />
      case 'plan':
        return <Plan params={params} />
      case 'mock':
        return <MockExam nav={nav} params={params} />
      case 'diagnosis':
        return <Diagnosis nav={nav} params={params} />
      case 'history':
        return <HistoryPage params={params} />
      case 'io':
        return <DataIO params={params} />
      case 'ai':
        return <AiPage params={params} />
      case 'settings':
        return <SettingsPage params={params} />
      case 'bank':
        return <BankPage params={params} />
      default:
        return <Home nav={nav} params={params} />
    }
  }, [route, params])

  return (
    <>
      <ThemeApplier theme={settings.theme} />
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-title">{APP_NAME}</span>
            <span className="brand-sub">{APP_DESC}</span>
          </div>
          <nav className="nav">
            <NavItems route={route} nav={(r) => nav(r)} />
          </nav>
        </aside>
        <div style={{ minWidth: 0 }}>
          <nav className="mobile-nav">
            <NavItems route={route} nav={(r) => nav(r)} />
          </nav>
          <main className="main">
            {!ready ? (
              <Spinner label="正在载入题库与学习记录…" />
            ) : (
              <ErrorBoundary>
                <div className="page">{current}</div>
              </ErrorBoundary>
            )}
          </main>
        </div>
      </div>
    </>
  )
}
