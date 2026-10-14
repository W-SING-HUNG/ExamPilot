import { describe, it, expect } from 'vitest'
import { parseExport, applyImport, makeExportPayload, serialize } from './io'
import type { QRecord } from './types'

const mkre = (qid: string, i: number): QRecord => ({
  qid,
  status: 'learning',
  attempts: i,
  correctCount: i,
  wrongCount: 0,
  lastSeenAt: 1,
  lastCorrect: true,
  lastAnswer: 'B',
  intervalDays: 1,
  ease: 2,
  nextReviewAt: 1,
})
const hist = [
  { id: 'h1', qid: 'a', mode: 'practice', sessionId: 's', answer: 'B', isCorrect: true, submittedAt: 1, usedAI: false },
]

describe('io', () => {
  it('parseExport rejects malformed JSON', () => {
    const r = parseExport('not json')
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('JSON'))).toBe(true)
  })
  it('parseExport reports schema mismatch', () => {
    const r = parseExport(JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }))
    expect(r.ok).toBe(false)
  })
  it('round-trips valid payload', () => {
    const p = makeExportPayload({ settings: {}, records: [mkre('q9', 2)], history: hist, mocks: [], aiReviews: [] })
    const s = serialize(p)
    const r = parseExport(s)
    expect(r.ok).toBe(true)
    expect(r.payload?.records?.length).toBe(1)
  })
  it('detects duplicate qids in records', () => {
    const p = makeExportPayload({
      settings: {},
      records: [mkre('x', 1), mkre('x', 2)],
      history: [],
      mocks: [],
      aiReviews: [],
    })
    const r = parseExport(serialize(p))
    expect(r.ok).toBe(false)
    expect(r.errors.some((e) => e.includes('重复 qid'))).toBe(true)
  })
  it('applyImport handles missing arrays gracefully', async () => {
    const calls: string[] = []
    const io = {
      putRecords: async (r: unknown[]) => {
        calls.push(`records:${r.length}`)
      },
      putHistory: async (h: unknown[]) => {
        calls.push(`history:${h.length}`)
      },
      putMocks: async (m: unknown[]) => {
        calls.push(`mocks:${m.length}`)
      },
      putAi: async (a: unknown[]) => {
        calls.push(`ai:${a.length}`)
      },
      clearAll: async () => {
        calls.push('clear')
      },
    }
    const p = {
      ...makeExportPayload({ settings: {}, records: [], history: [], mocks: [], aiReviews: [] }),
      records: undefined as never,
      history: undefined as never,
    }
    const res = await applyImport(p, io)
    expect(res.ok).toBe(true)
    expect(calls).toContain('records:0')
    expect(calls).toContain('history:0')
  })
})
