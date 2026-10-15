/**
 * Regression tests for the public-information gate.
 *
 * These tests are written against the CURRENT behaviour and are designed to fail
 * against the previous implementation, which:
 *   - printed the matched source line (re-disclosing credentials into CI logs)
 *   - scanned only tracked worktree files + commit messages, and labelled that
 *     as the whole audit
 *   - had no path-level block (relied on .gitignore and text patterns)
 *
 * Run: node tests/public-info-check.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SCRIPT = path.join(ROOT, 'tools', 'public-info-check.mjs')

// Synthetic values only. Never real credentials or real personal paths.
//
// Filenames and tool names are assembled at runtime so this test file does not
// itself contain a literal that the gate would (correctly) flag.
const PDF_EXT = '.' + 'pdf'
const FAKE_KEY = 'sk-' + 'A'.repeat(24) + 'synthetic'
const FAKE_TOKEN = 'ghp_' + 'B'.repeat(24) + 'synthetic'
const FAKE_WIN_PATH = 'C:' + '\\' + 'Users' + '\\' + 'syntheticuser' + '\\' + 'Desktop' + '\\' + 'notes.txt'
const FAKE_NIX_PATH = '/Users/' + 'syntheticuser' + '/secret/project.txt'
const FAKE_EMAIL = 'synthetic.person' + '@' + 'gmail.com'
const FAKE_PDF = '"' + 'private-source-material' + PDF_EXT + '"'
const FAKE_AGENT = 'Clau' + 'de'

/** Run a git command inside a temp repo. */
function gitIn(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts })
}

/** Create an isolated git repo containing the gate script, and return its path. */
function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'exampilot-gate-'))
  gitIn(dir, ['init', '-q', '-b', 'main'])
  gitIn(dir, ['config', 'user.email', 'test@example.invalid'])
  gitIn(dir, ['config', 'user.name', 'Test'])
  gitIn(dir, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(path.join(dir, 'tools'), { recursive: true })
  writeFileSync(path.join(dir, 'tools', 'public-info-check.mjs'), readFileSync(SCRIPT))
  writeFileSync(path.join(dir, 'README.md'), '# clean fixture\n')
  return dir
}

