#!/usr/bin/env node
/**
 * Public-information gate.
 *
 * Implements the automated portion of docs/information-governance.md.
 *
 * SCOPE — what each mode actually inspects (see docs §4):
 *
 *   (default)      index ("staged") file CONTENT  +  commit metadata
 *   --commit <rev> that commit's tree file CONTENT + commit metadata
 *   --worktree     working-tree file CONTENT      +  commit metadata
 *   --all-refs     every reachable blob CONTENT   +  all commit metadata
 *
 * Content scanning and metadata scanning are separate and are reported
 * separately. This tool does NOT scan the full content of every historical
 * commit unless `--all-refs` is given.
 *
 * OUTPUT POLICY (see docs §2 and §5): findings never print the matched text.
 * Only the rule id, a path (or commit sha) and a rule description are emitted,
 * so a detected credential, private path or personal datum is not re-disclosed
 * into CI logs. A path that itself looks sensitive is redacted.
 *
 * LIMITS: only known patterns are detected. This does not replace human review,
 * and a clean run is not proof that the repository holds nothing sensitive.
 *
 * Exit code 1 when a blocking (SECRET / INTERNAL) finding or a forbidden path
 * is present; 0 otherwise. REVIEW-severity notes never fail the build.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Flagged vocabulary (assembled from fragments so this file's own pattern table
// does not match itself).
//
// Scope note: per docs §2 an AI *provider protocol* or a third-party dependency
// the product integrates with is PUBLIC. Only names of development assistants /
// coding agents are INTERNAL, so provider-protocol words are excluded.
// ---------------------------------------------------------------------------
const FRAG = {
  assistantTools: ['Clau' + 'de', 'Chat' + 'GPT', 'Co' + 'pilot', 'Gem' + 'ini'],
  codingAgents: ['De' + 'vin', 'Code' + 'x'],
  processWords: ['提' + '示词', 'AI' + ' Agent', 'sub' + 'agent', 'agent ' + '分工', '聊天' + '记录', '对话' + '记录'],
  privateLabels: ['内部' + '工作流', '内部' + '协作记录', '私人' + '偏好', '我的' + '提示词', '我们' + '的对话'],
  validationClaims: ['独立' + '验收', '独立' + '审查', 'independently ' + 'validated', 'independent ' + 'review'],
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const alt = (arr, flags = '') => new RegExp(`(${arr.map(esc).join('|')})`, flags)

/**
 * A finding rule.
 *   severity: 'SECRET' | 'INTERNAL' | 'REVIEW'  (REVIEW = advisory only)
 *   allow: predicate (file, line) => true to suppress a legitimate match
 */
export const RULES = [
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
    id: 'source-doc-name',
    severity: 'INTERNAL',
    re: /["'][^"'\n]*\.pdf["']/i,
    desc: 'hardcoded document filename (may disclose private source material)',
    allow: (f, line) =>
      /\.gitignore$|\.gitattributes$|PULL_REQUEST_TEMPLATE/.test(f) ||
      /^\s*\*?\.pdf\b/.test(line.trim()) ||
      /[,，、]?\*\.pdf/.test(line),
  },

  // ---- INTERNAL: development tooling and process -------------------------
  {
    id: 'ai-tool-name',
    severity: 'INTERNAL',
    re: alt([...FRAG.assistantTools, ...FRAG.codingAgents], 'i'),
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
    re: alt([...FRAG.processWords, ...FRAG.privateLabels]),
    desc: 'internal process or private-record disclosure',
  },

  // ---- REVIEW: phrasing that must match real evidence --------------------
  {
    id: 'validation-claim',
    severity: 'REVIEW',
    re: alt(FRAG.validationClaims, 'i'),
    desc: 'validation claim — confirm independent evidence exists',
  },
]

/**
 * Paths that must NEVER be committed, independent of their content.
 * `.gitignore` alone is not a guarantee (`git add -f` bypasses it), so the gate
 * checks the candidate path list directly.
 */
