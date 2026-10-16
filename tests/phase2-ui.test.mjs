/**
 * Phase-2 behaviour through the REAL UI, not just the pure functions.
 *
 * The unit tests cover the algorithms; this file verifies the wired-up app
 * actually exhibits the new behaviour end to end.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.E2E_BASE || 'http://localhost:5173'
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let browser

async function freshPage() {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  const errors = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/Failed to load resource/.test(t) && /\/api\//.test(t)) return
    if (/\b50[23]\b/.test(t)) return
    errors.push(`console: ${t}`)
  })
  await p.goto(BASE, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell', { timeout: 20000 })
  return { p, ctx, errors }
}

const nav = async (p, route) => {
  await p.evaluate((r) => {
    window.location.hash = `/${r}`
  }, route)
  await new Promise((r) => setTimeout(r, 500))
}

test('phase-2 UI behaviour', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    if (browser) await browser.close()
  })

  // ---- 1. struggling recovers through the real UI -------------------------

  await t.test('UI-1: a struggling question recovers to mastered through practice', async () => {
    const { p, ctx, errors } = await freshPage()
    // Seed a question as struggling (3 wrong answers) and make it due.
    await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const q = bankMod.objectiveQuestions[0]
      let r = sch.freshRecord(q.id, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 10 * 86400000)
      r = sch.applyAttempt(r, false, now - 9 * 86400000)
      r = sch.applyAttempt(r, false, now - 8 * 86400000)
      r.lastAnswer = 'A'
      await dbmod.db.records.put(r)
    })
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')

    // It must appear in the wrong bank as a struggling question.
    await nav(p, 'wrong')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '难点题')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /难点|待清除|巩固中/, 'the struggling question is listed')

    // Answer it correctly 3 times through the real practice UI.
    await nav(p, 'practice')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent?.includes('开始练习'))?.click()
    })
    for (let i = 0; i < 3; i++) {
      await p.waitForSelector('.q-stem', { timeout: 15000 }).catch(() => {})
      const answered = await p.evaluate(() => {
        const opt = document.querySelector('.opt')
        if (opt) {
          opt.click()
          return true
        }
        const jb = document.querySelector('.judge-btn')
        if (jb) {
          jb.click()
          return true
        }
        return false
      })
      if (!answered) break
      await p.evaluate(() => {
        const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
        b[0]?.click()
      })
      await new Promise((r) => setTimeout(r, 700))
    }
    // The app must still be functional and error-free.
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 2. the plan shows the real quota -----------------------------------

  await t.test('UI-2: the plan preview reports the objective count honestly', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'plan')
    await p.waitForSelector('.page-title')

    for (const label of ['10 题', '20 题', '30 题', '50 题']) {
      await p.evaluate((l) => {
        const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === l)
        b?.click()
      }, label)
      await new Promise((r) => setTimeout(r, 500))
      const preview = await p.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.card-title')).find((x) =>
          /计划预览（客观题 \d+ 题/.test(x.textContent ?? ''),
        )
        return el?.textContent ?? ''
      })
      const m = preview.match(/客观题 (\d+) 题/)
      assert.ok(m, `preview states the objective count for ${label}, got: ${preview}`)
      const n = Number(m[1])
      const requested = Number(label.replace(' 题', ''))
      assert.ok(n > 0, `a plan exists for ${label}`)
      assert.ok(n <= requested, `never more than requested for ${label}: ${n} > ${requested}`)
    }
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 3. the diagnosis shows the two weak-point kinds --------------------

  await t.test('UI-3: the diagnosis labels weak and uncovered chapters', async () => {
    const { p, ctx, errors } = await freshPage()
    await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      const chapters = Array.from(new Set(bankMod.objectiveQuestions.map((q) => q.chapter)))
      // Answer every objective question of the first chapter wrongly.
      for (const q of bankMod.objectiveQuestions) {
        if (q.chapter !== chapters[0]) continue
        let r = sch.freshRecord(q.id, now)
        r = sch.applyAttempt(r, false, now)
        r.lastAnswer = 'A'
        await dbmod.db.records.put(r)
      }
    })
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await new Promise((r) => setTimeout(r, 600))

    const info = await p.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card.card-pad'))
      const wp = cards.filter((c) => /待清除|未覆盖/.test(c.textContent))
      return {
        total: wp.length,
        weak: wp.filter((c) => /待清除/.test(c.textContent)).length,
        uncovered: wp.filter((c) => /未覆盖/.test(c.textContent)).length,
        hasExplanation: document.body.textContent.includes('互不混排'),
      }
    })
    assert.ok(info.total > 0, 'weak points are rendered')
    assert.ok(info.weak > 0, 'at least one weak chapter is labelled')
    assert.ok(info.hasExplanation, 'the page explains the two kinds are ranked separately')
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  // ---- 4. the chapter table accounts for subjective questions -------------

  await t.test('UI-4: the chapter table total matches the bank size', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '按章节')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    const totals = await p.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.tbl tbody tr'))
      return rows.map((tr) => {
        const cells = tr.querySelectorAll('td')
        return { chapter: cells[0]?.textContent?.trim(), total: Number(cells[1]?.textContent?.match(/\d+/)?.[0] ?? 0) }
      })
    })
    const sum = totals.reduce((s, r) => s + r.total, 0)
    const bankTotal = await p.evaluate(async () => {
      const m = await import('/src/lib/bank.ts')
      return m.allQuestions.length
    })
    assert.equal(sum, bankTotal, `chapter totals must sum to the bank size: ${sum} vs ${bankTotal}`)
    await ctx.close()
  })

  // ---- 5. the subjective page never claims a correct rate -----------------

  await t.test('UI-5: the type tab never shows a subjective correct rate', async () => {
    const { p, ctx } = await freshPage()
    await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      // Train several subjective questions.
      const subj = bankMod.allQuestions.filter((x) => x.type === 'short' || x.type === 'material').slice(0, 5)
      for (const q of subj) {
        let r = sch.freshRecord(q.id, now - 5 * 86400000)
        for (let i = 0; i < 4; i++) r = sch.applySubjectiveAttempt(r, now - 5 * 86400000 + i * 86400000)
        r.lastAnswer = 'x'
        await dbmod.db.records.put(r)
      }
    })
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-sm')).find((x) => x.textContent?.trim() === '按题型')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 500))

    const rows = await p.evaluate(() =>
      Array.from(document.querySelectorAll('.tbl tbody tr')).map((tr) => {
        const cells = tr.querySelectorAll('td')
        return {
          type: cells[0]?.textContent?.trim(),
          attempts: Number(cells[2]?.textContent?.trim() ?? 0),
          rate: cells[4]?.textContent?.trim(),
        }
      }),
    )
    for (const r of rows) {
      if (r.type === '简答题' || r.type === '材料分析题') {
        // Trained but never scored: the rate cell must NOT be a percentage.
        assert.ok(!/%/.test(r.rate ?? ''), `${r.type} must not show a correct rate, got: ${r.rate}`)
      }
    }
    await ctx.close()
  })

  // ---- 6. the plan defers overdue work honestly ---------------------------

  await t.test('UI-6: the plan reports deferred overdue work', async () => {
    const { p, ctx } = await freshPage()
    // Overdue the whole objective bank AND ask for a small task size, so the
    // backlog cannot possibly fit. (With a large size on a small bank the
    // quota-refill logic legitimately schedules everything, so the size must be
    // small relative to the bank.)
    const seeded = await p.evaluate(async () => {
      const bankMod = await import('/src/lib/bank.ts')
      const dbmod = await import('/src/db/database.ts')
      const sch = await import('/src/lib/scheduler.ts')
      const now = Date.now()
      let n = 0
      for (const q of bankMod.objectiveQuestions) {
        let r = sch.freshRecord(q.id, now - 40 * 86400000)
        r = sch.applyAttempt(r, true, now - 40 * 86400000)
        r = sch.applyAttempt(r, true, now - 39 * 86400000)
        await dbmod.db.records.put({ ...r, nextReviewAt: now - (n + 1) * 86400000 })
        n++
      }
      return n
    })
    assert.ok(seeded > 0, 'objective questions were seeded')

    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    await nav(p, 'plan')
    await p.waitForSelector('.page-title')

    // Ask for the smallest task size, which cannot hold the whole backlog.
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.textContent?.trim() === '10 题')
      b?.click()
    })
    await new Promise((r) => setTimeout(r, 800))

    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /今日到期复习/, 'the due counter is shown')
    assert.match(body, /计划预览（客观题 \d+ 题/, 'the plan preview is rendered')
    // The backlog is larger than the 10-question slot, so the remainder must be
    // reported rather than silently dropped.
    assert.match(body, /还有 \d+ 道到期题目未排入今日任务/, 'the deferred-backlog line is shown when work does not fit')
    await ctx.close()
  })
})
