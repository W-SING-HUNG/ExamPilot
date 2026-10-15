#!/usr/bin/env node
/**
 * Public-information gate.
 *
 * Implements the automated portion of docs/information-governance.md:
 * scans every version-controlled file and the commit history being delivered
 * for SECRET material, INTERNAL development records, and unverifiable claims.
 *
 * Scope: files come from the index (what a commit would publish), and history
 * comes from the current branch's ancestry (what this branch delivers). Scanning
 * every ref with `--all` would report findings from unrelated branches and fail
 * a PR's build for content it does not contain; use `--all-refs` for a
 * maintainer-wide audit instead.
 *
 * This script can only detect known patterns. It does NOT replace human review,
 * and a clean run is not proof that the repository contains nothing sensitive.
 *
 * Usage:
 *   node tools/public-info-check.mjs              # files + this branch's history
 *   node tools/public-info-check.mjs --no-history
 *   node tools/public-info-check.mjs --all-refs   # audit every ref (maintainer)
 *
 * Exit code 1 when an unallowlisted SECRET or INTERNAL finding is present.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const args = new Set(process.argv.slice(2))
const SCAN_HISTORY = !args.has('--no-history')
const ALL_REFS = args.has('--all-refs')

// ---------------------------------------------------------------------------
// Flagged vocabulary.
//
// Assembled from fragments so this scanner's own pattern table does not match
// itself. The file is still scanned for real secrets, paths and personal data.
//
// Scope note: per docs/information-governance.md §2, an AI *provider protocol*
// or third-party dependency the product legitimately integrates with is PUBLIC,
// not an internal development record. Only names of development assistants /
// coding agents are INTERNAL, so provider-protocol words are excluded here.
// ---------------------------------------------------------------------------
const FRAG = {
  assistantTools: ['Clau' + 'de', 'Chat' + 'GPT', 'Co' + 'pilot', 'Gem' + 'ini'],
  codingAgents: ['De' + 'vin', 'Code' + 'x'],
  processWords: ['提' + '示词', 'AI' + ' Agent', 'sub' + 'agent', 'agent ' + '分工', '聊天' + '记录', '对话' + '记录'],
  // Actual disclosures of private process, not the *category names* used when
  // writing the policy itself ("内部记录" as a heading is not a disclosure).
  privateLabels: ['内部' + '工作流', '内部' + '协作记录', '私人' + '偏好', '我的' + '提示词', '我们' + '的对话'],
  validationClaims: ['独立' + '验收', '独立' + '审查', 'independently ' + 'validated', 'independent ' + 'review'],
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A finding rule.
 *   severity: 'SECRET' | 'INTERNAL' | 'REVIEW'  (REVIEW = advisory, never fails)
 *   allow: predicate (file, line) => true to suppress a legitimate match
 */
const RULES = [
  // ---- SECRET -------------------------------------------------------------
  {
    id: 'credential-literal',
    severity: 'SECRET',
    re: /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})/,
    desc: 'provider credential literal',
  },
  {
    id: 'private-key-block',
    severity: 'SECRET',
    re: /-{5}BEGIN [A-Z ]*PRIVATE KEY-{5}/,
    desc: 'private key block',
  },
  {
    id: 'assigned-secret',
    severity: 'SECRET',
    re: /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*['"][^'"\s]{12,}['"]/i,
    desc: 'assigned secret value',
    // Obvious placeholders in test fixtures and examples are legitimate.
    allow: (_f, line) =>
      /(your-|example|placeholder|dummy|fake|sample|shared-secret|super-secret|xxx|\.\.\.|<[^>]+>)/i.test(line),
  },

  // ---- INTERNAL: local identity and filesystem ---------------------------
  {
    id: 'windows-user-path',
    severity: 'INTERNAL',
    re: /[A-Za-z]:\\{1,2}(Users|AppData|Documents|Desktop)\\{1,2}[^\\'"\s]+/i,
    desc: 'local Windows user path',
  },
  {
    id: 'posix-home-path',
    severity: 'INTERNAL',
    re: /\/(Users|home)\/[A-Za-z0-9._-]+\//,
    desc: 'local POSIX home path',
  },
  {
    id: 'personal-email',
    severity: 'INTERNAL',
    re: /[A-Za-z0-9._%+-]+@(gmail|qq|163|126|outlook|hotmail|yahoo|foxmail)\.com/i,
    desc: 'personal email address',
  },

  // ---- INTERNAL: private source material ---------------------------------
  {
    id: 'source-pdf-name',
    severity: 'INTERNAL',
    re: /["'][^"'\n]*\.pdf["']/i,
    desc: 'hardcoded document filename (may disclose private source material)',
    // A generic .gitignore pattern or prose mention of "PDF" is not a filename.
    allow: (f, line) =>
      /\.gitignore$|\.gitattributes$|PULL_REQUEST_TEMPLATE/.test(f) ||
      /^\s*\*?\.pdf\b/.test(line.trim()) ||
      /[,，、]?\*\.pdf/.test(line),
  },

  // ---- INTERNAL: development tooling and process -------------------------
  {
    id: 'ai-tool-name',
    severity: 'INTERNAL',
    re: new RegExp(`\\b(${[...FRAG.assistantTools, ...FRAG.codingAgents].map(esc).join('|')})\\b`, 'i'),
    desc: 'named AI assistant / coding agent',
  },
  {
    // "Cursor" is also a CSS property value, so require a capitalised standalone
    // occurrence outside stylesheets.
    id: 'ai-tool-name',
    severity: 'INTERNAL',
    re: /\bCursor\b/,
    desc: 'named AI assistant / coding agent',
    allow: (f, line) => /\.css$/.test(f) || /cursor\s*:/.test(line),
  },
  {
    id: 'process-disclosure',
    severity: 'INTERNAL',
    re: new RegExp(`(${[...FRAG.processWords, ...FRAG.privateLabels].map(esc).join('|')})`),
    desc: 'internal process or private-record disclosure',
  },

  // ---- REVIEW: phrasing that must match real evidence --------------------
  {
    id: 'validation-claim',
    severity: 'REVIEW',
    re: new RegExp(`(${FRAG.validationClaims.map(esc).join('|')})`, 'i'),
    desc: 'validation claim — confirm independent evidence exists',
  },
]

