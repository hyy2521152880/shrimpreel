import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app } from '#/server/app'
import { defaultStyle, site } from '#/config/site'
import { ledgerStatements } from '#/server/credits'
import { handleVideoJob } from '#/server/jobs'
import { jobToken } from '#/server/media'
import { sha256Hex } from '#/server/util'
import { d1Shim, kvShim, migrate } from './d1-sqlite'

vi.mock('#/server/notifications', () => ({ notifyGenerationFinished: async () => {} }))
let sqlite: DatabaseSync
let env: Env
let kv: ReturnType<typeof kvShim>
let sent: unknown[]
const session = 'local-test-session'
const settings = { kieModel: 'wan/2-2-animate-replace', kieResolution: '480p', kieCostCentsPerSecond: 6 }
beforeEach(async () => {
  sqlite = new DatabaseSync(':memory:'); migrate(sqlite)
  kv = kvShim(); await kv.put('settings:v1', JSON.stringify(settings)); sent = []
  env = {
    APP_ENV: 'production', SITE_URL: 'https://site.test', VIDEO_PROVIDER: 'kie', KIE_API_KEY: 'fake-key-for-test', SESSION_SECRET: 'test-signing-secret-over-32-characters',
    DB: d1Shim(sqlite), KV: kv,
    VIDEO_QUEUE: { send: async (message: unknown) => { sent.push(message) } },
    GENERATE_LIMITER: { limit: async () => ({ success: true }) },
    MEDIA: { head: async () => ({ size: 1000 }), put: vi.fn(), delete: vi.fn() },
  } as unknown as Env
  const now = new Date().toISOString()
  sqlite.prepare('INSERT INTO users (id, email, credits, created_at) VALUES (?, ?, 0, ?)').run('usr_1', 'test@example.com', now)
  sqlite.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(await sha256Hex(session), 'usr_1', new Date(Date.now() + 3600000).toISOString(), now)
  sqlite.prepare("INSERT INTO uploads (id, user_id, r2_key, content_type, size_bytes, sha256, created_at) VALUES ('upl_1', 'usr_1', 'photo', 'image/jpeg', 1000, 'hash', ?)").run(now)
  await env.DB.batch(ledgerStatements(env.DB, { userId: 'usr_1', delta: 100, reason: 'admin_adjust', idempotencyKey: 'test_grant' }))
})
afterEach(() => { vi.unstubAllGlobals(); sqlite.close() })
const balance = () => Number(sqlite.prepare("SELECT credits FROM users WHERE id='usr_1'").get()!.credits)
const generate = () => app.request('/api/generations', { method: 'POST', headers: { origin: env.SITE_URL, cookie: `__Host-sid=${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ uploadId: 'upl_1', durationId: site.durations[0]!.id, styleId: defaultStyle.id }) }, env)
async function create() {
  const response = await generate()
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json() as { generation: { id: string } }).generation.id
}

it('未配置 Key、成本为 0、输入过大或源视频缺失时，不创建任务、不扣积分', async () => {
  env.KIE_API_KEY = ''
  expect((await generate()).status).toBe(503)
  env.KIE_API_KEY = 'fake-key-for-test'
  await kv.put('settings:v1', JSON.stringify({ ...settings, kieCostCentsPerSecond: 0 }))
  expect((await generate()).status).toBe(503)
  await kv.put('settings:v1', JSON.stringify({ ...settings, kieModel: 'wan/2-2-animate-move', kieResolution: '720p' }))
  sqlite.prepare("UPDATE uploads SET size_bytes = 6000000 WHERE id = 'upl_1'").run()
  expect((await generate()).status).toBe(400)
  sqlite.prepare("UPDATE uploads SET size_bytes = 1000 WHERE id = 'upl_1'").run()
  env.MEDIA.head = vi.fn().mockResolvedValue(null)
  expect((await generate()).status).toBe(503)
  expect(balance()).toBe(100)
  expect(sent).toEqual([])
})

it('真实任务/积分 SQL + 模拟 KIE：参数快照、重复队列只提交一次、失败只退款一次', async () => {
  const id = await create()
  expect(balance()).toBe(100 - site.durations[0]!.credits)
  await kv.put('settings:v1', JSON.stringify({ ...settings, kieModel: 'wan/2-2-animate-move', kieResolution: '720p', kieCostCentsPerSecond: 12 }))
  const fetcher = vi.fn(async (url: string) => url.endsWith('createTask')
    ? Response.json({ code: 200, data: { taskId: 'kie_task_1' } })
    : Response.json({ code: 200, data: { taskId: 'kie_task_1', model: settings.kieModel, state: 'fail' } }))
  vi.stubGlobal('fetch', fetcher)
  await Promise.all([handleVideoJob(env, { kind: 'submit', generationId: id }), handleVideoJob(env, { kind: 'submit', generationId: id })])
  expect(fetcher).toHaveBeenCalledTimes(1)
  const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1]
  expect(JSON.parse(String(init.body))).toMatchObject({ model: settings.kieModel, input: { resolution: '480p' } })
  await handleVideoJob(env, { kind: 'poll', generationId: id })
  await handleVideoJob(env, { kind: 'poll', generationId: id })
  expect(balance()).toBe(100)
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM credit_ledger WHERE idempotency_key = ?').get(`generation_refund:${id}`)).toEqual({ n: 1 })
})

it('结果未知时回调可恢复 taskId：伪造 token 和其他任务回调不能绑定，回调结果 URL 不被使用', async () => {
  const id = await create()
  vi.stubGlobal('fetch', async () => { throw new Error('network disconnected') })
  await handleVideoJob(env, { kind: 'submit', generationId: id })
  const path = `/api/webhooks/kie?gen=${id}&token=${await jobToken(env, id)}`
  const callback = (suffix = path) => app.request(suffix, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { taskId: 'recovered_task', resultJson: '{"resultUrls":["https://evil.test/output"]}' } }) }, env)
  expect((await callback(`/api/webhooks/kie?gen=${id}&token=wrong`)).status).toBe(401)
  const providerResponse = (url: string) => Response.json({ code: 200, data: { taskId: 'recovered_task', model: settings.kieModel, param: JSON.stringify({ callBackUrl: url }) } })
  vi.stubGlobal('fetch', async () => providerResponse('https://other.test/callback'))
  expect((await callback()).status).toBe(400)
  vi.stubGlobal('fetch', async () => providerResponse(`${env.SITE_URL}${path}`))
  expect((await callback()).status).toBe(200)
  expect(sqlite.prepare('SELECT status, provider_request_id FROM generations WHERE id = ?').get(id)).toEqual({ status: 'processing', provider_request_id: 'recovered_task' })
  expect(env.MEDIA.put).not.toHaveBeenCalled()
  expect(sent.at(-1)).toEqual({ kind: 'poll', generationId: id })
})
