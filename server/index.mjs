#!/usr/bin/env node
/**
 * ExamPilot AI proxy server (no external dependencies).
 * Keeps the Sub2API key server-side. OpenAI-compatible /chat/completions protocol.
 *
 * Endpoints:
 *   GET  /api/ai/status
 *   POST /api/ai/qa     { question, userAnswer, questionContext }
 *   POST /api/ai/grade  { qid, stem, userAnswer, chapter, kind }
 *   POST /api/ai/config { baseUrl, apiKey, model, timeoutMs }   (local only, see ALLOW_CONFIG_WRITE)
 *
 * Never fabricates AI availability: when unconfigured it returns ok:false.
 *
 * Security boundary:
 *   - Binds to loopback only. A non-loopback AI_HOST is REFUSED at startup
 *     unless AI_ALLOW_REMOTE=1 is explicitly set, because the config endpoint
 *     has no user authentication and would otherwise be reachable from the LAN.
 *   - Even with AI_ALLOW_REMOTE=1, config writes additionally require
 *     AI_CONFIG_TOKEN (header `x-exampilot-config-token`), so the endpoint is
 *     never remotely writable without a shared secret.
 *   - CORS allows only the local dev/preview origins, not `*`.
 *   - The API key is never returned to the browser and never logged.
 *   - /api/ai/config requires a loopback peer plus a trusted local Origin.
 */
import http from 'node:http'
import { loadAiConfig, saveAiConfig, isConfigured } from './config.mjs'

const PORT = Number(process.env.AI_PORT || 8787)
const REQUESTED_HOST = process.env.AI_HOST || '127.0.0.1'
const ALLOW_REMOTE = process.env.AI_ALLOW_REMOTE === '1'
const CONFIG_TOKEN = process.env.AI_CONFIG_TOKEN || ''

/** True for loopback addresses (IPv4/IPv6, including IPv4-mapped forms). */
function isLoopbackAddress(addr) {
  if (!addr) return false
  const a = String(addr).replace(/^::ffff:/i, '')
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || a.startsWith('127.')
}

function isLoopbackHost(host) {
  return isLoopbackAddress(host)
}

// Refuse to expose the unauthenticated proxy on a network interface by accident.
if (!isLoopbackHost(REQUESTED_HOST) && !ALLOW_REMOTE) {
  console.error(
    `[ExamPilot AI proxy] 拒绝启动：AI_HOST=${REQUESTED_HOST} 不是回环地址。\n` +
      '  该代理没有用户身份认证，绑定到非回环地址会把 AI 配置接口暴露到网络。\n' +
      '  如确需远程访问，请显式设置 AI_ALLOW_REMOTE=1，并设置 AI_CONFIG_TOKEN 作为配置写入的共享密钥。',
  )
  process.exit(1)
}
if (!isLoopbackHost(REQUESTED_HOST) && ALLOW_REMOTE && !CONFIG_TOKEN) {
  console.error(
    '[ExamPilot AI proxy] 拒绝启动：AI_ALLOW_REMOTE=1 时必须同时设置 AI_CONFIG_TOKEN，' +
      '否则配置接口将在无认证的情况下可被远程写入。',
  )
  process.exit(1)
}

const HOST = REQUESTED_HOST
const cfg = await loadAiConfig()

// Origins permitted to call this proxy. Vite dev/preview ports only.
const ALLOWED_ORIGINS = new Set([
  `http://localhost:5173`,
  `http://127.0.0.1:5173`,
  `http://localhost:4173`,
  `http://127.0.0.1:4173`,
])

const DISCLAIMER = '本评阅由 AI 生成，仅作参考评阅，非官方标准答案或分数；请以题库原答案和课堂讲授为准。'

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    // Never expose the key or config to the browser
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** True when the request comes from an allowed local origin (or has no Origin). */
function isTrustedOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true // curl / direct local request
  return ALLOWED_ORIGINS.has(origin)
}

function applyCors(req, res) {
  const origin = req.headers.origin
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
}

/**
 * Config writes are allowed only for a loopback TCP peer with a trusted origin —
 * plus, when a shared token is configured, a matching token. This holds even if
 * the operator deliberately bound to a network interface.
 */