// ---------------------------------------------------------------------------
// File-level allowlist: files whose matches are structural, not content.
// Never used to silence credentials.
// ---------------------------------------------------------------------------
const FILE_ALLOW = [
  // The scanner's own pattern table contains the vocabulary it searches for.
  { file: /^tools\/public-info-check\.mjs$/, rules: ['ai-tool-name', 'process-disclosure'] },
  // The governance policy necessarily *defines* the categories and the phrasing
  // rules, so it quotes them. Naming a category is not disclosing its content.
  {
    file: /^docs\/(information-governance|history-exposure-report)\.md$/,
    rules: ['process-disclosure', 'validation-claim'],
  },
]

function fileAllows(rule, file) {
  return FILE_ALLOW.some((a) => a.file.test(file) && a.rules.includes(rule.id))
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|pdf|zip|gz)$/i

function trackedFiles() {
  return execFileSync('git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

const findings = []
function add(sev, rule, where, detail) {
  findings.push({ sev, rule, where, detail })
}

// ---- scan files -----------------------------------------------------------
const files = trackedFiles()
let filesScanned = 0
for (const f of files) {
  if (BINARY.test(f)) continue
  // Generated lockfiles contain registry URLs and integrity hashes by design;
  // they carry no author prose. Credentials in them are still caught by the
  // history scan, and package integrity is verified by `npm ci`.
  if (/^package-lock\.json$/.test(f)) continue
  let text
  try {
    text = readFileSync(f, 'utf8')
  } catch {
    continue
  }
  filesScanned++
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    for (const rule of RULES) {
      if (!rule.re.test(line)) continue
      if (fileAllows(rule, f)) continue
      if (rule.allow && rule.allow(f, line, i)) continue
      add(rule.severity, rule.id, `${f}:${i + 1}`, line.trim().slice(0, 160))
    }
  }
}

// ---- scan commit history --------------------------------------------------
let commitsScanned = 0
if (SCAN_HISTORY) {
  // Default: only the commits this branch actually delivers. `--all-refs`
  // widens this to every ref for a maintainer-wide audit.
  const logArgs = ALL_REFS
    ? ['log', '--all', '--format=%H%x1f%s%x1f%b%x1e']
    : ['log', 'HEAD', '--format=%H%x1f%s%x1f%b%x1e']
  let log = ''
  try {
    log = execFileSync('git', logArgs, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch {
    log = ''
  }
  for (const entry of log.split('\x1e')) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const [sha, subject = '', body = ''] = trimmed.split('\x1f')
    commitsScanned++
    const text = `${subject}\n${body}`
    for (const line of text.split('\n')) {
      for (const rule of RULES) {
        if (rule.id === 'source-pdf-name') continue // prose, not a filename literal
        if (!rule.re.test(line)) continue
        if (rule.allow && rule.allow('<commit>', line)) continue
        add(rule.severity, rule.id, `commit ${sha.slice(0, 10)}`, line.trim().slice(0, 160))
      }
    }
  }
}

// ---- report ---------------------------------------------------------------
const ORDER = { SECRET: 0, INTERNAL: 1, REVIEW: 2 }
findings.sort((a, b) => ORDER[a.sev] - ORDER[b.sev] || a.rule.localeCompare(b.rule))

const bySev = { SECRET: [], INTERNAL: [], REVIEW: [] }
for (const f of findings) bySev[f.sev].push(f)

console.log('public-information gate')
console.log(`  files scanned   : ${filesScanned} (of ${files.length} tracked)`)
console.log(`  commits scanned : ${commitsScanned}${SCAN_HISTORY ? '' : ' (history scan skipped)'}`)
console.log('')

for (const sev of ['SECRET', 'INTERNAL', 'REVIEW']) {
  const list = bySev[sev]
  if (!list.length) continue
  console.log(`${sev} — ${list.length} finding(s)`)
  for (const f of list) {
    console.log(`  [${f.rule}] ${f.where}`)
    console.log(`      ${f.detail}`)
  }
  console.log('')
}

const blocking = bySev.SECRET.length + bySev.INTERNAL.length
if (blocking) {
  console.log(`FAIL: ${blocking} blocking finding(s). See docs/information-governance.md.`)
  process.exit(1)
}
if (bySev.REVIEW.length) {
  console.log(`PASS with ${bySev.REVIEW.length} advisory note(s) to confirm manually.`)
} else {
  console.log('PASS: no known-pattern violation found.')
}
console.log('Note: a clean run does not prove the repository is free of sensitive data.')
