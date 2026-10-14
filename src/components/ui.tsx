import { type ReactNode, useState, useEffect } from 'react'

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`card ${className}`}>{children}</div>
}

export function CardPad({
  children,
  className = '',
  style,
}: {
  children: ReactNode
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <div className={`card card-pad ${className}`} style={style}>
      {children}
    </div>
  )
}

export function Stat({ value, label, hint }: { value: ReactNode; label: string; hint?: string }) {
  return (
    <CardPad>
      <div className="stat-num">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && (
        <div className="muted-2" style={{ marginTop: 4 }}>
          {hint}
        </div>
      )}
    </CardPad>
  )
}

export function Bar({ value, tone = 'accent' }: { value: number; tone?: 'accent' | 'ok' | 'bad' | 'warn' }) {
  const pct = Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className={`bar ${tone === 'accent' ? '' : tone}`}>
      <span style={{ width: `${pct}%` }} />
    </div>
  )
}

export function Tag({
  children,
  tone = 'plain',
}: {
  children: ReactNode
  tone?: 'plain' | 'ok' | 'bad' | 'warn' | 'accent'
}) {
  const cls = tone === 'plain' ? 'tag' : `tag tag-${tone}`
  return <span className={cls}>{children}</span>
}

export function PageHead({ title, desc, extra }: { title: string; desc?: string; extra?: ReactNode }) {
  return (
    <div className="page-head row-between">
      <div>
        <h1 className="page-title">{title}</h1>
        {desc && <p className="page-desc">{desc}</p>}
      </div>
      {extra}
    </div>
  )
}

export function Empty({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {text}
      {children && <div style={{ marginTop: 12 }}>{children}</div>}
    </div>
  )
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="loading">
      <div className="col" style={{ alignItems: 'center', gap: 8 }}>
        <div className="spinner" />
        {label && <span className="muted-2">{label}</span>}
      </div>
    </div>
  )
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    if (!msg) return
    const t = setTimeout(() => setMsg(null), 2600)
    return () => clearTimeout(t)
  }, [msg])
  const el = msg ? <div className="toast">{msg}</div> : null
  return { toast: setMsg, el }
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="muted-2">{hint}</span>}
    </label>
  )
}
