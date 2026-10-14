import { useEffect, useState } from 'react'

export type RouteName =
  | 'home'
  | 'practice'
  | 'special'
  | 'subjective'
  | 'wrong'
  | 'plan'
  | 'mock'
  | 'diagnosis'
  | 'history'
  | 'io'
  | 'ai'
  | 'settings'
  | 'bank'

export function useRoute(): [
  RouteName,
  (r: RouteName, params?: Record<string, string>) => void,
  Record<string, string>,
] {
  const parse = (): { route: RouteName; params: Record<string, string> } => {
    const h = window.location.hash.replace(/^#\/?/, '')
    const [path, qs] = h.split('?')
    const route = (path || 'home') as RouteName
    const params: Record<string, string> = {}
    if (qs)
      for (const kv of qs.split('&')) {
        const [k, v] = kv.split('=')
        if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
      }
    return { route, params }
  }
  const [{ route, params }, setState] = useState(parse)
  useEffect(() => {
    const on = () => setState(parse())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const nav = (r: RouteName, p?: Record<string, string>) => {
    const qs = p && Object.keys(p).length ? '?' + new URLSearchParams(p).toString() : ''
    window.location.hash = `/${r}${qs}`
    setState({ route: r, params: p ?? {} })
  }
  return [route, nav, params]
}