function runGate(cwd, args = []) {
  const res = execFileSync(process.execPath, [path.join(cwd, 'tools', 'public-info-check.mjs'), ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { code: 0, out: res }
}

/** Run the gate capturing stderr/stdout even on failure. */
function runGateRaw(cwd, args = []) {
  try {
    const out = execFileSync(process.execPath, [path.join(cwd, 'tools', 'public-info-check.mjs'), ...args], {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

const repos = []
function repo() {
  const d = makeRepo()
  repos.push(d)
  return d
}
process.on('exit', () => {
  for (const d of repos) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

// ---------------------------------------------------------------------------
// Issue 1 — findings must never print the matched text
// ---------------------------------------------------------------------------

test('gate: SECRET finding is reported WITHOUT printing the credential', () => {
  const d = repo()
  writeFileSync(path.join(d, 'leak.js'), `const apiKey = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.equal(code, 1, 'a credential must fail the gate')
  assert.ok(out.includes('credential-literal'), 'the rule id must be reported')
  assert.ok(!out.includes(FAKE_KEY), 'the raw credential must NOT appear in output')
  assert.ok(!out.includes('AAAA'), 'no fragment of the credential may appear')
})

test('gate: INTERNAL findings do not print the private path, email or document name', () => {
  const d = repo()
  writeFileSync(
    path.join(d, 'notes.js'),
    [
      `const win = '${FAKE_WIN_PATH}'`,
      `const nix = '${FAKE_NIX_PATH}'`,
      `const mail = '${FAKE_EMAIL}'`,
      `const src = ${FAKE_PDF}`,
      `// ${FAKE_AGENT} assisted`,
      '',
    ].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.equal(code, 1, 'internal findings must fail the gate')
  for (const secret of [FAKE_WIN_PATH, FAKE_NIX_PATH, FAKE_EMAIL, 'private-source-material', FAKE_AGENT]) {
    assert.ok(!out.includes(secret), `must not print: ${secret}`)
  }
  // The rule ids and descriptions ARE reported, so the finding is actionable.
  assert.ok(/windows-user-path|posix-home-path|personal-email|source-doc-name|ai-tool-name/.test(out))
})

test('gate: a commit message containing a credential is reported without the message text', () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `oops token ${FAKE_TOKEN} committed`])

  const { code, out } = runGateRaw(d, ['--index'])
  assert.equal(code, 1)
  assert.ok(out.includes('credential-literal'))
  assert.ok(!out.includes(FAKE_TOKEN), 'the commit message text must not be printed')
  assert.ok(!out.includes('oops token'), 'no commit message fragment may be printed')
})

test('gate: a sensitive PATH in a finding is redacted in the report', () => {
  const d = repo()
  // The finding's location is itself sensitive: the file NAME contains personal
  // data and the content contains a credential. Neither may be printed.
  writeFileSync(path.join(d, `${FAKE_EMAIL}.txt`), `token = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  assert.ok(!out.includes(FAKE_EMAIL), 'the sensitive file name must not be printed verbatim')
  assert.ok(!out.includes(FAKE_KEY), 'the credential must not be printed')
  assert.match(out, /redacted path/)
  assert.match(out, /credential-literal/)
})

test('gate: placeholders in fixtures still pass (no false positive)', () => {
  const d = repo()
  writeFileSync(
    path.join(d, 'fixture.mjs'),
    ["const AI_API_KEY = 'your-api-key-here'", "const t = 'shared-secret'", ''].join('\n'),
  )
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `placeholders must not fail:\n${out}`)
})

// ---------------------------------------------------------------------------
// Issue 3 — mode separation and honest scope reporting
// ---------------------------------------------------------------------------

test('gate: staged content is scanned, not just the worktree', () => {
  const d = repo()
  // Stage the secret, then clean the WORKTREE. An index scan must still see the
  // secret; a worktree scan legitimately would not.
  writeFileSync(path.join(d, 'safe.txt'), `const k = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  writeFileSync(path.join(d, 'safe.txt'), 'clean now\n')

  const indexRun = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(indexRun.code, 1, 'the STAGED secret must be detected')
  assert.ok(!indexRun.out.includes(FAKE_KEY))

  const worktreeRun = runGateRaw(d, ['--worktree', '--no-metadata'])
  assert.equal(worktreeRun.code, 0, 'the worktree really is clean, proving the modes differ')
})

test('gate: --commit scans the committed tree, independent of the worktree', () => {
  const d = repo()
  writeFileSync(path.join(d, 'cfg.txt'), `key = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'add config'])
  // Remove it from the worktree; the COMMIT still contains it.
  rmSync(path.join(d, 'cfg.txt'))
  writeFileSync(path.join(d, 'cfg.txt'), 'rotated\n')

  const { code, out } = runGateRaw(d, ['--commit', 'HEAD', '--no-metadata'])
  assert.equal(code, 1, 'the committed blob must be detected')
  assert.ok(!out.includes(FAKE_KEY))
})

test('gate: the report names the mode and does not overstate scope', () => {
  const d = repo()
  writeFileSync(path.join(d, 'ok.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  const { out } = runGateRaw(d, ['--index', '--no-metadata'])

  assert.match(out, /mode\s+:\s+index/)
  assert.match(out, /staged content/)
  assert.match(out, /not proof/i, 'must state that a clean run is not a guarantee')
  assert.match(out, /known patterns/i)
})

test('gate: --all-refs reports blob coverage, not "full history audit"', () => {
  const d = repo()
  writeFileSync(path.join(d, 'ok.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'first'])
  const { out } = runGateRaw(d, ['--all-refs', '--no-metadata'])
  assert.match(out, /all-refs content/)
  assert.match(out, /unique blob/)
  assert.doesNotMatch(out, /full history audit/i)
})

test('gate: metadata scanning can be disabled and is reported separately', () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'clean\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `bad ${FAKE_TOKEN}`])

  const withMeta = runGateRaw(d, ['--index'])
  assert.equal(withMeta.code, 1)

  const withoutMeta = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(withoutMeta.code, 0, 'metadata scan disabled -> commit message not considered')
  assert.match(withoutMeta.out, /commit metadata : 0 commit message/)
})

// ---------------------------------------------------------------------------
// Issue 4 — path-level hard block
// ---------------------------------------------------------------------------

const HARD_BLOCKED = [
  'data/bank.json',
  'data/local-bank.json',
  'src/lib/local-bank.generated.ts',
  'tools/pdf_text.txt',
  'server/ai-config.json',
  '.env',
  '.env.local',
  'private-source' + PDF_EXT,
]

for (const p of HARD_BLOCKED) {
  test(`gate: hard-blocks ${p} even when the content is clean`, () => {
    const d = repo()
    const full = path.join(d, p)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, 'this content is completely innocent\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${p} must be blocked by path, not by content`)
    assert.match(out, /FORBIDDEN PATH/)
    assert.ok(!out.includes('innocent'), 'must not dump file content')
  })
}

test('gate: REJECTS git add -f (force-added gitignored sensitive file)', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, '.gitignore'), 'data/bank.json\n')
  writeFileSync(path.join(d, 'data', 'bank.json'), '{"questions":[]}\n')
  // The bypass this rule exists to stop.
  gitIn(d, ['add', '-f', 'data/bank.json'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'git add -f must not bypass the gate')
  assert.match(out, /FORBIDDEN PATH/)
})

test('gate: allows the placeholder example while blocking real .env files', () => {
  const d = repo()
  writeFileSync(path.join(d, '.env.example'), 'AI_API_KEY=your-api-key-here\n')
  gitIn(d, ['add', '-A'])
  const ok = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(ok.code, 0, '.env.example must remain allowed')

  writeFileSync(path.join(d, '.env'), 'AI_API_KEY=something-real-looking-1234\n')
  gitIn(d, ['add', '-A'])
  const bad = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(bad.code, 1, '.env must be blocked')
})

test('gate: blocks a private PDF but allows the committed sample bank json', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, 'data', 'sample-bank.json'), '{"questions":[]}\n')
  let r = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(r.code, 0, 'data/sample-bank.json is a public file and must pass')

  writeFileSync(path.join(d, 'course-bank' + PDF_EXT), 'not a real document\n')
  gitIn(d, ['add', '-A'])
  r = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(r.code, 1, 'a PDF must be hard-blocked')
})

