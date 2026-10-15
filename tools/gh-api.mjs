import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const token = cred
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice(9)
if (!token) {
  console.error('no token')
  process.exit(1)
}

const [, , action, path, bodyArg] = process.argv
const method = action || 'GET'
const body = bodyArg ? (bodyArg.startsWith('@') ? readFileSync(bodyArg.slice(1), 'utf8') : bodyArg) : undefined

const res = await fetch(`https://api.github.com${path}`, {
  method,
  headers: {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'ExamPilot-Setup',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  },
  body,
})
const text = await res.text()
let json
try {
  json = JSON.parse(text)
} catch {
  json = text
}
console.log(JSON.stringify({ status: res.status, ok: res.ok, body: json }, null, 2))
