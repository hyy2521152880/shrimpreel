#!/usr/bin/env node
// 只读核对模型目录、OpenAPI、报价和余额；不会提交生成。凭据由进程环境或 Node --env-file 提供。
import { pathToFileURL } from 'node:url'
import { site } from '../src/config/site.ts'
import { kieRecipe } from '../src/config/kie.ts'

export function validateKieSchema(doc, model, resolution) {
  const resolve = (value) => {
    for (let depth = 0; value?.$ref && depth < 12; depth++) {
      if (!value.$ref.startsWith('#/')) throw new Error('schema 含无法核对的外部引用')
      value = value.$ref.slice(2).split('/').reduce((node, part) => node?.[decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')], doc)
    }
    return value
  }
  const operation = doc?.paths?.['/api/v1/jobs/createTask']?.post
  const body = resolve(resolve(operation?.requestBody)?.content?.['application/json']?.schema)
  const input = resolve(body?.properties?.input)
  if (!input?.properties?.image_url || !input.properties.video_url) throw new Error('schema 不符合一张照片 + 参考视频接口，请重新适配')
  const allowedModel = resolve(body.properties.model)?.enum
  if (!allowedModel?.includes(model)) throw new Error('schema 不包含选择的模型')
  const resolutions = resolve(input.properties.resolution)?.enum
  if (!resolutions?.includes(resolution)) throw new Error('schema 不支持当前分辨率')
  if ((body.required ?? []).some((key) => !['model', 'input', 'callBackUrl'].includes(key)) ||
      (input.required ?? []).some((key) => !['image_url', 'video_url', 'resolution'].includes(key))) {
    throw new Error('schema 新增了必填参数，请先更新适配器')
  }
}

export async function checkKie({ key, model = site.video.kie.model, resolution = site.video.kie.resolution, request = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  if (!key?.trim()) throw new Error('缺少独立 KIE_API_KEY；没有发起网络请求')
  if (!kieRecipe(model)) throw new Error('选择的模型尚未适配')
  const get = async (path) => {
    let response
    try {
      response = await request(`https://api.kie.ai${path}`, { headers: { Authorization: `Bearer ${key.trim()}` }, signal: AbortSignal.timeout(20_000), redirect: 'error' })
    } catch { throw new Error('KIE 网络查询失败') }
    const body = await response.json().catch(() => null)
    if (!response.ok || body?.code !== 200) throw new Error(`KIE 查询失败（HTTP ${response.status}，业务状态 ${typeof body?.code === 'number' ? body.code : '未知'}）`)
    return body.data
  }
  const catalog = await get('/api/v1/models')
  if (!catalog?.models?.some((item) => item.model === model)) throw new Error('当前 KIE 目录没有该模型，请勿开放生成')
  await wait(1100)
  const schema = await get(`/api/v1/models/${model}/schema`)
  validateKieSchema(schema?.openapi, model, resolution)
  await wait(1100)
  const price = await get(`/api/v1/models/${model}/price`)
  const balance = await get('/api/v1/chat/credit')
  if (typeof balance !== 'number' || !Number.isFinite(balance)) throw new Error('KIE 余额格式无法识别')
  return { model, resolution, pricing: String(price?.pricingDesc ?? '未返回报价').split(key.trim()).join('***'), balanceCredits: balance, generated: false }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkKie({ key: process.env.KIE_API_KEY }), null, 2)) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
