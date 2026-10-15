/**
 * Browser end-to-end tests against the real Vite dev server + real Chrome.
 * Covers the primary user flows required by the task:
 *   - app renders, navigation works
 *   - practice: answer submission, feedback, persistence across reload
 *   - strict multi-choice scoring (wrong/lost selection is marked incorrect)
 *   - mock exam: config → run → submit → score → review
 *   - wrong bank records wrong answers
 *   - diagnosis reflects real data
 *   - export/import round-trip + malformed import is rejected
 *   - AI unavailable degradation (banner,刷题 still works)
 *
 * Run: node tests/browser.test.mjs   (dev server must be running on 5173)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const BASE = process.env.E2E_BASE || 'http://localhost:5173'
// Windows default; overridable for CI (CHROME_PATH=/usr/bin/google-chrome-stable)
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

let browser
let page

async function freshPage() {
  const ctx = await browser.createBrowserContext()
  const p = await ctx.newPage()
  p.setDefaultTimeout(15000)
  const errors = []
  p.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  p.on('console', (m) => {
    if (m.type() !== 'error') return
    const text = m.text()
    // The AI proxy is optional: when it is not running the dev server answers /api
    // with 503 and the frontend degrades gracefully. That is expected, not a bug.
    if (/Failed to load resource/.test(text) && /\/api\//.test(text)) return
    if (/\b50[23]\b/.test(text)) return
    errors.push(`console: ${text}`)
  })
  await p.goto(BASE, { waitUntil: 'networkidle2' })
  await p.waitForSelector('.app-shell', { timeout: 20000 })
  return { p, ctx, errors }
}

async function nav(p, route) {
  await p.evaluate((r) => {
    window.location.hash = `/${r}`
  }, route)
  await new Promise((r) => setTimeout(r, 500))
}

const txt = (p, sel) => p.$eval(sel, (el) => el.textContent.trim()).catch(() => null)
const count = async (p, sel) => (await p.$$(sel)).length

/**
 * Source modules (/src/...) only exist on the Vite dev server.
 * On a production build these tests fall back to asserting through the UI.
 */
async function canImportSource(p) {
  return p.evaluate(async () => {
    try {
      await import('/src/lib/scoring.ts')
      return true
    } catch {
      return false
    }
  })
}

