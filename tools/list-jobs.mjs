import { readFileSync } from 'node:fs'
const j = JSON.parse(readFileSync('tools/jobs.json', 'utf8').replace(/^﻿/, ''))
j.body.jobs.forEach((job) => console.log(job.name, '|', job.id, '|', job.conclusion))
