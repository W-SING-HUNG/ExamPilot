import { execSync } from 'node:child_process'

const files = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' })
  .split('\n').map((s) => s.trim()).filter(Boolean)

const patterns = [
  ['API key prefix', /sk-[a-zA-Z0-9]{16,}/],
  ['AWS key', /AKIA[0-9A-Z]{16}/],
  ['GitHub PAT', /ghp_[a-zA-Z0-9]{20,}/],
  ['GitHub fine-grained', /github_pat_[a-zA-Z0-9_]{20,}/],
  ['Private key', /-----BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ['Bearer literal', /Bearer [a-zA-Z0-9\-_.]{16,}/],
  ['Generic secret assign', /(api[_-]?key|secret|token|password)\s*[:=]\s*["'][^"']{12,}["']/i],
  ['Placeholder-only env', /AI_API_KEY=(?!your-api-key-here|$)/],
]

let hits = 0
for (const f of files) {
  let content = ''
  try { content = execSync(`git show ":${f}"`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }) } catch { continue }
  for (const [name, re] of patterns) {
    const m = content.match(re)
    if (m) {
      hits++
      const line = content.split('\n').find((l) => re.test(l)) ?? ''
      console.log(`HIT [${name}] ${f} :: ${line.trim().slice(0, 100)}`)
    }
  }
}
console.log(`\nscanned ${files.length} files, secret hits: ${hits}`)
