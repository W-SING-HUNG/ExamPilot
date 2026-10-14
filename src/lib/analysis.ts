import type { QRecord, Question, HistoryEntry } from './types'

export interface TypeStat {
  type: Question['type']
  label: string
  total: number
  attempted: number
  coverage: number // attempted/total
  correct: number
  wrong: number
  correctRate: number // among attempted
  mastered: number
  struggling: number
}

export interface ChapterStat {
  chapter: string
  total: number
  attempted: number
  coverage: number
  correct: number
  wrong: number
  correctRate: number
  mastered: number
  struggling: number
  single: number
  multi: number
  judge: number
  subj: number
}

export interface WeakPoint {
  chapter: string
  score: number // lower = weaker
  detail: string
}

export interface Diagnosis {
  chapters: ChapterStat[]
  types: TypeStat[]
  weakPoints: WeakPoint[]
  overall: {
    total: number
    attempted: number
    coverage: number
    ourMastered: number
    correct: number
    wrong: number
    correctRate: number
    objectiveAttempted: number
    subjectiveAttempted: number
  }
}

export function computeDiagnosis(questions: Question[], records: Map<string, QRecord>): Diagnosis {
  const chapters: ChapterStat[] = []
  const byChapterMap: Record<string, Question[]> = {}
  for (const q of questions) {
    if (q.type === 'short' || q.type === 'material') continue // handle separately
    ;(byChapterMap[q.chapter] ??= []).push(q)
  }
  const chapterOrder = Array.from(new Set(questions.map((q) => q.chapter)))
  for (const ch of chapterOrder) {
    const list = byChapterMap[ch] ?? []
    const subj = list.filter((q) => q.type === 'short' || q.type === 'material')
    const obj = list.filter((q) => q.type !== 'short' && q.type !== 'material')
    const recs = obj.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
    const attempted = recs.filter((r) => r.attempts > 0).length
    const correct = recs.reduce((s, r) => s + r.correctCount, 0)
    const wrong = recs.reduce((s, r) => s + r.wrongCount, 0)
    const totalAttempts = correct + wrong
    chapters.push({
      chapter: ch,
      total: obj.length + subj.length,
      attempted,
      coverage: obj.length ? attempted / obj.length : 0,
      correct: recs.reduce((s, r) => s + r.correctCount, 0),
      wrong: recs.reduce((s, r) => s + r.wrongCount, 0),
      correctRate: totalAttempts ? correct / totalAttempts : 0,
      mastered: recs.filter((r) => r.status === 'mastered').length,
      struggling: recs.filter((r) => r.status === 'struggling').length,
      single: obj.filter((q) => q.type === 'single').length,
      multi: obj.filter((q) => q.type === 'multi').length,
      judge: obj.filter((q) => q.type === 'judge').length,
      subj: subj.length,
    })
  }

  const typeLabels: Record<Question['type'], string> = {
    single: '单选题',
    multi: '多选题',
    judge: '判断题',
    short: '简答题',
    material: '材料分析题',
  }
  const types: TypeStat[] = (['single', 'multi', 'judge', 'short', 'material'] as Question['type'][]).map((t) => {
    const list = questions.filter((q) => q.type === t)
    const recs = list.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
    const attempted = recs.filter((r) => r.attempts > 0).length
    const correct = recs.reduce((s, r) => s + r.correctCount, 0)
    const wrong = recs.reduce((s, r) => s + r.wrongCount, 0)
    const tt = correct + wrong
    return {
      type: t,
      label: typeLabels[t],
      total: list.length,
      attempted,
      coverage: list.length ? attempted / list.length : 0,
      correct,
      wrong,
      correctRate: tt ? correct / tt : 0,
      mastered: recs.filter((r) => r.status === 'mastered').length,
      struggling: recs.filter((r) => r.status === 'struggling').length,
    }
  })

  // weak points: low coverage chapters & low correct-rate chapters rank
  const weakPoints: WeakPoint[] = chapters
    .filter((c) => c.attempted < c.total * 0.99 || (c.attempted > 0 && c.correctRate < 0.8))
    .map((c) => {
      // score 0-100: blend coverage and correctRate
      const cov = c.coverage
      const rec = c.correctRate > 0 ? c.correctRate : c.attempted === 0 ? 0 : 0.5
      const score = Math.round((cov * 0.4 + rec * 0.6) * 100)
      const bits = []
      if (cov < 0.7) bits.push(`覆盖率仅 ${Math.round(cov * 100)}%`)
      if (cov >= 0.7 && rec < 0.6) bits.push(`正确率仅 ${Math.round(rec * 100)}%`)
      if (c.struggling > 0) bits.push(`${c.struggling} 道难点题`)
      return { chapter: c.chapter, score, detail: bits.join('；') || '待进一步巩固' }
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, 6)

  const obj = questions.filter((q) => q.type !== 'short' && q.type !== 'material')
  const allRecs = obj.map((q) => records.get(q.id)).filter((r): r is QRecord => !!r)
  const attempted = allRecs.filter((r) => r.attempts > 0).length
  const correct = allRecs.reduce((s, r) => s + r.correctCount, 0)
  const wrong = allRecs.reduce((s, r) => s + r.wrongCount, 0)
  const tt = correct + wrong
  return {
    chapters,
    types,
    weakPoints,
    overall: {
      total: questions.length,
      attempted,
      coverage: obj.length ? attempted / obj.length : 0,
      ourMastered: allRecs.filter((r) => r.status === 'mastered').length,
      correct,
      wrong,
      correctRate: tt ? correct / tt : 0,
      objectiveAttempted: attempted,
      subjectiveAttempted: questions
        .filter((q) => q.type === 'short' || q.type === 'material')
        .filter((q) => (records.get(q.id)?.attempts ?? 0) > 0).length,
    },
  }
}

export function correctRateOfRecords(recs: QRecord[]): number {
  const tt = recs.reduce((s, r) => s + r.correctCount + r.wrongCount, 0)
  if (tt === 0) return 0
  return recs.reduce((s, r) => s + r.correctCount, 0) / tt
}

/** Recent study activity per day */
export function groupActivity(
  history: HistoryEntry[],
  days = 14,
): { date: string; count: number; correct: number; wrong: number }[] {
  const out: { date: string; count: number; correct: number; wrong: number }[] = []
  const now = Date.now()
  for (let d = days - 1; d >= 0; d--) {
    const start = now - d * 86400000
    const end = start + 86400000
    const day = new Date(start).toISOString().slice(0, 10)
    const cnt = history.filter((h) => h.submittedAt >= start && h.submittedAt < end)
    out.push({
      date: day,
      count: cnt.length,
      correct: cnt.filter((h) => h.isCorrect === true).length,
      wrong: cnt.filter((h) => h.isCorrect === false).length,
    })
  }
  return out
}
