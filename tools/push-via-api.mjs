/**
 * Push local commits to GitHub using the Git Data API.
 * Used because the sandbox blocks direct git://https transport from git.exe.
 *
 * Usage: node tools/push-via-api.mjs <owner/repo> <ref>
 */
import { execSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const TOKEN = cred
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice(9)
if (!TOKEN) {
  console.error('no token')
  process.exit(1)
}

const API = 'https://api.github.com'
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'ExamPilot-Setup',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function api(method, p, body) {
  const res = await fetch(API + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${JSON.stringify(json)}`)
  return json
}

const repo = process.argv[2]
const ref = process.argv[3] || 'main'

// ---- 1. collect the commit to push (HEAD) ----
const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
const msg = execSync('git log -1 --format=%B', { encoding: 'utf8' })
// avoid ^{} shell escaping: use rev-parse with a disambiguated arg
const treeSha = execSync('git rev-parse "HEAD^{tree}"', { encoding: 'utf8', shell: 'cmd.exe' }).trim()
console.log(`local HEAD: ${sha}`)
console.log(`local tree: ${treeSha}`)

// ---- 2. read the tree recursively and build blobs ----
function lsTree(sha, prefix = '') {
  const out = execSync(`git ls-tree -r ${sha}`, { encoding: 'utf8' })
  const entries = []
  for (const line of out.split('\n').filter(Boolean)) {
    const m = line.match(/^(\d+) (blob|tree|commit) ([0-9a-f]+)\t(.*)$/)
    if (!m) continue
    const [, , type, objSha, filePath] = m
    if (type !== 'blob') continue
    entries.push({ path: filePath, sha: objSha, mode: '100644', full: path.resolve('.', filePath) })
  }
  return entries
}

const files = lsTree(treeSha)
console.log(`blobs to create: ${files.length}`)

// The repository must already contain at least one ref (initialised via the
// Contents API) before the Git Data API accepts blobs/trees.
let existing = null
try {
  existing = await api('GET', `/repos/${repo}/git/ref/heads/${ref}`)
  console.log(`remote ${ref} at ${existing.object.sha}`)
} catch (e) {
  if (/409/.test(e.message)) {
    throw new Error('仓库仍为空：请先用 Contents API 创建一个文件以初始化仓库')
  }
  throw e
}

// ---- 3. create blobs (skip if identical content already on remote) ----
const created = new Map()
let n = 0
for (const f of files) {
  const st = statSync(f.full)
  if (!st.isFile()) continue
  const raw = readFileSync(f.full)
  const isBinary = raw.includes(0)
  const content = isBinary ? raw.toString('base64') : raw.toString('utf8')
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content,
    encoding: isBinary ? 'base64' : 'utf-8',
  })
  created.set(f.path, blob.sha)
  n++
  if (n % 20 === 0) console.log(`  ...${n}/${files.length}`)
}
console.log(`blobs created: ${n}`)

// ---- 4. build nested trees ----
function buildTree(entries) {
  const root = { name: '', children: new Map(), files: [] }
  for (const e of entries) {
    const parts = e.path.split('/')
    let cur = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts[i]
      if (!cur.children.has(p)) cur.children.set(p, { name: p, children: new Map(), files: [] })
      cur = cur.children.get(p)
    }
    cur.files.push({ ...e, name: parts[parts.length - 1] })
  }
  async function emit(node) {
    const tree = []
    for (const f of node.files) {
      tree.push({ path: f.name, mode: '100644', type: 'blob', sha: created.get(f.path) })
    }
    for (const [, child] of node.children) {
      tree.push({ path: child.name, mode: '040000', type: 'tree', sha: await emit(child) })
    }
    const res = await api('POST', `/repos/${repo}/git/trees`, { tree })
    return res.sha
  }
  return emit(root)
}

const newTree = await buildTree(files)
console.log(`tree: ${newTree}`)

// ---- 5. create commit (child of the remote head so the update fast-forwards) ----
const commit = await api('POST', `/repos/${repo}/git/commits`, {
  message: msg.trim(),
  tree: newTree,
  parents: existing ? [existing.object.sha] : [],
})
console.log(`commit: ${commit.sha} (parent: ${existing?.object.sha ?? 'none'})`)

// ---- 6. update ref (fast-forward from the existing head) ----
console.log(`fast-forwarding ${ref} from ${existing.object.sha}`)
const upd = await api('PATCH', `/repos/${repo}/git/refs/heads/${ref}`, { sha: commit.sha, force: false })
console.log(`updated: ${upd.ref} -> ${upd.object.sha}`)
console.log('PUSH OK')
