import { site } from '#/config/site'
import { kieConfigProblems, type KieConfig } from '#/config/kie'
import { cleanSecret } from '../util'
import type { VideoProvider, VideoStatus } from './types'
import { VideoProviderError } from './types'

const BASE = 'https://api.kie.ai'
export const taskIdValid = (id: unknown): id is string => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(id)
type Envelope = { code?: number; data?: Record<string, unknown> }

// 网络断开、超时或 5xx 不能证明没有创建任务。队列必须等待回调/人工核对，不能重投 createTask。
export class KieSubmissionUnknown extends Error {
  constructor() { super('KIE submission outcome unknown; do not resubmit') }
}

// 用签名回调恢复“供应商接收成功，但 task id 没写入 D1”的任务。再次向 KIE 查证所属回调，绝不信任回调中的结果 URL。
export async function verifyKieRecovery(env: Env, requestId: string, callbackUrl: string, model: string) {
  if (!taskIdValid(requestId) || !cleanSecret(env.KIE_API_KEY)) return false
  const response = await fetch(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(requestId)}`, {
    headers: { Authorization: `Bearer ${cleanSecret(env.KIE_API_KEY)}` }, signal: AbortSignal.timeout(30_000), redirect: 'error',
  })
  const body = await response.json().catch(() => null) as Envelope | null
  if (!response.ok || body?.code !== 200) throw new Error('KIE recovery query unavailable')
  if (body.data?.taskId !== requestId || body.data.model !== model || typeof body.data.param !== 'string') return false
  try { return JSON.parse(body.data.param).callBackUrl === callbackUrl } catch { return false }
}

export function kieConfigFromMeta(meta: Record<string, unknown>): KieConfig {
  const raw = meta.kie
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new VideoProviderError('kie_config_missing', 'KIE job configuration snapshot missing', false)
  const config = raw as KieConfig
  if (kieConfigProblems(config).length) throw new VideoProviderError('kie_config_invalid', 'KIE job configuration is invalid', false)
  return config
}

export function createKieProvider(env: Env): VideoProvider {
  const key = cleanSecret(env.KIE_API_KEY)
  const headers = () => {
    if (!key) throw new VideoProviderError('provider_not_configured', 'KIE_API_KEY missing', false)
    return { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }
  }
  return {
    id: 'kie',
    async submit(input) {
      const auth = headers()
      const config = kieConfigFromMeta(input.meta)
      if (input.style.scene) throw new VideoProviderError('kie_scene_unsupported', 'KIE Wan recipes do not support the yir scene pipeline', false)
      let response: Response
      let body: Envelope | null
      try {
        response = await fetch(`${BASE}/api/v1/jobs/createTask`, {
          method: 'POST', headers: auth, signal: AbortSignal.timeout(30_000), redirect: 'error',
          body: JSON.stringify({
            model: config.model,
            ...(input.webhookUrl.startsWith('https://') ? { callBackUrl: input.webhookUrl } : {}),
            input: { image_url: input.imageUrl, video_url: input.sourceVideoUrl, resolution: config.resolution },
          }),
        })
        body = await response.json().catch(() => null) as Envelope | null
      } catch { throw new KieSubmissionUnknown() }
      if (response.ok && body?.code === 200 && taskIdValid(body.data?.taskId)) {
        return { requestId: body.data.taskId, meta: input.meta }
      }
      // 只对明确拒收的限流重试；不记录供应商原文，避免其回显密钥或签名媒体地址。
      const code = body?.code ?? response.status
      if ([401, 402, 403, 404, 422, 429, 433, 455, 505].includes(code)) {
        throw new VideoProviderError(`kie_${code}`, `KIE rejected submission (${code})`, code === 429)
      }
      throw new KieSubmissionUnknown()
    },
    async status(requestId, meta): Promise<VideoStatus> {
      const auth = headers()
      const config = kieConfigFromMeta(meta)
      if (!taskIdValid(requestId)) throw new VideoProviderError('kie_task_invalid', 'Invalid KIE task id', false)
      let response: Response
      let body: Envelope | null
      try {
        response = await fetch(`${BASE}/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(requestId)}`, { headers: auth, signal: AbortSignal.timeout(30_000), redirect: 'error' })
        body = await response.json().catch(() => null) as Envelope | null
      } catch { throw new VideoProviderError('kie_poll_network', 'KIE task query unavailable', true) }
      if (!response.ok || body?.code !== 200 || !body.data) {
        const code = body?.code ?? response.status
        throw new VideoProviderError(`kie_${code}`, `KIE task query failed (${code})`, ![401, 402, 403, 422, 433].includes(code))
      }
      const data = body.data
      if (data.taskId !== requestId || data.model !== config.model) throw new VideoProviderError('kie_task_mismatch', 'KIE returned a different task or model', true)
      if (data.state === 'fail') return { state: 'failed', code: 'kie_generation_failed', message: 'KIE generation failed' }
      if (data.state !== 'success') return { state: 'pending' }
      let result = data.response as { resultUrls?: unknown[] } | undefined
      if (!result?.resultUrls && typeof data.resultJson === 'string') {
        try { result = JSON.parse(data.resultJson) } catch { /* 下方统一报告缺失 */ }
      }
      const url = result?.resultUrls?.[0]
      if (typeof url !== 'string' || !safeOutputUrl(url)) return { state: 'failed', code: 'kie_output_invalid', message: 'KIE output URL missing or invalid' }
      const credits = data.creditsConsumed
      const seconds = meta.durationSeconds
      if (!(typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) &&
          !(typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0)) {
        throw new VideoProviderError('kie_duration_missing', 'KIE cost snapshot duration missing', true)
      }
      return {
        state: 'completed', output: { url },
        // 供应商未提供实际费用时使用任务创建时的成本估算，不受后台后续改价影响。
        costCents: typeof credits === 'number' && Number.isFinite(credits) && credits >= 0
          ? Math.round(credits * config.creditPriceCents)
          : Math.round((seconds as number) * config.costCentsPerSecond),
      }
    },
    costCents: (seconds) => Math.round(seconds * site.video.kie.costCentsPerSecond),
  }
}

function safeOutputUrl(value: string) {
  try {
    const url = new URL(value)
    // 只接受 KIE 的产物域名；拒绝任意内网/自定义目标。新增供应商 CDN 时先核对其来源。
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['redpandaai.co', 'aiquickdraw.com', 'kie.ai'].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
  } catch { return false }
}