function mayWriteConfig(req) {
  const peer = req.socket?.remoteAddress
  if (CONFIG_TOKEN) {
    return req.headers['x-exampilot-config-token'] === CONFIG_TOKEN
  }
  return isLoopbackAddress(peer) && isTrustedOrigin(req)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

/** Call the gateway with an OpenAI-compatible chat/completions request. */
async function callGateway(messages, signal) {
  const c = await loadAiConfig()
  if (!isConfigured(c)) {
    const err = new Error('AI 网关未配置（缺少 baseUrl/apiKey/model）')
    err.code = 'NOT_CONFIGURED'
    throw err
  }
  const url = c.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), c.timeoutMs)
  if (signal) signal.addEventListener('abort', () => ctrl.abort(new Error('client-abort')))
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${c.apiKey}`,
      },
      body: JSON.stringify({
        model: c.model,
        messages,
        temperature: 0.3,
        max_tokens: c.maxTokens,
      }),
      signal: ctrl.signal,
    })
    const text = await res.text()
    if (!res.ok) {
      const err = new Error(`网关返回 ${res.status}: ${text.slice(0, 300)}`)
      err.code = 'GATEWAY_ERROR'
      throw err
    }
    let data
    try {
      data = JSON.parse(text)
    } catch {
      const err = new Error(`网关响应不是合法 JSON: ${text.slice(0, 120)}`)
      err.code = 'BAD_RESPONSE'
      throw err
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      const err = new Error('网关响应缺少 choices[0].message.content')
      err.code = 'BAD_RESPONSE'
      throw err
    }
    return { content, provider: data.provider || 'sub2api', model: data.model || c.model }
  } catch (e) {
    // Node may reject with the abort reason itself, an AbortError, or a wrapped TypeError
    const root = e?.cause?.name === 'AbortError' ? e.cause : e
    const isAbort = root?.name === 'AbortError' || root?.name === 'Error' || e?.name === 'AbortError'
    const reasonMsg = String(root?.message || e?.message || '')
    if (isAbort && reasonMsg === 'timeout') {
      const err = new Error(`AI 请求超时（>${c.timeoutMs}ms），请重试或缩短题目长度`)
      err.code = 'TIMEOUT'
      throw err
    }
    if (root?.name === 'AbortError' || e?.name === 'AbortError') {
      const err = new Error('客户端已断开连接')
      err.code = 'CLIENT_ABORT'
      throw err
    }
    if (e?.name === 'TypeError' && /fetch failed/i.test(String(e.message || ''))) {
      const err = new Error(`无法连接 AI 网关（${c.baseUrl}）：${e.cause?.message || e.message}`)
      err.code = 'CONNECT_ERROR'
      throw err
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}

function buildQaPrompt(body) {
  const q = body.question || {}
  const ctx = body.questionContext || {}
  const opts = Array.isArray(q.options)
    ? q.options.map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o}`).join('\n')
    : ''
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》课程助教。请基于题库与教材知识，用简体中文回答学生的题目疑问。' +
        '要求：1) 明确指出正确答案及判定依据；2) 解释每个选项对或错的原因；3) 若学生答错，指出其错误原因；4) 语言简洁，分点作答。',
    },
    {
      role: 'user',
      content:
        `章节：${ctx.chapter || '未知'}，题号：${ctx.bankNo ?? '未知'}，题型：${q.type || '未知'}\n` +
        `题干：${q.stem || ''}\n` +
        (opts ? `选项：\n${opts}\n` : '') +
        (q.answer ? `题库答案：${q.answer}\n` : '') +
        `学生的作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

function buildGradePrompt(body) {
  return [
    {
      role: 'system',
      content:
        '你是《习近平新时代中国特色社会主义思想概论》阅卷助教，请对学生的简答题/材料分析题作答进行参考性评阅。' +
        '请严格输出 JSON，不要输出任何多余文字，JSON 结构如下：\n' +
        '{"score": 0-100 的整数, "hitPoints": ["命中的采分点"], "missedPoints": ["遗漏的内容"], "deductions": ["扣分依据"], "suggestions": ["修改建议"], "structureNote": "答题结构点评"}\n' +
        '评分必须基于题干要求、核心概念、采分点与材料联系；不得凭空给出标准答案之外的内容。',
    },
    {
      role: 'user',
      content:
        `章节：${body.chapter || '未知'}，题型：${body.kind === 'short' ? '简答题' : '材料分析论述题'}\n` +
        `题干：${body.stem || ''}\n` +
        `学生作答：${body.userAnswer || '（未作答）'}`,
    },
  ]
}

/** Extract JSON from a possibly prose-wrapped model response. */
function extractJson(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Validate a grade result strictly. A missing or malformed field is a FAILURE,
 * not a zero — we must never report `ok:true` with a fabricated score.
 * Returns { ok: true, result } or { ok: false, reason }.
 */
function validateGrade(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'AI 返回的评阅结果不是 JSON 对象' }
  }
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) {
    return { ok: false, reason: 'AI 评阅结果缺少有效的 score 字段（数字）' }
  }
  if (raw.score < 0 || raw.score > 100) {
    return { ok: false, reason: `AI 评阅 score 超出 0-100 范围：${raw.score}` }
  }
  for (const field of ['hitPoints', 'missedPoints', 'deductions', 'suggestions']) {
    if (!Array.isArray(raw[field])) {
      return { ok: false, reason: `AI 评阅结果缺少 ${field} 数组字段` }
    }
    if (raw[field].some((x) => typeof x !== 'string')) {
      return { ok: false, reason: `AI 评阅结果 ${field} 含非字符串元素` }
    }
  }
  if (typeof raw.structureNote !== 'string') {
    return { ok: false, reason: 'AI 评阅结果缺少 structureNote 字符串字段' }
  }
  return {
    ok: true,
    result: {
      score: Math.round(raw.score),
      maxScore: 100,
      hitPoints: raw.hitPoints.filter((s) => s.trim()),
      missedPoints: raw.missedPoints.filter((s) => s.trim()),
      deductions: raw.deductions.filter((s) => s.trim()),
      suggestions: raw.suggestions.filter((s) => s.trim()),
      structureNote: raw.structureNote,
      disclaimer: DISCLAIMER,
    },
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  applyCors(req, res)
  if (req.method === 'OPTIONS') {
    // Only echo CORS headers for trusted origins; otherwise a bare 204.
    if (req.headers.origin && !ALLOWED_ORIGINS.has(req.headers.origin)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, message: 'Origin not allowed' }))
    }
    res.writeHead(204)
    return res.end()
  }

  if (req.method === 'GET' && url.pathname === '/api/ai/status') {
    const c = await loadAiConfig()
    const configured = isConfigured(c)
    return send(res, 200, {
      ok: configured,
      configured,
      provider: 'sub2api',
      model: c.model || '',
      message: configured
        ? `AI 网关已配置（model=${c.model}）`
        : 'AI 网关未配置：请在 server/ai-config.json 或环境变量 AI_BASE_URL/AI_API_KEY/AI_MODEL 中设置。',
    })
  }

  if (req.method === 'POST' && url.pathname === '/api/ai/config') {
    // Config writes require a loopback peer with a trusted origin, or the
    // configured shared token when one was set.
    if (!mayWriteConfig(req)) {
      return send(res, 403, {
        ok: false,
        message: '配置写入仅允许来自本机的受信任来源（配置了共享密钥时需提供 x-exampilot-config-token）',
      })
    }
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const saved = await saveAiConfig({
        baseUrl: String(body.baseUrl || ''),
        apiKey: String(body.apiKey || ''),
        model: String(body.model || ''),
        timeoutMs: Number(body.timeoutMs) || 60000,
      })
      return send(res, 200, {
        ok: true,
        configured: isConfigured(saved),
        model: saved.model,
        message: isConfigured(saved) ? '配置已保存' : '配置已保存，但尚未填写完整',
      })
    } catch (e) {
      return send(res, 400, { ok: false, message: String(e.message || e) })
    }
  }

  if (req.method === 'POST' && (url.pathname === '/api/ai/qa' || url.pathname === '/api/ai/grade')) {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      const messages = url.pathname === '/api/ai/qa' ? buildQaPrompt(body) : buildGradePrompt(body)
      const ac = new AbortController()
      req.on('close', () => ac.abort())
      const { content, provider, model } = await callGateway(messages, ac.signal)
      if (url.pathname === '/api/ai/qa') {
        return send(res, 200, { ok: true, answer: content, provider, model })
      }
      const raw = extractJson(content)
      if (!raw) {
        // Explicit failure — never fabricate a 0-score "successful" review
        return send(res, 200, {
          ok: false,
          reason: 'AI 未返回可解析的 JSON 评阅结果，本次评阅失败（未给出参考分）',
          code: 'BAD_GRADE_FORMAT',
        })
      }
      const v = validateGrade(raw)
      if (!v.ok) {
        return send(res, 200, { ok: false, reason: v.reason, code: 'BAD_GRADE_FORMAT' })
      }
      return send(res, 200, { ok: true, result: v.result, provider, model })
    } catch (e) {
      const code = e.code || ''
      // Degrade gracefully: all failures surface as ok:false + reason, never a fabricated answer
      const status = code === 'NOT_CONFIGURED' ? 200 : code === 'TIMEOUT' || code === 'CLIENT_ABORT' ? 200 : 502
      return send(res, status, { ok: false, reason: e.message || String(e), code })
    }
  }

  send(res, 404, { ok: false, message: 'Not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`[ExamPilot AI proxy] listening on http://${HOST}:${PORT}`)
  console.log(`[ExamPilot AI proxy] configured=${isConfigured(cfg)} model=${cfg.model || '(unset)'}`)
  if (!isLoopbackHost(HOST)) {
    console.warn(
      `[ExamPilot AI proxy] 警告：已绑定非回环地址 ${HOST}（AI_ALLOW_REMOTE=1）。` +
        '配置写入需要 AI_CONFIG_TOKEN。请确保仅在可信网络中运行。',
    )
  }
  if (!isConfigured(cfg)) {
    console.log('[ExamPilot AI proxy] 提示：AI 网关未配置；刷题、评分与本地记录不受影响。')
  }
})
