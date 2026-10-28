import ts from 'typescript'

// 只在派生新站时使用：站点身份和资源必须重新绑定，不能继承母站的账号、商品或路由。
export function resetLaunchConfig(source, { domain, name, payment = 'stripe', video = 'kie', adminEmail = '' }) {
  if (!['stripe', 'waffo', 'dodo'].includes(payment)) throw new Error('payment-provider 只能是 stripe、waffo 或 dodo')
  if (!['kie', 'fal', 'yir', 'nanoapi'].includes(video)) throw new Error('video-provider 只能是 kie、fal、yir 或 nanoapi')
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('name 必须是 1–63 位小写字母、数字或短横线')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error('domain 必须是正式域名')
  const parsed = ts.parseConfigFileTextToJson('wrangler.jsonc', source)
  if (parsed.error) throw new Error('wrangler.jsonc 无法解析')
  const config = parsed.config
  delete config.account_id
  delete config.env
  delete config.route
  config.name = name
  config.routes = [{ pattern: domain, custom_domain: true }]
  config.workers_dev = false
  config.preview_urls = false
  config.vars = {
    APP_ENV: 'production', SITE_URL: `https://${domain}`,
    PAYMENT_PROVIDER: payment, VIDEO_PROVIDER: video,
    ADMIN_EMAILS: adminEmail, EMAIL_FROM: `noreply@${domain}`,
    WAFFO_ENVIRONMENT: 'test', WAFFO_STORE_ID: '', WAFFO_PRODUCTS: '{}',
    DODO_ENVIRONMENT: 'test', DODO_PRODUCTS: '{}', STRIPE_ENVIRONMENT: 'test', STRIPE_PRODUCTS: '{}',
    GOOGLE_CLIENT_ID: '', TURNSTILE_SITE_KEY: '', UMAMI_ORIGIN: '', MODERATION_PROVIDER: 'openai',
  }
  config.d1_databases = [{ binding: 'DB', database_name: name, database_id: '00000000-0000-0000-0000-000000000000', migrations_dir: 'migrations' }]
  config.r2_buckets = [{ binding: 'MEDIA', bucket_name: `${name}-media` }]
  config.kv_namespaces = [{ binding: 'KV', id: '00000000000000000000000000000000' }]
  config.send_email = [{ name: 'EMAIL' }]
  config.queues.producers = [{ binding: 'VIDEO_QUEUE', queue: `${name}-jobs` }]
  config.queues.consumers = [
    { queue: `${name}-jobs`, max_batch_size: 5, max_batch_timeout: 2, max_retries: 10, dead_letter_queue: `${name}-jobs-dlq` },
    { queue: `${name}-jobs-dlq`, max_batch_size: 10, max_batch_timeout: 5, max_retries: 3 },
  ]
  // 自定义绑定也可能指向旧产品，发现时阻止，而不是静默带入新站。
  const sharedResources = ['hyperdrive', 'services', 'durable_objects', 'workflows', 'vectorize', 'ai', 'mtls_certificates', 'dispatch_namespaces', 'pipelines', 'unsafe', 'secrets_store_secrets']
  for (const key of sharedResources) if (config[key]) throw new Error(`新站初始化不复制 ${key}，请先为它定义独立资源`)
  return `${JSON.stringify(config, null, 2)}\n`
}
