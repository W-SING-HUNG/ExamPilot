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

// ---------------------------------------------------------------------------
// Boundary fix 1 — a forbidden path's NAME must never be printed
//
// Regression: safePath() relied on the content rules, and the source-document
// rule requires quotes, so a real (unquoted) git path was printed verbatim.
// ---------------------------------------------------------------------------

test('gate: a blocked private PDF filename is REDACTED in the report', () => {
  const d = repo()
  // A realistic Chinese private-document name, assembled at runtime.
  const cnName =
    '2026-2027-1' + '\uFF1A' + '\u4E60\u601D\u60F3\u9898\u5E93\u6C47\u603B' + '\uFF0820261010\uFF09' + PDF_EXT
  writeFileSync(path.join(d, cnName), 'innocent content\n')
  gitIn(d, ['add', '-A'])

  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a private PDF must be blocked')
  assert.ok(!out.includes(cnName), 'the raw private filename must NOT be printed')
  // No .pdf name at all may survive anywhere in the output.
  assert.ok(!/[\w\u4e00-\u9fff\uFF00-\uFFEF-]+\.pdf/i.test(out), 'no document name may appear in the log')
  assert.match(out, /redacted path/, 'a redaction marker must be present')
  assert.match(out, /private-source-pdf/, 'the rule id must still be reported')
})

test('gate: an ASCII private PDF filename is also redacted', () => {
  const d = repo()
  const name = 'internal-question-bank-2026' + PDF_EXT
  writeFileSync(path.join(d, name), 'innocent\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  assert.ok(!out.includes(name), 'the filename must not be printed')
  assert.match(out, /redacted path/)
})

test('gate: non-sensitive forbidden paths are still named for actionability', () => {
  const d = repo()
  mkdirSync(path.join(d, 'data'), { recursive: true })
  writeFileSync(path.join(d, 'data', 'bank.json'), '{}\n')
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1)
  // Ordinary repo paths are not secret; naming them is what makes the report useful.
  assert.match(out, /data\/bank\.json/)
})

// ---------------------------------------------------------------------------
// Boundary fix 2 — every common .env variant is blocked by PATH
// ---------------------------------------------------------------------------

const ENV_BLOCKED = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  '.env.test',
  '.env.staging',
  '.env.production.local',
  '.env.development.local',
  '.env.test.local',
  '.env.staging.local',
  '.env.production.local.bak',
  'config/.env.production.local',
  'a/b/.env',
  '.ENV',
  '.ENV.LOCAL',
  '.env.LOCAL',
  '.Env.Production.Local',
]

for (const name of ENV_BLOCKED) {
  test(`gate: blocks .env variant "${name}" by path`, () => {
    const d = repo()
    const full = path.join(d, name)
    mkdirSync(path.dirname(full), { recursive: true })
    // Deliberately innocuous content: the PATH must be what blocks it.
    writeFileSync(full, 'PLACEHOLDER=hello\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 1, `${name} must be blocked by path, not content`)
    assert.match(out, /FORBIDDEN PATH/)
    assert.match(out, /environment-secrets/)
  })
}

const ENV_ALLOWED = ['.env.example', '.env.sample', '.env.template', 'config/.env.example', 'docs/env.md']

for (const name of ENV_ALLOWED) {
  test(`gate: allows credential-free template "${name}"`, () => {
    const d = repo()
    const full = path.join(d, name)
    mkdirSync(path.dirname(full), { recursive: true })
    writeFileSync(full, '# placeholders only\nAI_API_KEY=your-api-key-here\n')
    gitIn(d, ['add', '-A'])
    const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
    assert.equal(code, 0, `${name} must remain allowed:\n${out}`)
  })
}

// ---------------------------------------------------------------------------
// Boundary fix 3 — lockfiles must not be a secret blind spot
// ---------------------------------------------------------------------------

test('gate: a credential injected into package-lock.json IS detected', () => {
  const d = repo()
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ injected: FAKE_KEY }, null, 2))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'a credential in a lockfile must fail the gate')
  assert.match(out, /credential-literal/)
  assert.ok(!out.includes(FAKE_KEY), 'the raw value must not be printed')
})

test('gate: a real npm lockfile still passes (no lockfile false positives)', () => {
  const d = repo()
  writeFileSync(path.join(d, 'package-lock.json'), readFileSync(path.join(ROOT, 'package-lock.json')))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 0, `an ordinary lockfile must pass:\n${out.slice(0, 800)}`)
  assert.match(out, /lockfile/, 'the report must state that a lockfile was scanned')
})

test('gate: vocabulary rules are still skipped in lockfiles, SECRET rules are not', () => {
  const d = repo()
  // A tool name inside a lockfile must not fail the build...
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ note: FAKE_AGENT }, null, 2))
  gitIn(d, ['add', '-A'])
  assert.equal(runGateRaw(d, ['--index', '--no-metadata']).code, 0, 'vocabulary is noise in a lockfile')

  // ...but a credential in the same file must.
  writeFileSync(path.join(d, 'package-lock.json'), JSON.stringify({ note: FAKE_AGENT, k: FAKE_KEY }, null, 2))
  gitIn(d, ['add', '-A'])
  const { code, out } = runGateRaw(d, ['--index', '--no-metadata'])
  assert.equal(code, 1, 'SECRET rules must still apply inside lockfiles')
  assert.ok(!out.includes(FAKE_KEY))
})

// ---------------------------------------------------------------------------
// Boundary fix 4 — metadata scope follows the SELECTED revision
//
// Regression: the metadata scan was hardcoded to HEAD, so `--commit <old>`
// reported HEAD's messages regardless of the revision under inspection.
// ---------------------------------------------------------------------------

test("gate: --commit <rev> scans THAT revision's metadata, not HEAD", () => {
  const d = repo()
  writeFileSync(path.join(d, 'a.txt'), 'a\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'commit A clean'])
  const shaA = gitIn(d, ['rev-parse', 'HEAD']).trim()

  writeFileSync(path.join(d, 'b.txt'), 'b\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', `commit B with ${FAKE_TOKEN}`])
  const shaB = gitIn(d, ['rev-parse', 'HEAD']).trim()

  writeFileSync(path.join(d, 'c.txt'), 'c\n')
  gitIn(d, ['add', '-A'])
  gitIn(d, ['commit', '-q', '-m', 'commit C clean'])
  const shaC = gitIn(d, ['rev-parse', 'HEAD']).trim()

  // Selecting the clean ANCESTOR must pass: its ancestry holds no secret.
  const atA = runGateRaw(d, ['--commit', shaA])
  assert.equal(atA.code, 0, 'the selected revision A and its ancestors are clean')
  assert.ok(!atA.out.includes(FAKE_TOKEN))
  assert.match(atA.out, /scope: ancestry of/)

  // Selecting the revision that contains the secret must fail.
  const atB = runGateRaw(d, ['--commit', shaB])
  assert.equal(atB.code, 1, 'revision B introduced the secret')
  assert.ok(!atB.out.includes(FAKE_TOKEN), 'the token must never be printed')

  // And HEAD (which has B in its ancestry) must also fail.
  const atC = runGateRaw(d, ['--commit', shaC])
  assert.equal(atC.code, 1, 'B is an ancestor of C')
  assert.ok(!atC.out.includes(FAKE_TOKEN))

  // The scope line must differ, proving it is not pinned to HEAD.
  const scopeA = (atA.out.match(/scope: [^\n]*/) || [''])[0]
  const scopeC = (atC.out.match(/scope: [^\n]*/) || [''])[0]
  assert.notEqual(scopeA, scopeC, 'the reported scope must reflect the selected revision')
})
