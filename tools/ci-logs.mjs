import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const cred = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
})
const TOKEN = cred
  .split('\n')
  .find((l) => l.startsWith('password='))
  ?.slice(9)
const repo = process.argv[2]
const jobId = process.argv[3]

const res = await fetch(`https://api.github.com/repos/${repo}/actions/jobs/${jobId}/logs`, {
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'User-Agent': 'ExamPilot-Setup',
    Accept: 'application/vnd.github+json',
  },
  redirect: 'follow',
})
const text = await res.text()
writeFileSync(`tools/ci-job-${jobId}.log`, text, 'utf8')
console.log(`saved ${text.length} bytes`)
// print last 60 lines
console.log(text.split('\n').slice(-60).join('\n'))
