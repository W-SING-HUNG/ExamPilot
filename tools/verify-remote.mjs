/**
 * Scan the pushed repository tree on GitHub for secrets and for private-bank leakage.
 * Usage: node tools/verify-remote.mjs <owner/repo> <ref>
 */
import { execSync } from 'node:child_process'

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const TOKEN = cred
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice(9)
const repo = process.argv[2]
const ref = process.argv[3] || 'main'
const API = 'https://api.github.com'
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'ExamPilot-Setup',
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function api(p) {
  const res = await fetch(API + p, { headers: H })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// recursive tree
async function walk(sha, prefix = '') {
  const t = await api(`/repos/${repo}/git/trees/${sha}?recursive=1`)
  const out = []
  for (const e of t.tree ?? []) {
    if (e.type === 'tree') continue
    out.push({ path: prefix + e.path, sha: e.sha, size: e.size })
  }
  return out
}

const refData = await api(`/repos/${repo}/git/ref/heads/${ref}`)
const headSha = refData.object.sha
const files = await walk(headSha)
console.log(`remote files: ${files.length}`)

const SECRET = [
  ['sk- key', /sk-[a-zA-Z0-9]{16,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['ghp_ PAT', /ghp_[a-zA-Z0-9]{20,}/],
  ['github_pat_', /github_pat_[a-zA-Z0-9_]{20,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Bearer literal', /Bearer [a-zA-Z0-9\-_.]{16,}/],
]

let hits = 0
for (const f of files) {
  // forbidden paths (sample-bank.json is the intended public demo bank)
  if (/\.pdf$/.test(f.path)) {
    console.log(`FORBIDDEN PDF: ${f.path}`)
    hits++
  }
  if (/(^|\/)bank\.json$|local-bank/.test(f.path)) {
    console.log(`FORBIDDEN BANK: ${f.path}`)
    hits++
  }
  if (/pdf_text/.test(f.path)) {
    console.log(`FORBIDDEN DERIVED: ${f.path}`)
    hits++
  }
  if (/ai-config\.json$/.test(f.path)) {
    console.log(`FORBIDDEN SECRET FILE: ${f.path}`)
    hits++
  }
  // content scan for text files
  if (!/\.(json|md|ts|tsx|mjs|css|html|yml|yaml|py|txt)$/.test(f.path)) continue
  try {
    const blob = await api(`/repos/${repo}/git/blobs/${f.sha}`)
    const content = Buffer.from(blob.content, blob.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')
    for (const [name, re] of SECRET) {
      if (re.test(content)) {
        const line = content.split('\n').find((l) => re.test(l)) ?? ''
        // ignore placeholder-only example files
        if (f.path === '.env.example' && /your-|placeholder|your-api-key-here/.test(line)) continue
        console.log(`SECRET [${name}] ${f.path} :: ${line.trim().slice(0, 80)}`)
        hits++
      }
    }
  } catch {
    /* skip */
  }
}
console.log(`\nremote scan: ${files.length} files, ${hits} findings`)
process.exit(hits === 0 ? 0 : 1)
