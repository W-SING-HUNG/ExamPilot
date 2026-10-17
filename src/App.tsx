import { useEffect, useMemo, useState, useRef } from 'react'
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

interface NavEntry {
  r: RouteName
  label: string
}

const NAV: { group: string; items: NavEntry[] }[] = [
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

const ALL_ITEMS = NAV.flatMap((g) => g.items)

function NavItems({ route, nav, onPicked }: { route: RouteName; nav: (r: RouteName) => void; onPicked?: () => void }) {
  return (
    <>
      {NAV.map((g) => (
        <div key={g.group} role="group" aria-label={g.group}>
          <div className="nav-group">{g.group}</div>
          {g.items.map((it) => (
            <button
              key={it.r}
              type="button"
              className={`nav-item ${route === it.r ? 'active' : ''}`}
              aria-current={route === it.r ? 'page' : undefined}
              onClick={() => {
                nav(it.r)
                onPicked?.()
              }}
            >
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

/** Collapsible navigation for tablet and phone, with Escape-to-close. */
function MobileNav({ route, nav }: { route: RouteName; nav: (r: RouteName) => void }) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  const currentLabel = ALL_ITEMS.find((i) => i.r === route)?.label ?? APP_NAME

  return (
    <>
      <header className="topbar">
        <button
          ref={btnRef}
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={open}
          aria-controls="mobile-menu"
          aria-label={open ? '关闭导航菜单' : '打开导航菜单'}
          onClick={() => setOpen((v) => !v)}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            {open ? (
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            ) : (
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <span className="topbar-title">{currentLabel}</span>
        <span className="topbar-spacer" />
      </header>
      {open && (
        <nav className="mobile-menu" id="mobile-menu" aria-label="主导航">
          <NavItems route={route} nav={nav} onPicked={() => setOpen(false)} />
        </nav>
      )}
    </>
  )
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
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-title">{APP_NAME}</span>
            <span className="brand-sub">{APP_DESC}</span>
          </div>
          <nav className="nav" aria-label="主导航">
            <NavItems route={route} nav={(r) => nav(r)} />
          </nav>
        </aside>
        <div style={{ minWidth: 0 }}>
          <MobileNav route={route} nav={(r) => nav(r)} />
          <main className="main" id="main-content" tabIndex={-1}>
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