export const FORBIDDEN_PATHS = [
  { id: 'private-course-bank', match: (p) => p === 'data/bank.json' },
  { id: 'private-course-bank', match: (p) => p === 'data/local-bank.json' },
  { id: 'generated-bank-loader', match: (p) => p === 'src/lib/local-bank.generated.ts' },
  { id: 'extracted-source-text', match: (p) => p === 'tools/pdf_text.txt' || p === 'tools/parse_out.txt' },
  { id: 'ai-gateway-credentials', match: (p) => p === 'server/ai-config.json' },
  {
    id: 'environment-secrets',
    // `.env`, `.env.local`, `.env.production` … but NOT the placeholder example.
    match: (p) => /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/.test(p) && !/\.env\.example$/.test(p),
  },
  {
    id: 'private-source-pdf',
    match: (p) => /\.pdf$/i.test(p) && !/^data\/sample-/.test(p),
  },
  { id: 'local-backup-data', match: (p) => /\.exampilot-backup\.json$/i.test(p) },
]

/**
 * File-level allowlist: files whose matches are structural (they *define* the
 * policy vocabulary), never used to silence credentials. A regression test
 * asserts that SECRET rules still fire inside allowlisted files.
 */
export const FILE_ALLOW = [
  { file: /^tools\/public-info-check\.mjs$/, rules: ['ai-tool-name', 'process-disclosure'] },
  {
    file: /^docs\/(information-governance|history-exposure-report)\.md$/,
    rules: ['process-disclosure', 'validation-claim'],
  },
]

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|zip|gz)$/i
// Generated lockfiles carry registry URLs and integrity hashes by design and no
// author prose; `npm ci` verifies their integrity instead.
const SKIP_CONTENT = [/^package-lock\.json$/]

export function fileAllows(rule, file) {
  return FILE_ALLOW.some((a) => a.file.test(file) && a.rules.includes(rule.id))
}

/** True when the path itself looks sensitive and must not be printed verbatim. */
export function isSensitivePath(path) {
  return RULES.some((r) => r.severity !== 'REVIEW' && r.re.test(path))
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(args, opts = {}) {
  // Capture stderr too: a failing git command must not spray raw diagnostics
  // into the log, and callers handle the failure explicitly.
  return execFileSync('git', args, {
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  })
}

/**
 * Read many blobs in one `git cat-file --batch` call.
 * Returns Map<sha, Buffer>.
 */
export function batchReadBlobs(shas) {
  const unique = [...new Set(shas)]
  const out = new Map()
  if (!unique.length) return out
  const input = unique.map((s) => s + '\n').join('')
  const buf = git(['cat-file', '--batch'], { input })
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const header = buf.toString('utf8', pos, nl)
    pos = nl + 1
    const parts = header.split(' ')
    if (parts.length < 3) continue // "<sha> missing"
    const [, type, sizeStr] = parts
    const size = Number.parseInt(sizeStr, 10)
    if (!Number.isFinite(size)) continue
    const content = buf.subarray(pos, pos + size)
    pos += size + 1
    if (type === 'blob') out.set(parts[0], Buffer.from(content))
  }
  return out
}

/** Files present in a commit tree: [{ path, sha }]. */
function commitTree(rev) {
  const out = git(['ls-tree', '-r', '-z', '--full-tree', rev], { encoding: 'utf8' })
  const files = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const m = entry.match(/^(\d+) (blob|tree|commit) ([0-9a-f]+)\t([\s\S]+)$/)
    if (!m || m[2] !== 'blob') continue
    files.push({ path: m[4], sha: m[3] })
  }
  return files
}

/** Files staged in the index: [{ path, sha }]. */
function indexFiles() {
  const out = git(['ls-files', '-s', '-z'], { encoding: 'utf8' })
  const files = []
  for (const entry of out.split('\0')) {
    if (!entry) continue
    const m = entry.match(/^(\d+) ([0-9a-f]+) (\d)\t([\s\S]+)$/)
    if (!m) continue
    // On an unmerged path the same file appears for stages 1..3; only stage 0 is
    // the resolved content.
    if (m[3] !== '0') continue
    files.push({ path: m[4], sha: m[2] })
  }
  return files
}

/** Every blob reachable from all refs: [{ path, sha }] (paths may be null). */
function allRefBlobs() {
  const out = git(['rev-list', '--objects', '--all'], { encoding: 'utf8' })
  const files = []
  for (const line of out.split('\n')) {
    const m = line.match(/^([0-9a-f]{40})(?:\s([\s\S]+))?$/)
    if (!m) continue
    files.push({ path: m[2] || '(unknown path)', sha: m[1] })
  }
  return files
}

