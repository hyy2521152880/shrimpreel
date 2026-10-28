import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { resetLaunchConfig } from '../../scripts/launch-config.mjs'
import { checkKie, validateKieSchema } from '../../scripts/check-kie.mjs'

const template = readFileSync('wrangler.jsonc', 'utf8')
describe('新站独立配置', () => {
  it('旧账号、域名、OAuth、商品和资源均不沿用；默认 KIE + Stripe 测试环境', () => {
    const old = JSON.parse(resetLaunchConfig(template, { domain: 'old.test', name: 'old-site' }))
    old.account_id = 'old-account'; old.env = { staging: { vars: { SECRET: 'old-secret' } } }
    old.vars.GOOGLE_CLIENT_ID = 'old-google'; old.vars.STRIPE_PRODUCTS = '{"starter":"old-price"}'
    old.vars.KIE_API_KEY = 'should-never-be-copied'; old.d1_databases[0].database_id = 'old-db'
    const output = resetLaunchConfig(JSON.stringify(old), { domain: 'dance.test', name: 'dance', adminEmail: 'owner@dance.test' })
    for (const value of ['old-account', 'old-secret', 'old-google', 'old-price', 'old-db', 'old.test', 'should-never-be-copied']) expect(output).not.toContain(value)
    const next = JSON.parse(output)
    expect(next.vars).toMatchObject({ VIDEO_PROVIDER: 'kie', PAYMENT_PROVIDER: 'stripe', STRIPE_ENVIRONMENT: 'test', SITE_URL: 'https://dance.test', ADMIN_EMAILS: 'owner@dance.test', GOOGLE_CLIENT_ID: '', STRIPE_PRODUCTS: '{}' })
    expect(next.routes).toEqual([{ pattern: 'dance.test', custom_domain: true }])
    expect(next.r2_buckets[0].bucket_name).toBe('dance-media')
    expect(next.queues.consumers[0].dead_letter_queue).toBe('dance-jobs-dlq')
    expect(next.d1_databases[0].database_id).toBe('00000000-0000-0000-0000-000000000000')
  })
  it('未适配服务商及无法安全重置的绑定拒绝生成', () => {
    expect(() => resetLaunchConfig(template, { domain: 'dance.test', name: 'dance', video: 'unknown' })).toThrow()
    const config = JSON.parse(resetLaunchConfig(template, { domain: 'dance.test', name: 'dance' }))
    config.services = [{ service: 'other-product', binding: 'OTHER' }]
    expect(() => resetLaunchConfig(JSON.stringify(config), { domain: 'dance.test', name: 'dance' })).toThrow('独立资源')
  })
})

const model = 'wan/2-2-animate-replace'
const schema = () => ({ paths: { '/api/v1/jobs/createTask': { post: { requestBody: { content: { 'application/json': { schema: { properties: {
  model: { enum: [model] }, input: { properties: { image_url: {}, video_url: {}, resolution: { enum: ['480p'] } }, required: ['image_url', 'video_url'] },
} } } } } } } } })
describe('KIE 上线前只读核对', () => {
  it('没 Key 时不请求；发现模型后核对 schema 和价格，绝不调用 createTask', async () => {
    const request = vi.fn(async (url: string) => {
      const data = url.endsWith('/models') ? { models: [{ model }] } : url.endsWith('/schema') ? { openapi: schema() } : url.endsWith('/price') ? { pricingDesc: 'example price' } : 1000
      return Response.json({ code: 200, data })
    })
    await expect(checkKie({ key: '', request })).rejects.toThrow('没有发起网络请求')
    expect(request).not.toHaveBeenCalled()
    expect(await checkKie({ key: 'fake-key', model, resolution: '480p', request, wait: async () => {} })).toMatchObject({ generated: false, balanceCredits: 1000 })
    expect(request).toHaveBeenCalledTimes(4)
    expect(request.mock.calls.every(([url]) => !url.includes('createTask'))).toBe(true)
  })
  it('不支持的分辨率、新增必填参数或缺少 schema 均停止', () => {
    expect(() => validateKieSchema(schema(), model, '1080p')).toThrow('分辨率')
    const changed = schema()
    changed.paths['/api/v1/jobs/createTask'].post.requestBody.content['application/json'].schema.properties.input.required.push('new_required_field')
    expect(() => validateKieSchema(changed, model, '480p')).toThrow('新增')
    expect(() => validateKieSchema(null, model, '480p')).toThrow()
  })
})
