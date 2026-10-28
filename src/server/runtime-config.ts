import { sellingPlans, site } from '#/config/site'
import { REQUIRED_BINDINGS, checkConfig } from './config-health'
import { kieConfigProblems, type KieConfig } from '#/config/kie'

// 运行时配置检查：与部署前的 npm run doctor 同一套规则，按实际 env 检查（含 SESSION_SECRET 强度），只返回问题，不返回值。
// paymentProvider 是后台“收款渠道”的覆盖值，按实际生效的支付商检查
export function configIssues(env: Env, paymentProvider?: string, kieConfig: KieConfig = site.video.kie) {
  const record = env as unknown as Record<string, unknown>
  const strings = Object.fromEntries(Object.entries(record).filter(([, v]) => typeof v === 'string')) as Record<string, string>
  const issues = checkConfig({
    vars: paymentProvider ? { ...strings, PAYMENT_PROVIDER: paymentProvider } : strings,
    secrets: strings,
    bindings: REQUIRED_BINDINGS.filter((name) => record[name] != null),
    packageIds: site.packages.map((p) => p.id),
    planIds: sellingPlans.map((p) => p.id),
    siteDomain: site.domain,
  })
  if (env.VIDEO_PROVIDER === 'kie') {
    issues.push(...kieConfigProblems(kieConfig).map((message) => ({ level: 'error' as const, key: 'site.video.kie', message })))
    for (const style of site.styles) if (style.scene) issues.push({ level: 'error', key: `styles.${style.id}`, message: 'KIE Wan 不支持 yir 两步场景合成' })
  }
  return issues
}

// 后台切换收款渠道前的检查：只看这个支付商自己的错误（密钥、商品 ID、店铺 ID、Key 模式等）
export function paymentProviderProblems(env: Env, id: string) {
  const prefix = `${id.toUpperCase()}_`
  return configIssues(env, id)
    .filter((issue) => issue.level === 'error' && (issue.key === 'PAYMENT_PROVIDER' || issue.key.startsWith(prefix)))
    .map((issue) => issue.message)
}