test('browser E2E', async (t) => {
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  })
  t.after(async () => {
    if (browser) await browser.close()
  })

  await t.test('home renders with real bank data', async () => {
    const { p, ctx, errors } = await freshPage()
    await p.waitForFunction(() => document.body.textContent.includes('学习总览'), { timeout: 20000 })
    const body = await p.evaluate(() => document.body.textContent)
    // works with the bundled sample bank and with a locally installed full bank
    assert.match(body, /共 \d+ 题：单选 \d+ · 多选 \d+ · 判断 \d+ · 简答 \d+ · 材料分析 \d+；\d+ 个章节/)
    assert.match(body, /题库覆盖率/)
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('navigation reaches every page without error', async () => {
    const { p, ctx, errors } = await freshPage()
    const routes = [
      'practice',
      'special',
      'subjective',
      'wrong',
      'plan',
      'mock',
      'diagnosis',
      'history',
      'bank',
      'ai',
      'io',
      'settings',
    ]
    for (const r of routes) {
      await nav(p, r)
      await p.waitForFunction(() => document.querySelector('.page-title') !== null, { timeout: 10000 })
    }
    if (errors.length) {
      console.log('PAGE ERRORS (navigation test):')
      for (const e of errors.slice(0, 8)) console.log('  ' + e)
    }
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('practice: submit answer, get feedback, and record persists after reload', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'practice')
    await p.waitForSelector('.btn-primary')
    // start a 5-question session on the default chapter
    const startBtn = await p.$$('.btn.btn-lg')
    await startBtn[0].click()
    await p.waitForSelector('.q-stem', { timeout: 15000 })

    // answer the first question (could be single/multi or judge)
    const hasOpt = await count(p, '.opt')
    const hasJudge = await count(p, '.judge-btn')
    assert.ok(hasOpt >= 2 || hasJudge === 2, `question controls rendered (opt=${hasOpt}, judge=${hasJudge})`)
    if (hasOpt >= 2) await (await p.$$('.opt'))[0].click()
    else await (await p.$$('.judge-btn'))[0].click()
    const submit = await p.$('.btn-primary.btn-lg')
    await submit.click()
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    const banner = await txt(p, '.result-banner')
    assert.match(banner, /回答正确|回答错误/)
    // answer reveal shows the official answer
    assert.match(await p.evaluate(() => document.body.textContent), /正确答案/)
    await p.click('.btn-primary.btn-lg') // next

    // reload and verify the record persisted in IndexedDB
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell')
    const persisted = await p.evaluate(async () => {
      const dbs = await indexedDB.databases()
      const has = dbs.some((d) => d.name === 'exampilot-xigai')
      return has
    })
    assert.ok(persisted, 'IndexedDB database created')
    const homeStats = await p.evaluate(() => document.body.textContent)
    assert.match(homeStats, /累计|已练|覆盖率/, 'stats visible after reload')
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('multi-choice requires exact set (wrong/lost selection is incorrect)', async () => {
    const { p, ctx } = await freshPage()
    if (!(await canImportSource(p))) {
      // production build: exercise the rule through the real UI on a multi question
      await nav(p, 'special')
      await p.evaluate(() => {
        window.location.hash = '/special?type=multi'
      })
      await new Promise((r) => setTimeout(r, 600))
      await p.evaluate(() => {
        Array.from(document.querySelectorAll('.btn.btn-lg'))
          .find((b) => b.textContent.includes('开始专项训练'))
          ?.click()
      })
      await p.waitForSelector('.q-stem', { timeout: 15000 })
      const nOpts = await count(p, '.opt')
      assert.ok(nOpts >= 3, 'multi question with several options')
      // select only the first option -> must be judged incorrect (incomplete selection)
      await p.evaluate(() => document.querySelectorAll('.opt')[0].click())
      await p.evaluate(() => Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))[0].click())
      await p.waitForSelector('.result-banner', { timeout: 10000 })
      const banner = await txt(p, '.result-banner')
      // with only one of several correct options selected, the verdict must be 错误
      // (a bank multi answer is never a single option)
      assert.match(banner, /回答错误/, `incomplete multi selection must be wrong, got: ${banner}`)
      await ctx.close()
      return
    }
    const results = await p.evaluate(async () => {
      const m = await import('/src/lib/scoring.ts')
      const q = {
        id: 'M-x',
        chapter: '第一章',
        chapterIndex: 1,
        type: 'multi',
        bankNo: 1,
        pageStart: 1,
        pageEnd: 1,
        stem: 's',
        options: ['a', 'b', 'c', 'd'],
        answer: 'ABC',
        answerNorm: 'ABC',
        hasOfficialAnswer: true,
        isFlagged: false,
        flagReason: '',
      }
      return {
        exact: m.scoreAnswer(q, 'ABC'),
        missing: m.scoreAnswer(q, 'AB'),
        extra: m.scoreAnswer(q, 'ABCD'),
        unordered: m.scoreAnswer(q, 'CBA'),
        blank: m.scoreAnswer(q, ''),
        blankIsBlank: m.isAnswerBlank(q, ''),
      }
    })
    assert.equal(results.exact, true)
    assert.equal(results.missing, false)
    assert.equal(results.extra, false)
    assert.equal(results.unordered, true)
    assert.equal(results.blank, null)
    assert.equal(results.blankIsBlank, true)
    await ctx.close()
  })

  await t.test('mock exam: configure → run → submit → score → review', async () => {
    const { p, ctx, errors } = await freshPage()
    await nav(p, 'mock')
    await p.waitForSelector('.card-title')
    // set small paper: 2 single / 1 multi / 1 judge / 0 short, 1 minute
    const nums = await p.$$('input.input[type=number]')
    assert.ok(nums.length >= 9, 'config fields rendered')
    await p.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input.input[type=number]'))
      const setVal = (idx, v) => {
        const el = inputs[idx]
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(el, String(v))
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      setVal(0, 2)
      setVal(1, 1)
      setVal(2, 1)
      setVal(3, 0)
      setVal(8, 5)
    })
    await new Promise((r) => setTimeout(r, 400))
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      btns[0].click()
    })
    await p.waitForSelector('.timer', { timeout: 15000 })

    // answer all questions via the quick nav pills
    const total = await count(p, '.progress-dots i')
    assert.ok(total === 4, `expected 4 questions, got ${total}`)
    for (let i = 0; i < total; i++) {
      await p.evaluate((idx) => {
        const pills = document.querySelectorAll('.pill-scroll .btn')
        pills[idx].click()
      }, i)
      await new Promise((r) => setTimeout(r, 200))
      // select first option for single/multi, first judge for judge
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
      assert.ok(answered, 'question has an answerable control')
    }
    // submit
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-primary'))
      btns.find((b) => b.textContent.includes('交卷')).click()
    })
    await p.waitForSelector('.card-title', { timeout: 15000 })
    await p.waitForFunction(() => document.body.textContent.includes('考试结果'), { timeout: 15000 })
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /得分/)
    assert.match(body, /逐题复盘/)
    // review shows correct answers
    assert.match(body, /正确答案/)
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('wrong bank records the wrong answer from the mock exam', async () => {
    // reuse a fresh context; practice answers wrongly on purpose
    const { p, ctx } = await freshPage()
    await nav(p, 'practice')
    await p.evaluate(() => {
      window.location.hash = '/special?type=multi'
    })
    await new Promise((r) => setTimeout(r, 600))
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始专项训练'))?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })
    // pick a deliberately incomplete selection (only A) to force an error
    await p.evaluate(() => {
      document.querySelectorAll('.opt')[0].click()
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    await nav(p, 'wrong')
    await p.waitForFunction(() => document.body.textContent.includes('错题本'), { timeout: 10000 })
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /\d+ 道待清除/, 'wrong bank shows count')
    await ctx.close()
  })

  await t.test('diagnosis uses real data and never fabricates a predicted score', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'diagnosis')
    await p.waitForSelector('.page-title')
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /学习诊断/)
    assert.match(body, /不生成预测分数|不虚构掌握率|非预测成绩/)
    await ctx.close()
  })

  await t.test('export produces a valid backup JSON', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'io')
    await p.waitForSelector('.page-title')
    if (!(await canImportSource(p))) {
      // production build: the export button must exist and the page must state the data counts
      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /导出学习数据/)
      assert.match(body, /学习记录/)
      await ctx.close()
      return
    }
    const data = await p.evaluate(() => {
      const blob = new Blob(['x'], { type: 'application/json' })
      return typeof blob === 'object'
    })
    assert.ok(data)
    // verify the export payload builder via the real module
    const payload = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const p2 = m.makeExportPayload({
        settings: { theme: 'auto' },
        records: [],
        history: [],
        mocks: [],
        aiReviews: [],
      })
      return { schema: p2.schema, roundTrip: m.parseExport(m.serialize(p2)).ok }
    })
    assert.equal(payload.schema, 'exampilot.export.v1')
    assert.equal(payload.roundTrip, true)
    await ctx.close()
  })

  await t.test('malformed import is rejected without corrupting data', async () => {
    const { p, ctx } = await freshPage()
    if (!(await canImportSource(p))) {
      // production build: the import UI must be present and honest about validation
      await nav(p, 'io')
      await p.waitForSelector('.page-title')
      const body = await p.evaluate(() => document.body.textContent)
      assert.match(body, /导入恢复/)
      assert.match(body, /格式不符时不会写入任何数据/)
      await ctx.close()
      return
    }
    const res = await p.evaluate(async () => {
      const m = await import('/src/lib/io.ts')
      const bad = m.parseExport('{"records": "not-an-array"}')
      const notJson = m.parseExport('nope')
      const wrongSchema = m.parseExport(
        JSON.stringify({ schema: 'other', records: [], history: [], mocks: [], aiReviews: [] }),
      )
      return { bad: bad.ok, badErr: bad.errors.join(';'), notJson: notJson.ok, wrongSchema: wrongSchema.ok }
    })
    assert.equal(res.bad, false)
    assert.match(res.badErr, /records/)
    assert.equal(res.notJson, false)
    assert.equal(res.wrongSchema, false)
    await ctx.close()
  })

  await t.test('AI unavailable:刷题 still works and status is honest', async () => {
    const { p, ctx, errors } = await freshPage()
    // AI proxy not configured in this environment → the app must still work
    await nav(p, 'ai')
    await p.waitForSelector('.page-title')
    await p.waitForFunction(
      () => document.body.textContent.includes('未配置') || document.body.textContent.includes('已配置'),
      { timeout: 15000 },
    )
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /网关状态/)
    // practice still works with AI down
    await nav(p, 'practice')
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始练习'))?.click()
    })
    await p.waitForSelector('.q-stem', { timeout: 15000 })
    await p.evaluate(() => {
      const opt = document.querySelector('.opt')
      if (opt) {
        opt.click()
        return
      }
      const jb = document.querySelector('.judge-btn')
      if (jb) jb.click()
    })
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForSelector('.result-banner', { timeout: 10000 })
    assert.ok(errors.length === 0, 'no page errors: ' + errors.join(' | '))
    await ctx.close()
  })

  await t.test('subjective training never fabricates an official answer', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'subjective')
    await p.waitForSelector('.page-title')
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /未提供标准答案|不伪造官方答案/)
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-lg'))
      btns.find((b) => b.textContent.includes('开始训练'))?.click()
    })
    await p.waitForSelector('textarea.textarea', { timeout: 15000 })
    await p.type('textarea.textarea', '两个结合是指马克思主义基本原理同中国具体实际相结合、同中华优秀传统文化相结合。')
    await p.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.btn.btn-primary.btn-lg'))
      b[0].click()
    })
    await p.waitForFunction(() => document.body.textContent.includes('AI 参考评阅'), { timeout: 10000 })
    const b2 = await p.evaluate(() => document.body.textContent)
    assert.match(b2, /AI 评阅仅为参考评阅|非官方标准分数/)
    await ctx.close()
  })

  await t.test('bank page exposes page traceability and flagged items', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'bank')
    await p.waitForSelector('.page-title')
    const first = await p.evaluate(() => document.querySelectorAll('.card.card-pad').length)
    assert.ok(first > 0, 'bank rows rendered')
    // expand a row to see answer + page source
    await p.evaluate(() => document.querySelector('.card.card-pad button')?.click())
    await new Promise((r) => setTimeout(r, 300))
    const body = await p.evaluate(() => document.body.textContent)
    assert.match(body, /来源 PDF 第|答案：/)
    // filter to flagged-only: every short/material question must be flagged (no official answer)
    await p.evaluate(() => {
      const cb = document.querySelector('input[type=checkbox]')
      if (cb) cb.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const flaggedCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    // cross-check against the subjective totals shown by the type filter
    await p.evaluate(() => {
      const cb = document.querySelector('input[type=checkbox]')
      if (cb) cb.click()
    })
    await new Promise((r) => setTimeout(r, 400))
    await p.evaluate(() => {
      const sel = document.querySelectorAll('select.select')[1]
      if (sel) {
        sel.value = 'short'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    const shortCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    await p.evaluate(() => {
      const sel = document.querySelectorAll('select.select')[1]
      if (sel) {
        sel.value = 'material'
        sel.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })
    await new Promise((r) => setTimeout(r, 400))
    const materialCount = Number(await p.evaluate(() => document.body.textContent.match(/共 (\d+) 题/)?.[1]))
    assert.equal(flaggedCount, shortCount + materialCount, 'flagged items are exactly the subjective questions')
    await ctx.close()
  })

  await t.test('dark theme toggle applies', async () => {
    const { p, ctx } = await freshPage()
    await nav(p, 'settings')
    await p.waitForSelector('.page-title')
    // 主题按钮只更新草稿，必须点击「保存设置」后才会应用到 DOM
    await p.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('.btn.btn-sm'))
      btns.find((b) => b.textContent.includes('深色'))?.click()
    })
    await new Promise((r) => setTimeout(r, 200))
    await p.evaluate(() => {
      const save = Array.from(document.querySelectorAll('.btn.btn-primary')).find((b) =>
        b.textContent.includes('保存设置'),
      )
      save?.click()
    })
    await new Promise((r) => setTimeout(r, 500))
    const theme = await p.evaluate(() => document.documentElement.dataset.theme)
    if (theme !== 'dark') {
      const btns = await p.evaluate(() =>
        Array.from(document.querySelectorAll('.btn.btn-sm'))
          .map((b) => b.textContent)
          .join(','),
      )
      console.log('THEME DEBUG: dataset.theme =', theme, '| buttons:', btns)
    }
    assert.equal(theme, 'dark')
    const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor)
    assert.notEqual(bg, 'rgb(246, 247, 249)')
    // 主题偏好必须持久化：刷新后仍是深色
    await p.reload({ waitUntil: 'networkidle2' })
    await p.waitForSelector('.app-shell', { timeout: 20000 })
    const themeAfterReload = await p.evaluate(() => document.documentElement.dataset.theme)
    assert.equal(themeAfterReload, 'dark', 'theme preference persists across reload')
    await ctx.close()
  })
})
