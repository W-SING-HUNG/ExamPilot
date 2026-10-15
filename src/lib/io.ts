import type { QRecord, HistoryEntry, MockRun, AiReview, BankData } from './types'

export interface ExportPayload {
  schema: string
  exportedAt: number
  appVersion: string
  /** Fingerprint of the bank the backup was taken against (see bankFingerprint). */
  bankFingerprint: string
  bankCount: number
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
}

/** Restore strategy chosen by the user, applied explicitly. */
export type RestoreMode = 'replace' | 'merge'

export function makeExportPayload(input: {
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  bankFingerprint: string
  bankCount: number
}): ExportPayload {
  return {
    schema: 'exampilot.export.v1',
    exportedAt: Date.now(),
    appVersion: '0.2.0-beta',
    settings: input.settings,
    records: input.records,
    history: input.history,
    mocks: input.mocks,
    aiReviews: input.aiReviews,
    bankFingerprint: input.bankFingerprint,
    bankCount: input.bankCount,
  }
}

export function serialize(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2)
}

/**
 * Stable fingerprint of a bank: schema + question count + type counts + id digest.
 * Used to detect that a backup belongs to a different question bank.
 */
export function bankFingerprint(bank: BankData): string {
  const counts = bank.questions.reduce<Record<string, number>>((m, q) => {
    m[q.type] = (m[q.type] ?? 0) + 1
    return m
  }, {})
  const countsStr = Object.keys(counts)
    .sort()
    .map((k) => `${k}:${counts[k]}`)
    .join(',')
  const idDigest = bank.questions.map((q) => q.id).join('|')
  return `${bank.schema}#${bank.questions.length}#${countsStr}#${idDigest.length}:${idDigest.slice(0, 64)}`
}

export interface ParseResult {
  ok: boolean
  payload?: ExportPayload
  errors: string[]
  warnings: string[]
}

/** Parse & validate an exported JSON string. Returns errors instead of throwing. */
export function parseExport(text: string): ParseResult {
  const errors: string[] = []
  const warnings: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${(e as Error).message}`], warnings }
  }
  if (!data || typeof data !== 'object') return { ok: false, errors: ['数据不是对象'], warnings }
  const d = data as Record<string, unknown>
  if (d.schema !== 'exampilot.export.v1') {
    return {
      ok: false,
      errors: [`不支持的备份格式（schema=${String(d.schema)}，期望 exampilot.export.v1）`],
      warnings,
    }
  }
  for (const key of ['records', 'history', 'mocks', 'aiReviews']) {
    if (!Array.isArray(d[key])) errors.push(`${key} 缺失或不是数组`)
  }
  if (typeof d.bankFingerprint !== 'string' || !d.bankFingerprint) {
    warnings.push('备份缺少 bankFingerprint，无法校验题库一致性')
  }

  const recs = (d.records as unknown[]) ?? []
  const recIds = new Set<string>()
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i] as Record<string, unknown>
    if (typeof r?.qid !== 'string' || !r.qid) {
      errors.push(`records[${i}] 缺 qid`)
      continue
    }
    if (recIds.has(r.qid)) errors.push(`records[${i}] 重复 qid=${r.qid}`)
    recIds.add(r.qid)
  }

  const hist = (d.history as unknown[]) ?? []
  const histIds = new Set<string>()
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i] as Record<string, unknown>
    if (typeof h?.id !== 'string' || !h.id) {
      errors.push(`history[${i}] 缺 id`)
      continue
    }
    if (histIds.has(h.id)) errors.push(`history[${i}] 重复 id=${h.id}`)
    histIds.add(h.id)
  }

  const mocks = (d.mocks as unknown[]) ?? []
  const mockIds = new Set<string>()
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i] as Record<string, unknown>
    if (typeof m?.id !== 'string' || !m.id) {
      errors.push(`mocks[${i}] 缺 id`)
      continue
    }
    if (mockIds.has(m.id)) errors.push(`mocks[${i}] 重复 id=${m.id}`)
    mockIds.add(m.id)
  }

  return {
    ok: errors.length === 0,
    payload: errors.length === 0 ? (d as unknown as ExportPayload) : undefined,
    errors,
    warnings,
  }
}

export interface ImportPlan {
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
  dropped: string[]
}

/**
 * Build the concrete write plan for a restore. Invalid entries are DROPPED and
 * reported in `dropped` — they are never silently discarded.
 *
 * - `replace`: the payload fully replaces current data.
 * - `merge`: same-id records take the payload version; collections are unioned by id.
 */
export function planImport(
  payload: ExportPayload,
  mode: RestoreMode,
  existing?: { records: QRecord[]; history: HistoryEntry[]; mocks: MockRun[]; aiReviews: AiReview[] },
): ImportPlan {
  const dropped: string[] = []
  const validRecords = (payload.records ?? []).filter((r) => {
    if (typeof r?.qid !== 'string' || !r.qid) {
      dropped.push('无效学习记录（缺 qid）')
      return false
    }
    return true
  })
  const validHistory = (payload.history ?? []).filter((h) => {
    if (typeof h?.id !== 'string' || typeof h?.qid !== 'string') {
      dropped.push(`无效历史记录（${String(h?.id ?? 'unknown')}）`)
      return false
    }
    return true
  })
  const validMocks = (payload.mocks ?? []).filter((m) => {
    if (typeof m?.id !== 'string') {
      dropped.push(`无效模拟考试记录（${String(m?.id ?? 'unknown')}）`)
      return false
    }
    return true
  })
  const validAi = (payload.aiReviews ?? []).filter((a) => {
    if (typeof a?.id !== 'string' || typeof a?.qid !== 'string') {
      dropped.push(`无效 AI 评阅（${String(a?.id ?? 'unknown')}）`)
      return false
    }
    return true
  })

  if (mode === 'replace' || !existing) {
    return { records: validRecords, history: validHistory, mocks: validMocks, aiReviews: validAi, dropped }
  }

  const byId = <T extends { id: string }>(a: T[], b: T[]): T[] => {
    const m = new Map<string, T>()
    for (const x of a) m.set(x.id, x)
    for (const x of b) m.set(x.id, x) // payload wins on conflict
    return Array.from(m.values())
  }
  const recById = (a: QRecord[], b: QRecord[]): QRecord[] => {
    const m = new Map<string, QRecord>()
    for (const x of a) m.set(x.qid, x)
    for (const x of b) m.set(x.qid, x)
    return Array.from(m.values())
  }
  return {
    records: recById(existing.records, validRecords),
    history: byId(existing.history, validHistory),
    mocks: byId(existing.mocks, validMocks),
    aiReviews: byId(existing.aiReviews, validAi),
    dropped,
  }
}

/** Human-readable summary of what a restore will do. */
export function describePlan(plan: ImportPlan, mode: RestoreMode): string[] {
  const lines = [
    `模式：${mode === 'replace' ? '替换（清空现有数据后写入备份）' : '合并（同一 ID 以备份为准）'}`,
    `学习记录 ${plan.records.length} 条 · 历史 ${plan.history.length} 条 · 模拟考试 ${plan.mocks.length} 场 · AI 评阅 ${plan.aiReviews.length} 条`,
  ]
  if (plan.dropped.length) {
    lines.push(
      `已丢弃 ${plan.dropped.length} 条无效数据：${plan.dropped.slice(0, 5).join('；')}${plan.dropped.length > 5 ? '…' : ''}`,
    )
  }
  return lines
}
