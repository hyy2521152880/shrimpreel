import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleVideoJob, runScheduledMaintenance } from '#/server/jobs'
import { defaultStyle, site } from '#/config/site'
import { KieSubmissionUnknown } from '#/server/video/kie'
import { getVideoProvider } from '#/server/video'
import type { VideoStatus } from '#/server/video/types'
import { d1Shim, migrate } from './d1-sqlite'

// 多步任务（yir 两步走）在轮询里进入下一步：jobs.ts 把新的服务商任务写回 generations，只写一次
const status = vi.fn<(requestId: string, meta: Record<string, unknown>) => Promise<VideoStatus>>()
vi.mock('#/server/video', () => ({ getVideoProvider: vi.fn(() => ({ id: 'yir', status, costCents: () => 0 })) }))
vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))
vi.mock('#/server/subscriptions', () => ({ grantDueSubscriptions: async () => ({ checked: 0 }) }))
vi.mock('#/server/retention', () => ({ sweepExpiredMedia: async () => ({ uploads: 0, outputs: 0 }) }))
vi.mock('#/server/reconcile', () => ({ reconcilePendingOrders: async () => ({ checked: 0 }) }))

let sqlite: DatabaseSync
let sent: unknown[]
let env: Env

beforeEach(() => {
  sqlite = new DatabaseSync(':memory:')
  migrate(sqlite)
  sent = []
  env = { DB: d1Shim(sqlite), VIDEO_QUEUE: { send: async (message: unknown) => void sent.push(message) } } as unknown as Env
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'u@example.com', now)
  sqlite
    .prepare(
      `INSERT INTO generations (id, user_id, template_id, duration_id, duration_seconds, credits_cost, upload_id, status, provider,
       provider_request_id, provider_meta, created_at, updated_at) VALUES ('gen_1', 'usr_1', 't', 'short', 6, 6, 'upl_1', 'processing', 'yir', 'job_s', ?, ?, ?)`,
    )
    .run(JSON.stringify({ stage: 'scene' }), now, now)
  status.mockReset()
  vi.mocked(getVideoProvider).mockReset().mockReturnValue({ id: 'yir', submit: vi.fn(), status, costCents: () => 0 })
})

const row = () => sqlite.prepare('SELECT status, provider_request_id, provider_meta FROM generations WHERE id = ?').get('gen_1')
const advance = { state: 'pending', next: { requestId: 'job_v', meta: { stage: 'video', sceneCostCents: 1 } } } as const

describe('jobs：多步任务进入下一步', () => {
  it('provider 返回 next：之后轮询新任务，meta 换成下一步的', async () => {
    status.mockResolvedValue(advance)
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(status).toHaveBeenCalledWith('job_s', { stage: 'scene' })
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'job_v', provider_meta: '{"stage":"video","sceneCostCents":1}' })
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_1' }])
  })

  it('webhook 和定时轮询同时推进：晚到的一路按旧任务 id 抢占失败，不覆盖另一路写入的状态，也不多排一次轮询', async () => {
    status.mockImplementation(async () => {
      // 这一路查询期间，另一路已经推进并写入
      sqlite.prepare('UPDATE generations SET provider_request_id = ?, provider_meta = ? WHERE id = ?').run('job_v', '{"stage":"video"}', 'gen_1')
      return advance
    })
    await handleVideoJob(env, { kind: 'poll', generationId: 'gen_1' })
    expect(row()).toEqual({ status: 'processing', provider_request_id: 'job_v', provider_meta: '{"stage":"video"}' })
    expect(sent).toEqual([])
  })
})

describe('jobs：提交时按任务的风格找源视频', () => {
  it('风格已不在站点配置里：按 invalid_input 失败，不向 provider 提交', async () => {
    const submit = vi.fn()
    vi.mocked(getVideoProvider).mockReturnValueOnce({ id: 'yir', submit, status, costCents: () => 0 })
    sqlite.prepare("UPDATE generations SET status = 'queued', template_id = 'gone-v1', provider_request_id = NULL WHERE id = 'gen_1'").run()
    sqlite
      .prepare("INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, sha256, created_at) VALUES ('upl_1', 'usr_1', 'k', 'image/jpeg', 1, 'h', ?)")
      .run(new Date().toISOString())
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_1' })
    expect(submit).not.toHaveBeenCalled()
    expect(sqlite.prepare('SELECT status, error_code FROM generations WHERE id = ?').get('gen_1')).toEqual({ status: 'failed', error_code: 'invalid_input' })
  })
})

describe('KIE 提交不重复计费', () => {
  function setup() {
    const now = new Date(Date.now() - 6 * 60_000).toISOString()
    sqlite.prepare(`UPDATE generations SET status = 'queued', template_id = ?, duration_id = ?, provider = 'kie', provider_request_id = NULL, created_at = ?, updated_at = ? WHERE id = 'gen_1'`)
      .run(defaultStyle.id, site.durations[0]!.id, now, now)
    sqlite.prepare("INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, sha256, created_at) VALUES ('upl_1', 'usr_1', 'k', 'image/jpeg', 1, 'h', ?)").run(now)
    env.SITE_URL = 'https://site.test'
    env.SESSION_SECRET = 'local-testing-only-32-characters-minimum'
    env.APP_ENV = 'production'
  }
  it('提交结果未知：重复消息和 Cron 都不再次提交；超时只退一次积分', async () => {
    setup()
    const submit = vi.fn(async () => { throw new KieSubmissionUnknown() })
    vi.mocked(getVideoProvider).mockReturnValueOnce({ id: 'kie', submit, status, costCents: () => 0 })
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_1' })
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_1' })
    expect(submit).toHaveBeenCalledTimes(1)
    expect(row()).toMatchObject({ status: 'processing', provider_request_id: null })
    sqlite.prepare("UPDATE generations SET updated_at = ? WHERE id = 'gen_1'").run(new Date(Date.now() - 6 * 60_000).toISOString())
    await runScheduledMaintenance(env)
    expect(sent).toEqual([])
    expect(row()).toMatchObject({ status: 'processing' })
    const old = new Date(Date.now() - 46 * 60_000).toISOString()
    sqlite.prepare("UPDATE generations SET created_at = ?, updated_at = ? WHERE id = 'gen_1'").run(old, old)
    await runScheduledMaintenance(env)
    await runScheduledMaintenance(env)
    expect(row()).toMatchObject({ status: 'failed' })
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE idempotency_key = 'generation_refund:gen_1'").get()).toEqual({ n: 1 })
  })
  it('成功提交后排轮询失败：保留 taskId，Cron 只补轮询，不重新生成', async () => {
    setup()
    const submit = vi.fn(async () => ({ requestId: 'kie_task_1', meta: {} }))
    vi.mocked(getVideoProvider).mockReturnValueOnce({ id: 'kie', submit, status, costCents: () => 0 })
    env.VIDEO_QUEUE.send = vi.fn().mockRejectedValueOnce(new Error('queue unavailable')).mockImplementation(async (message) => { sent.push(message) })
    await handleVideoJob(env, { kind: 'submit', generationId: 'gen_1' })
    expect(row()).toMatchObject({ status: 'processing', provider_request_id: 'kie_task_1' })
    sqlite.prepare("UPDATE generations SET updated_at = ? WHERE id = 'gen_1'").run(new Date(Date.now() - 6 * 60_000).toISOString())
    await runScheduledMaintenance(env)
    expect(sent).toEqual([{ kind: 'poll', generationId: 'gen_1' }])
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
