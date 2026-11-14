import { runGithubSchedule } from './lib/github-schedule'
await runGithubSchedule(process.env, Date.now(), process.env.MM_REENABLE_SCHEDULE === 'true')
