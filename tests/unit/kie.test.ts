import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultStyle, site } from '#/config/site'
import { kieConfigProblems } from '#/config/kie'
import { createKieProvider, KieSubmissionUnknown, verifyKieRecovery } from '#/server/video/kie'
import { activeVideoProviderId } from '#/server/video'
import { queryVideoBalance } from '#/server/video-balance'
import { parseSettingsPatch } from '#/server/settings'

const key = 'kie_test_secret_not_real'
const env = { KIE_API_KEY: key, VIDEO_PROVIDER: 'kie', APP_ENV: 'production' } as Env
const config = { model: 'wan/2-2-animate-replace', resolution: '480p', costCentsPerSecond: 6, creditPriceCents: 0.5 }
const input = () => ({ generationId: 'gen_1', style: { ...defaultStyle, scene: null }, durationSeconds: 6, imageUrl: 'https://site.test/image', sourceVideoUrl: 'https://site.test/reference.mp4', sourceVideoKey: 'templates/reference.mp4', webhookUrl: 'https://site.test/api/webhooks/kie?gen=gen_1&token=signed', meta: { kie: { ...config }, durationSeconds: 6 } })
const reply = (data: unknown, code = 200, http = 200) => new Response(JSON.stringify({ code, msg: key, data }), { status: http })
const record = (extra: Record<string, unknown> = {}) => ({ taskId: 'task_1', model: config.model, state: 'success', response: { resultUrls: ['https://tempfile.redpandaai.co/output.mp4'] }, ...extra })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('KIE provider', () => {
  it('缺少密钥或错误配置不联网，生产只显式选择 KIE，无备用服务商', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
    await expect(createKieProvider({} as Env).submit(input())).rejects.toMatchObject({ code: 'provider_not_configured', retryable: false })
    const invalid = input(); invalid.meta.kie.resolution = '1080p'
    await expect(createKieProvider(env).submit(invalid)).rejects.toMatchObject({ code: 'kie_config_invalid' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(activeVideoProviderId(env)).toBe('kie')
    expect(() => activeVideoProviderId({ ...env, VIDEO_PROVIDER: 'mock' })).toThrow()
  })

  it('提交使用创建任务时的配置快照，正确发送照片、参考视频与回调，保存 taskId', async () => {
    const fetcher = vi.fn(async () => reply({ taskId: 'task_1' })); vi.stubGlobal('fetch', fetcher)
    const job = input()
    expect(await createKieProvider(env).submit(job)).toEqual({ requestId: 'task_1', meta: job.meta })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.kie.ai/api/v1/jobs/createTask')
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${key}` })
    expect(JSON.parse(String(init.body))).toEqual({ model: config.model, callBackUrl: job.webhookUrl, input: { image_url: job.imageUrl, video_url: job.sourceVideoUrl, resolution: '480p' } })
    job.meta.kie = { ...config, model: 'wan/2-2-animate-move', resolution: '720p' }
    await createKieProvider(env).submit(job)
    expect(JSON.parse(String((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].body)).model).toBe('wan/2-2-animate-move')
  })

  it.each([401, 402, 403, 422, 429, 433, 455])('HTTP 200 下业务错误 %s 被拒绝，只有限流可重试，错误不回显供应商原文', async (code) => {
    vi.stubGlobal('fetch', vi.fn(async () => reply(null, code)))
    await expect(createKieProvider(env).submit(input())).rejects.toMatchObject({ code: `kie_${code}`, retryable: code === 429 })
    await expect(createKieProvider(env).submit(input())).rejects.not.toThrow(key)
  })

  it('网络失败、5xx、成功但缺 taskId 视为结果未知，不能直接重复提交', async () => {
    for (const responder of [async () => { throw new Error(key) }, async () => reply(null, 500, 502), async () => reply({})]) {
      vi.stubGlobal('fetch', responder)
      await expect(createKieProvider(env).submit(input())).rejects.toBeInstanceOf(KieSubmissionUnknown)
    }
  })

  it('轮询成功提取两种结果格式，优先记录实际费用；旧任务成本不随当前站点配置变化', async () => {
    vi.stubGlobal('fetch', async () => reply(record({ creditsConsumed: 13 })))
    expect(await createKieProvider(env).status('task_1', input().meta)).toMatchObject({ state: 'completed', costCents: 7, output: { url: 'https://tempfile.redpandaai.co/output.mp4' } })
    vi.stubGlobal('fetch', async () => reply(record({ response: undefined, resultJson: JSON.stringify({ resultUrls: ['https://file.aiquickdraw.com/output.mp4'] }) })))
    expect(await createKieProvider(env).status('task_1', input().meta)).toMatchObject({ state: 'completed', costCents: 36 })
    await expect(createKieProvider(env).status('task_1', { kie: config })).rejects.toMatchObject({ code: 'kie_duration_missing' })
  })

  it.each(['waiting', 'queuing', 'generating'])('%s 继续等待', async (state) => {
    vi.stubGlobal('fetch', async () => reply(record({ state })))
    expect(await createKieProvider(env).status('task_1', input().meta)).toEqual({ state: 'pending' })
  })

  it('失败、无结果、非可信输出域名均不会冒充成功；任务不匹配继续查证', async () => {
    vi.stubGlobal('fetch', async () => reply(record({ state: 'fail', failMsg: key })))
    expect(await createKieProvider(env).status('task_1', input().meta)).toEqual({ state: 'failed', code: 'kie_generation_failed', message: 'KIE generation failed' })
    for (const url of ['http://127.0.0.1/admin', 'https://redpandaai.co.evil.test/output', 'https://user:pass@kie.ai/x', 'https://kie.ai:123/x', undefined]) {
      vi.stubGlobal('fetch', async () => reply(record({ response: { resultUrls: [url] } })))
      expect(await createKieProvider(env).status('task_1', input().meta)).toMatchObject({ state: 'failed', code: 'kie_output_invalid' })
    }
    vi.stubGlobal('fetch', async () => reply(record({ taskId: 'another_task' })))
    await expect(createKieProvider(env).status('task_1', input().meta)).rejects.toMatchObject({ code: 'kie_task_mismatch', retryable: true })
  })

  it('回调恢复必须向供应商核对 taskId、模型及该任务的签名回调地址', async () => {
    vi.stubGlobal('fetch', async () => reply(record({ param: JSON.stringify({ callBackUrl: input().webhookUrl }) })))
    expect(await verifyKieRecovery(env, 'task_1', input().webhookUrl, config.model)).toBe(true)
    expect(await verifyKieRecovery(env, 'task_1', 'https://another-site.test/hook', config.model)).toBe(false)
    expect(await verifyKieRecovery(env, 'task_1', input().webhookUrl, 'wrong-model')).toBe(false)
  })
})

describe('KIE 配置与余额', () => {
  it('模型组合、成本、后台白名单校验', () => {
    expect(kieConfigProblems(config)).toEqual([])
    expect(kieConfigProblems({ ...config, model: 'wan/2-2-animate-move' }).join()).toContain('720p')
    expect(kieConfigProblems({ ...config, costCentsPerSecond: 0 }).join()).toContain('成本')
    expect(parseSettingsPatch({ kieModel: config.model, kieResolution: '480p', kieCostCentsPerSecond: 6 })).toMatchObject({ kieCostCentsPerSecond: 6 })
    expect(() => parseSettingsPatch({ kieModel: 'any-model' })).toThrow()
  })

  it('余额按积分换算 USD，并检查业务 code 和无效值', async () => {
    vi.stubGlobal('fetch', async () => reply(10000))
    expect(await queryVideoBalance(env)).toMatchObject({ status: 'ok', provider: 'KIE', amount: 10000 * site.video.kie.creditPriceCents / 100 })
    vi.stubGlobal('fetch', async () => reply(null, 401))
    expect(await queryVideoBalance(env)).toEqual({ status: 'unauthorized', keyName: 'KIE_API_KEY' })
    vi.stubGlobal('fetch', async () => reply(null))
    expect(await queryVideoBalance(env)).toEqual({ status: 'unreadable' })
  })
})
