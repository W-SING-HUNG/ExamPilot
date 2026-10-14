/**
 * AI proxy contract tests (node:test).
 * Covers: unconfigured, gateway HTTP error, success (QA), success (grade JSON),
 * malformed JSON, timeout, CORS, 404.
 * Run: node tests/ai-proxy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PROXY_PORT = 8791
const BASE = `http://127.0.0.1:${PROXY_PORT}`

let proxy

async function startProxy(env = {}) {
  proxy = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
    env: { ...process.env, AI_PORT: String(PROXY_PORT), AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  proxy.stdout.on('data', (d) => {
    log += d
  })
  proxy.stderr.on('data', (d) => {
    log += d
  })
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/ai/status`)
      if (r.ok) return log
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('proxy did not start: ' + log)
}

const stopProxy = () => proxy && proxy.kill('SIGTERM')

/** Start a stub gateway with a scripted response. */
async function startStub(port, script) {
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    const http = require('http')
    const httpPort = ${port}
    http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        globalThis.__lastRequest = { url: req.url, method: req.method, headers: req.headers, body }
        ;(${script})(req, res)
      })
    }).listen(httpPort, '127.0.0.1', () => console.log('stub-ready'))
  `,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  )
  for (let i = 0; i < 40; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/chat/completions`, { method: 'POST', body: '{}' })
      break
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  return child
}

const OK_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: '答案是 B，因为……' } }], model: 'stub-model', provider: 'stub' }))
}`

const GRADE_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ score: 82, hitPoints: ['概念准确'], missedPoints: ['缺少材料联系'], deductions: ['结构不完整'], suggestions: ['补充分点'], structureNote: '总体清晰' }) } }] }))
}`

const ERROR_SCRIPT = `(req, res) => {
  res.writeHead(500, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: { message: 'upstream boom' } }))
}`

const SLOW_SCRIPT = `(req, res) => {
  setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content: 'late' } }] })) }, 3000)
}`

const BAD_JSON_SCRIPT = `(req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end('not-json-at-all')
}`

test('AI proxy: unconfigured gateway', async (t) => {
  await startProxy()
  t.after(stopProxy)

  const status = await (await fetch(`${BASE}/api/ai/status`)).json()
  assert.equal(status.configured, false)
  assert.equal(status.ok, false)
  assert.match(status.message, /未配置/)

  const qa = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { type: 'single', stem: '测试', options: ['a', 'b'] }, userAnswer: 'A' }),
  })
  const qaBody = await qa.json()
  assert.equal(qa.status, 200, 'must not 5xx when unconfigured — frontend degrades gracefully')
  assert.equal(qaBody.ok, false)
  assert.match(qaBody.reason, /未配置/)

  const grade = await fetch(`${BASE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qid: 'Q001', stem: 'x', userAnswer: 'y', kind: 'short' }),
  })
  const gradeBody = await grade.json()
  assert.equal(gradeBody.ok, false)

  const nf = await fetch(`${BASE}/nope`)
  assert.equal(nf.status, 404)
  const cors = await fetch(`${BASE}/api/ai/qa`, { method: 'OPTIONS' })
  assert.equal(cors.status, 204)
  assert.match(cors.headers.get('access-control-allow-origin'), /\*/)
})

test('AI proxy: QA success proxies to gateway', async (t) => {
  const stub = await startStub(8792, OK_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8792/v1', AI_API_KEY: 'key-123', AI_MODEL: 'stub-model' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const status = await (await fetch(`${BASE}/api/ai/status`)).json()
  assert.equal(status.configured, true)
  assert.equal(status.model, 'stub-model')

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: { type: 'single', stem: '测试题', options: ['a', 'b'], answer: 'B' },
      userAnswer: 'A',
      questionContext: { chapter: '导论', bankNo: 1 },
    }),
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.match(j.answer, /答案是 B/)
  assert.equal(j.model, 'stub-model')
})

test('AI proxy: grade success returns normalized result with disclaimer', async (t) => {
  const stub = await startStub(8793, GRADE_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8793/v1', AI_API_KEY: 'key-123', AI_MODEL: 'stub-model' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/grade`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      qid: 'Q001',
      stem: '请回答两个结合',
      userAnswer: '两个结合是……',
      chapter: '导论',
      kind: 'short',
    }),
  })
  const j = await r.json()
  assert.equal(r.status, 200)
  assert.equal(j.ok, true)
  assert.equal(j.result.score, 82)
  assert.equal(j.result.maxScore, 100)
  assert.deepEqual(j.result.hitPoints, ['概念准确'])
  assert.deepEqual(j.result.missedPoints, ['缺少材料联系'])
  assert.match(j.result.disclaimer, /参考评阅/)
  assert.match(j.result.disclaimer, /非官方/)
})

test('AI proxy: gateway HTTP 500 -> ok:false, never a fabricated answer', async (t) => {
  const stub = await startStub(8794, ERROR_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8794/v1', AI_API_KEY: 'key-123', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(j.ok, false)
  assert.match(j.reason, /500/)
  assert.equal(j.answer, undefined)
})

test('AI proxy: gateway non-JSON body -> ok:false', async (t) => {
  const stub = await startStub(8795, BAD_JSON_SCRIPT)
  await startProxy({ AI_BASE_URL: 'http://127.0.0.1:8795/v1', AI_API_KEY: 'key-123', AI_MODEL: 'm' })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(j.ok, false)
})

test('AI proxy: timeout -> ok:false with 超时 reason', async (t) => {
  const stub = await startStub(8796, SLOW_SCRIPT)
  await startProxy({
    AI_BASE_URL: 'http://127.0.0.1:8796/v1',
    AI_API_KEY: 'key-123',
    AI_MODEL: 'm',
    AI_TIMEOUT_MS: '800',
  })
  t.after(() => {
    stopProxy()
    stub.kill('SIGTERM')
  })

  const r = await fetch(`${BASE}/api/ai/qa`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question: { stem: 'x' }, userAnswer: '' }),
  })
  const j = await r.json()
  assert.equal(r.status, 200, 'timeout must not be a 5xx')
  assert.equal(j.ok, false)
  assert.match(j.reason, /超时/)
  assert.equal(j.answer, undefined)
})