/** Commit metadata entries: [{ sha, message }] for the requested revs. */
function commitMessages(revs) {
  const out = git(['log', revs, '--format=%H%x1f%B%x1e'], { encoding: 'utf8' })
  const commits = []
  for (const entry of out.split('\x1e')) {
    const t = entry.trim()
    if (!t) continue
    const [sha, ...rest] = t.split('\x1f')
    commits.push({ sha, message: rest.join('\x1f') })
  }
  return commits
}

// ---------------------------------------------------------------------------
// scanning
// ---------------------------------------------------------------------------

/**
 * Scan one text blob. Returns findings with NO matched text captured.
 * `where` is "path:line" for content or "commit <sha>" for metadata.
 */
export function scanText(text, where, fileForAllow = '', opts = {}) {
  const findings = []
  if (typeof text !== 'string' || text.includes('\0')) return findings
  const lines = text.split('\n')
  for (const [i, line] of lines.entries()) {
    for (const rule of RULES) {
      if (opts.skipRules && opts.skipRules.includes(rule.id)) continue
      if (!rule.re.test(line)) continue
      if (fileForAllow && fileAllows(rule, fileForAllow)) continue
      if (rule.allow && rule.allow(fileForAllow, line, i)) continue
      findings.push({ severity: rule.severity, rule: rule.id, desc: rule.desc, where: `${where}:${i + 1}` })
    }
  }
  return findings
}

/** Scan commit messages. Never captures the message text. */
export function scanCommitMetadata(commits) {
  const findings = []
  for (const { sha, message } of commits) {
    const where = `commit ${sha.slice(0, 10)}`
    // A commit message is a single logical unit: report the rule but never the
    // text, and do not emit one finding per matching line.
    const seen = new Set()
    for (const line of message.split('\n')) {
      for (const rule of RULES) {
        if (rule.id === 'source-doc-name') continue // prose, not a filename literal
        if (!rule.re.test(line)) continue
        if (rule.allow && rule.allow('<commit>', line)) continue
        if (seen.has(rule.id)) continue
        seen.add(rule.id)
        findings.push({ severity: rule.severity, rule: rule.id, desc: rule.desc, where })
      }
    }
  }
  return findings
}

/** Path-level hard block. Independent of content and of .gitignore. */
export function checkForbiddenPaths(paths) {
  const hits = []
  for (const p of paths) {
    for (const rule of FORBIDDEN_PATHS) {
      if (rule.match(p)) hits.push({ rule: rule.id, path: p })
    }
  }
  return hits
}

// ---------------------------------------------------------------------------
// collection per mode
// ---------------------------------------------------------------------------

