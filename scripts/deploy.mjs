#!/usr/bin/env node
// 发布前记录线上内容，只有发布成功才比较并推送变化页面。
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { site } from '../src/config/site.ts'

function run(file, args) {
  const result = spawnSync(process.execPath, [file, ...args], { stdio: 'inherit', env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${file} 执行失败，后续步骤已停止`)
}
export function deploy({ npm, hasKey, release, execute = run, log = console.log }) {
  if (!npm) throw new Error('请通过 npm run deploy 执行')
  const run = execute
  run(npm, ['run', 'doctor'])
  run(npm, ['run', 'build'])
  if (hasKey) run('scripts/indexnow.mjs', ['--snapshot', `${release}/before.json`])
  run(npm, ['exec', '--', 'wrangler', 'deploy'])
  if (hasKey) {
    log('生产部署已成功；以下为独立的 IndexNow 提交步骤，失败不等于部署回滚。')
    log(`补推命令: npm run seo:indexnow -- --since ${release}/before.json --submit --out ${release}/submission.json`)
    run('scripts/indexnow.mjs', ['--since', `${release}/before.json`, '--submit', '--out', `${release}/submission.json`])
  } else log('未配置 IndexNow key，跳过通知')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    deploy({ npm: process.env.npm_execpath, hasKey: Boolean(site.seo.indexNowKey), release: `.tmp/indexnow/releases/${new Date().toISOString().replace(/[:.]/g, '-')}` })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