// ---------------------------------------------------------------------------
// Allowlist integrity: allowlists must never silence credentials
// ---------------------------------------------------------------------------

test('gate: the file allowlist does NOT suppress SECRET rules', () => {
  const d = repo()
  // The scanner allows itself for vocabulary rules; a credential inside it must
  // still be caught.
  const selfPath = path.join(d, 'tools', 'public-info-check.mjs')
  const original = readFileSync(selfPath, 'utf8')
  writeFileSync(selfPath, original + `\n// ${FAKE_KEY}\n`)
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'allowlisting must not mask a credential')
  assert.ok(!out.includes(FAKE_KEY))
})

test('gate: does not rely on .gitignore to block sensitive paths', () => {
  const d = repo()
  // No .gitignore at all, yet the file must still be blocked.
  assert.equal(existsSync(path.join(d, '.gitignore')), false)
  mkdirSync(path.join(d, 'server'), { recursive: true })
  writeFileSync(path.join(d, 'server', 'ai-config.json'), '{"apiKey":"x"}\n')
  gitIn(d, ['add', '-A'])
  const { code } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
})

// ---------------------------------------------------------------------------
// Mode distinction: the committed tree vs historical blobs
// ---------------------------------------------------------------------------

test('gate: a secret removed by a later commit is gone from --commit but still in --all-refs', () => {
  const d = repo()
  writeFileSync(path.join(d, 'legacy.txt'), `key = '${FAKE_KEY}'\n`)
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'first'])
  // Remove the secret in a second commit: HEAD is clean, history is not.
  writeFileSync(path.join(d, 'legacy.txt'), 'rotated\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'second'])

  const head = runGateRaw(d, ['--commit', 'HEAD', '--no-metadata'])
  assert.equal(head.code, 0, 'the current tree must be clean')
  assert.ok(!head.out.includes(FAKE_KEY))

  const first = runGateRaw(d, ['--commit', 'HEAD~1', '--no-metadata'])
  assert.equal(first.code, 1, 'the earlier tree still contains it')
  assert.ok(!first.out.includes(FAKE_KEY), 'even then, the value is never printed')

  const all = runGateRaw(d, ['--all-refs', '--no-metadata'])
  assert.equal(all.code, 1, '--all-refs must surface the historical blob')
  assert.ok(!all.out.includes(FAKE_KEY))
  assert.match(all.out, /unique blob/)
})
