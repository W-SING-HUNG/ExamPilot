import Dexie, { type EntityTable } from 'dexie'
import type { QRecord, HistoryEntry, MockRun, AiReview, AppSettings } from '../lib/types'

type SettingsRow = AppSettings & { id: 'main' }

const DB_VERSION = 1

class ExamPilotDB extends Dexie {
  records!: EntityTable<QRecord, 'qid'>
  history!: EntityTable<HistoryEntry, 'id'>
  mocks!: EntityTable<MockRun, 'id'>
  aiReviews!: EntityTable<AiReview, 'id'>
  settings!: EntityTable<SettingsRow, 'id'>

  constructor() {
    super('exampilot-xigai')
    this.version(DB_VERSION).stores({
      records: 'qid, status, nextReviewAt, lastSeenAt, attempts, wrongCount',
      history: 'id, qid, mode, sessionId, submittedAt',
      mocks: 'id, startedAt, endedAt',
      aiReviews: 'id, qid, createdAt',
      settings: 'id',
    })
  }
}

export const db = new ExamPilotDB()

export async function readSettings(): Promise<AppSettings> {
  const row = await db.settings.get('main')
  return row ?? { theme: 'auto', reviewIntervalBase: 1, studyTarget: 30, dailyGoalQuestions: 30 }
}
export async function writeSettings(s: AppSettings): Promise<void> {
  const row: SettingsRow = { ...s, id: 'main' }
  await db.settings.put(row)
}
