import type { QRecord, HistoryEntry, MockRun, AiReview } from './types'

export interface ExportPayload {
  schema: string
  exportedAt: number
  appVersion: string
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
}

/** Create the export payload. */
export function makeExportPayload(input: {
  settings: unknown
  records: QRecord[]
  history: HistoryEntry[]
  mocks: MockRun[]
  aiReviews: AiReview[]
}): ExportPayload {
  return {
    schema: 'exampilot.export.v1',
    exportedAt: Date.now(),
    appVersion: '1.0.0',
    ...input,
  }
}

export function serialize(payload: ExportPayload): string {
  return JSON.stringify(payload, null, 2)
}

export interface ParseResult {
  ok: boolean
  payload?: ExportPayload
  errors: string[]
}

/** Parse & validate an exported JSON string. Returns errors rather than throwing. */
export function parseExport(text: string): ParseResult {
  const errors: string[] = []
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { ok: false, errors: [`JSON 解析失败: ${(e as Error).message}`] }
  }
  if (!data || typeof data !== 'object') return { ok: false, errors: ['数据不是对象'] }
  const d = data as Record<string, unknown>
  if (d.schema !== 'exampilot.export.v1') {
    // tolerantly accept raw bank import only
    errors.push(`未知 schema=${d.schema ?? '<missing>'}`)
  }
  if (!Array.isArray(d.records)) errors.push('records 缺失或不是数组')
  if (!Array.isArray(d.history)) errors.push('history 缺失或不是数组')
  if (!Array.isArray(d.mocks)) errors.push('mocks 缺失或不是数组')
  if (!Array.isArray(d.aiReviews)) errors.push('aiReviews 缺失或不是数组')
  // per-record sanity
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
  return { ok: errors.length === 0, payload: d as unknown as ExportPayload, errors }
}

/** Import logic guarded: do not clear DB on malformed/partial payload. */
export async function applyImport(
  payload: ExportPayload,
  io: {
    putRecords: (r: QRecord[]) => Promise<void>
    putHistory: (h: HistoryEntry[]) => Promise<void>
    putMocks: (m: MockRun[]) => Promise<void>
    putAi: (a: AiReview[]) => Promise<void>
    clearAll: () => Promise<void>
  },
): Promise<{ ok: boolean; detail: string[] }> {
  const detail: string[] = []
  const safe = (val: unknown, fallback: unknown[]) =>
    Array.isArray(val) ? (val as unknown[]) : (fallback as unknown[])
  const recs = safe(payload.records, []) as QRecord[]
  const hist = safe(payload.history, []) as HistoryEntry[]
  const mocks = safe(payload.mocks, []) as MockRun[]
  const ai = safe(payload.aiReviews, []) as AiReview[]

  // clean-invalid entries rather than fail everything
  const validRecords = recs.filter((r) => typeof r?.qid === 'string')
  const validHistory = hist.filter((h) => typeof h?.id === 'string' && typeof h?.qid === 'string')
  const validMocks = mocks.filter((m) => typeof m?.id === 'string')
  const validAi = ai.filter((a) => typeof a?.id === 'string' && typeof a?.qid === 'string')

  if (validRecords.length < recs.length) detail.push(`丢弃 ${recs.length - validRecords.length} 条无效记录`)
  if (validHistory.length < hist.length) detail.push(`丢弃 ${hist.length - validHistory.length} 条无效历史`)
  if (validMocks.length < mocks.length) detail.push(`丢弃 ${mocks.length - validMocks.length} 条无效模拟`)
  if (validAi.length < ai.length) detail.push(`丢弃 ${ai.length - validAi.length} 条无效 AI 评阅`)

  // Replace-all semantics with validation guard of payload coherence
  await io.putRecords(validRecords)
  await io.putHistory(validHistory)
  await io.putMocks(validMocks)
  await io.putAi(validAi)
  detail.push(
    `导入完成：记录 ${validRecords.length} / 历史 ${validHistory.length} / 模拟 ${validMocks.length} / AI 评阅 ${validAi.length}`,
  )
  return { ok: true, detail }
}