export function collectTargets(mode, rev) {
  if (mode === 'worktree') {
    const files = git(['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
    return files.map((p) => ({ path: p, text: existsSync(p) ? readFileSync(p, 'utf8') : '' }))
  }
  if (mode === 'index') {
    const files = indexFiles()
    const blobs = batchReadBlobs(files.map((f) => f.sha))
    return files.map((f) => ({ path: f.path, text: blobs.get(f.sha)?.toString('utf8') ?? '' }))
  }
  if (mode === 'commit') {
    const files = commitTree(rev)
    const blobs = batchReadBlobs(files.map((f) => f.sha))
    return files.map((f) => ({ path: f.path, text: blobs.get(f.sha)?.toString('utf8') ?? '' }))
  }
  // all-refs: dedupe by blob sha, remember the first path seen for reporting
  const blobs = allRefBlobs()
  const bySha = new Map()
  for (const b of blobs) if (!bySha.has(b.sha)) bySha.set(b.sha, b.path)
  const contents = batchReadBlobs([...bySha.keys()])
  return [...contents.entries()].map(([sha, buf]) => ({
    path: bySha.get(sha) || '(unknown)',
    text: buf.toString('utf8'),
  }))
}

// ---------------------------------------------------------------------------
// rendering (redacted)
// ---------------------------------------------------------------------------

function safePath(path) {
  if (!path || path === '(unknown)') return '(unknown path)'
  return isSensitivePath(path) ? '(redacted path — its name matches a sensitive pattern)' : path
}

export function render({ mode, rev, contentScanned, metadataScanned, contentLabel, findings, forbidden }) {
  const lines = []
  lines.push('public-information gate')
  lines.push(`  mode            : ${mode}${rev ? ` (${rev})` : ''}`)
  lines.push(`  ${contentLabel}`)
  lines.push(`  commit metadata : ${metadataScanned} commit message(s)`)
  lines.push('')
  lines.push('  Note: findings below never include matched text, so detected credentials')
  lines.push('  or personal data are not re-disclosed into this log.')
  lines.push('')

  if (forbidden.length) {
    lines.push(`FORBIDDEN PATH — ${forbidden.length} file(s) must never be committed`)
    for (const f of forbidden) lines.push(`  [${f.rule}] ${safePath(f.path)}`)
    lines.push('')
  }

  const ORDER = { SECRET: 0, INTERNAL: 1, REVIEW: 2 }
  findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.rule.localeCompare(b.rule))
  const bySev = { SECRET: [], INTERNAL: [], REVIEW: [] }
  for (const f of findings) bySev[f.severity].push(f)

  for (const sev of ['SECRET', 'INTERNAL', 'REVIEW']) {
    const list = bySev[sev]
    if (!list.length) continue
    lines.push(`${sev} — ${list.length} finding(s)`)
    for (const f of list) {
      const where = f.where.startsWith('commit ')
        ? f.where
        : safePath(f.where.replace(/:\d+$/, '')) + (f.where.match(/:\d+$/) || [''])[0]
      lines.push(`  [${f.rule}] ${where}`)
      lines.push(`      ${f.desc}`)
    }
    lines.push('')
  }

  const blocking = bySev.SECRET.length + bySev.INTERNAL.length + forbidden.length
  if (blocking) {
    lines.push(`FAIL: ${blocking} blocking finding(s). See docs/information-governance.md.`)
  } else if (bySev.REVIEW.length) {
    lines.push(`PASS with ${bySev.REVIEW.length} advisory note(s) to confirm manually.`)
  } else {
    lines.push('PASS: no known-pattern violation found.')
  }
  lines.push('Note: this only covers the modes listed above and only known patterns.')
  lines.push('A clean run is not proof that the repository holds nothing sensitive.')
  void contentScanned
  return { text: lines.join('\n'), blocking }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const has = (f) => argv.includes(f)
  const valueOf = (f) => {
    const i = argv.indexOf(f)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null
  }
  let mode = 'index'
  let rev = null
  if (has('--worktree')) mode = 'worktree'
  if (has('--all-refs')) mode = 'all-refs'
  if (has('--commit')) {
    mode = 'commit'
    rev = valueOf('--commit') || 'HEAD'
  }
  if (has('--index') || has('--staged')) mode = 'index'
  return { mode, rev, metadata: !has('--no-metadata') }
}

export function run(argv = process.argv.slice(2)) {
  const { mode, rev, metadata } = parseArgs(argv)

  let targets
  try {
    targets = collectTargets(mode, rev)
  } catch (e) {
    // An unusable revision must fail loudly but readably, never as a stack trace.
    process.stdout.write(
      [
        'public-information gate',
        `  mode            : ${mode}${rev ? ` (${rev})` : ''}`,
        '',
        `FAIL: cannot read the requested revision/tree (${rev ?? mode}).`,
        'Refusing to report PASS because the content could not be inspected.',
        '',
      ].join('\n'),
    )
    void e
    return 1
  }
  let findings = []
  let contentScanned = 0
  for (const t of targets) {
    if (BINARY_EXT.test(t.path)) continue
    if (SKIP_CONTENT.some((re) => re.test(t.path))) continue
    contentScanned++
    findings = findings.concat(scanText(t.text, t.path, t.path))
  }

  // Path-level block over exactly the candidate path list for this mode.
  const forbidden = checkForbiddenPaths(targets.map((t) => t.path))

  let metadataScanned = 0
  if (metadata) {
    const revs = mode === 'all-refs' ? '--all' : 'HEAD'
    const commits = commitMessages(revs)
    metadataScanned = commits.length
    findings = findings.concat(scanCommitMetadata(commits))
  }

  const contentLabel =
    mode === 'worktree'
      ? `worktree content  : ${contentScanned} file(s) from the working tree`
      : mode === 'commit'
        ? `commit content  : ${contentScanned} file(s) in ${rev}`
        : mode === 'all-refs'
          ? `all-refs content: ${contentScanned} unique blob(s) across every ref`
          : `staged content  : ${contentScanned} file(s) from the index (what a commit would publish)`

  const { text, blocking } = render({
    mode,
    rev,
    contentScanned,
    metadataScanned,
    contentLabel,
    findings,
    forbidden,
  })
  process.stdout.write(text + '\n')
  return blocking ? 1 : 0
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) process.exit(run())
