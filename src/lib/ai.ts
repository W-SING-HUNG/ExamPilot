/**
 * AI client — talks to the local proxy only (no API key in frontend).
 * Graceful degradation: if unavailable, returns {ok:false, reason} so UI can continue.
 */
export interface AiConfig {
  baseUrl: string
  model: string
  timeoutMs: number
}

const DEFAULT_CONFIG: AiConfig = {
  baseUrl: '/api',
  model: 'default',
  timeoutMs: 60000,
}

export interface AiQaRequest {
  question: { type: string; stem: string; options: string[]; answer?: string | null }
  userAnswer: string
  questionContext?: { chapter: string; bankNo: number }
}

export interface AiQaResponse {
  ok: boolean
  answer?: string
  reason?: string
  provider?: string
  model?: string
}

export interface AiGradeRequest {
  qid: string
  stem: string
  userAnswer: string
  chapter: string
  kind: 'short' | 'material'
}

export interface AiGradeResponse {
  ok: boolean
  result?: {
    score: number
    maxScore: number
    hitPoints: string[]
    missedPoints: string[]
    deductions: string[]
    suggestions: string[]
    structureNote: string
    disclaimer: string
  }
  reason?: string
  provider?: string
  model?: string
}

async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    const text = await res.text()
    let data: unknown = null
    try {
      data = JSON.parse(text)
    } catch {
      data = { ok: false, reason: text.slice(0, 200) }
    }
    return data as T
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      return { ok: false, reason: `请求超时（>${timeoutMs}ms）` } as unknown as T
    }
    return { ok: false, reason: `网络错误：${(e as Error).message}` } as unknown as T
  } finally {
    clearTimeout(timer)
  }
}

export function getAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem('exampilot.ai.config')
    if (raw) {
      const parsed = JSON.parse(raw)
      return { ...DEFAULT_CONFIG, ...parsed }
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_CONFIG
}

export function setAiConfig(c: Partial<AiConfig>): void {
  localStorage.setItem('exampilot.ai.config', JSON.stringify({ ...getAiConfig(), ...c }))
}

export async function aiAskQuestion(req: AiQaRequest): Promise<AiQaResponse> {
  const cfg = getAiConfig()
  return postJson<AiQaResponse>(`${cfg.baseUrl}/ai/qa`, req, cfg.timeoutMs)
}

export async function aiGrade(req: AiGradeRequest): Promise<AiGradeResponse> {
  const cfg = getAiConfig()
  return postJson<AiGradeResponse>(`${cfg.baseUrl}/ai/grade`, req, cfg.timeoutMs)
}

export interface AiStatusResponse {
  ok: boolean
  configured: boolean
  provider?: string
  model?: string
  message: string
}

export async function aiStatus(): Promise<AiStatusResponse> {
  try {
    const res = await fetch('/api/ai/status')
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, configured: false, message: text.slice(0, 200) }
    }
  } catch (e) {
    return { ok: false, configured: false, message: `AI 服务不可用：${(e as Error).message}` }
  }
}
