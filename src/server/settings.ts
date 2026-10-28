import type { Hono } from 'hono'
import { LOCALES, LOCALE_META, site, type Locale } from '#/config/site'
import { KIE_RECIPES, kieConfigProblems, type KieConfig } from '#/config/kie'
import { audit, readJson, requireAdmin } from './http'
import { paymentProviderProblems } from './runtime-config'
import type { AppContext, UserRow } from './types'
import { ApiError, nowIso } from './util'

// 后台运营参数：只放非敏感、不改代码就要能调的参数；密钥仍放 wrangler secrets，不进数据库。
// 存在 D1 的 settings 表，读取走 KV 缓存（cacheTtl 60 秒），保存后最多约 60 秒在各地生效。
// 没有存值、存值不合法或字段已删除时用 site.ts 的默认值；保存的值等于默认值时删掉那一行，以后改 site.ts 仍然生效。

export type RuntimeSettings = {
  kieModel: string
  kieResolution: string
  kieCostCentsPerSecond: number
  maintenance: boolean
  checkoutPaused: boolean
  paymentProvider: string
  signupBonusCredits: number
  signupBonusValidDays: number
  referralRewardCredits: number
  generationDailyCap: number
} & Record<`announcement.${Locale}`, string>

export type SettingKey = keyof RuntimeSettings

type FieldBase = { key: SettingKey; label: string; help: string }
export type SettingField =
  | (FieldBase & { kind: 'bool' })
  | (FieldBase & { kind: 'int'; min: number; max: number })
  | (FieldBase & { kind: 'text'; maxLength: number })
  | (FieldBase & { kind: 'select'; options: Array<{ value: string; label: string }> })

const referralOn = site.referralRewardCredits > 0

export const SETTING_FIELDS: readonly SettingField[] = [
  {
    key: 'kieModel', kind: 'select', label: 'KIE 视频玩法',
    help: '部署 VIDEO_PROVIDER=kie 时生效。只影响新任务；参考视频仍在 site.ts 配置。Wan 不使用提示词，也不支持 yir 两步场景合成。',
    options: Object.entries(KIE_RECIPES).map(([value, recipe]) => ({ value, label: recipe.label })),
  },
  {
    key: 'kieResolution', kind: 'select', label: 'KIE 分辨率',
    help: '动作迁移只支持 720p；人物替换支持 480p、580p、720p。换玩法或分辨率后重新核对成本和真实效果。',
    options: ['480p', '580p', '720p'].map((value) => ({ value, label: value })),
  },
  { key: 'kieCostCentsPerSecond', kind: 'int', min: 0, max: 10000, label: 'KIE 每秒成本（美分）', help: '按当前报价向上取整，供成本估算；0 表示未确认，拒绝新生成。实际费用优先使用 KIE 返回的消耗积分。网站对用户扣多少积分仍由 site.durations 决定。' },
  {
    key: 'maintenance',
    kind: 'bool',
    label: '维护模式',
    help: '暂停新的生成和下单（返回 503），前台每页顶部显示维护提示。登录、查看、下载和支付回调照常；管理员不受限制，便于验证',
  },
  {
    key: 'checkoutPaused',
    kind: 'bool',
    label: '暂停收款',
    help: '支付商还没开通或临时出问题时打开：价格页的购买按钮变成“支付即将开放”，新下单返回 503。生成、已建订单的支付回调照常；管理员不受限制，便于验证',
  },
  {
    key: 'paymentProvider',
    kind: 'select',
    options: [
      { value: '', label: '跟随部署配置（PAYMENT_PROVIDER）' },
      { value: 'waffo', label: 'Waffo' },
      { value: 'dodo', label: 'Dodo Payments' },
      { value: 'stripe', label: 'Stripe' },
    ],
    label: '收款渠道',
    help: '新订单用哪家支付商收款，保存前会检查它的密钥和商品 ID 是否齐全。已有订单的退款、查单和订阅续费、取消仍走原支付商；各家的 webhook 都保持开着',
  },
  ...LOCALES.map(
    (locale): SettingField => ({
      key: `announcement.${locale}`,
      kind: 'text',
      maxLength: 200,
      label: `全站公告（${LOCALE_META[locale].name}）`,
      help: '显示在这个语言每个页面的顶部，纯文本，留空不显示',
    }),
  ),
  { key: 'signupBonusCredits', kind: 'int', min: 0, max: 1000, label: '注册赠送积分', help: '新用户注册时发放，0 = 不送。只影响之后注册的用户' },
  { key: 'signupBonusValidDays', kind: 'int', min: 0, max: 3650, label: '赠送积分有效期（天）', help: '0 = 永不过期' },
  {
    key: 'referralRewardCredits',
    kind: 'int',
    min: 0,
    max: referralOn ? 1000 : 0,
    label: '邀请奖励积分',
    help: referralOn
      ? '好友首单付款后给邀请人发的积分，0 = 暂停邀请（隐藏邀请卡片，链接不再绑定）'
      : 'site.ts 里 referralRewardCredits 为 0，邀请功能已关闭；在 site.ts 开启后才能在这里调整（隐私政策按 site.ts 生成）',
  },
  {
    key: 'generationDailyCap',
    kind: 'int',
    min: 0,
    max: 1_000_000,
    label: '全站每日生成上限',
    help: '每个 UTC 自然日最多创建多少个生成任务（失败退款的也算），0 = 不限。用来封顶服务商费用，超出返回 429',
  },
]

export const DEFAULT_SETTINGS: RuntimeSettings = {
  kieModel: site.video.kie.model,
  kieResolution: site.video.kie.resolution,
  kieCostCentsPerSecond: site.video.kie.costCentsPerSecond,
  maintenance: false,
  checkoutPaused: false,
  paymentProvider: '',
  ...(Object.fromEntries(LOCALES.map((locale) => [`announcement.${locale}`, ''])) as Record<`announcement.${Locale}`, string>),
  signupBonusCredits: site.signupBonusCredits,
  signupBonusValidDays: site.signupBonusValidDays,
  referralRewardCredits: site.referralRewardCredits,
  generationDailyCap: 0,
}

const CACHE_KEY = 'settings:v1'
const fieldOf = (key: string) => SETTING_FIELDS.find((f) => f.key === key)

export function kieConfigFor(settings: RuntimeSettings): KieConfig {
  return { model: settings.kieModel, resolution: settings.kieResolution, costCentsPerSecond: settings.kieCostCentsPerSecond, creditPriceCents: site.video.kie.creditPriceCents }
}

function isValid(field: SettingField, value: unknown) {
  if (field.kind === 'bool') return typeof value === 'boolean'
  if (field.kind === 'int') return Number.isInteger(value) && (value as number) >= field.min && (value as number) <= field.max
  if (field.kind === 'select') return field.options.some((option) => option.value === value)
  return typeof value === 'string' && value.length <= field.maxLength
}

// 存值合并到默认值上：未知字段、类型或范围不对的值（例如 site.ts 收紧了范围）丢弃，用默认值
export function mergeSettings(stored: Record<string, unknown>): RuntimeSettings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS }
  for (const [key, value] of Object.entries(stored)) {
    const field = fieldOf(key)
    if (field && isValid(field, value)) merged[key] = value
  }
  return merged as RuntimeSettings
}

// 后台提交的修改：未知字段或值不合法时整体拒绝（400 invalid_setting，message 说明是哪一项）
export function parseSettingsPatch(input: unknown): Partial<RuntimeSettings> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'invalid_setting', '没有要保存的参数')
  const entries = Object.entries(input as Record<string, unknown>)
  if (entries.length === 0) throw new ApiError(400, 'invalid_setting', '没有要保存的参数')
  const patch: Record<string, unknown> = {}
  for (const [key, raw] of entries) {
    const field = fieldOf(key)
    if (!field) throw new ApiError(400, 'invalid_setting', `未知参数：${key}`)
    // 公告只存一行纯文本
    const value = field.kind === 'text' && typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : raw
    if (!isValid(field, value)) {
      const rule =
        field.kind === 'int'
          ? `${field.min}–${field.max} 的整数`
          : field.kind === 'text'
            ? `不超过 ${field.maxLength} 个字符`
            : field.kind === 'select'
              ? `以下之一：${field.options.map((option) => option.value || '(空)').join('、')}`
              : '开或关'
      throw new ApiError(400, 'invalid_setting', `${field.label}：应为${rule}`)
    }
    patch[key] = value
  }
  return patch as Partial<RuntimeSettings>
}

async function loadStored(db: D1Database) {
  const rows = await db.prepare('SELECT key, value FROM settings').all<{ key: string; value: string }>()
  const stored: Record<string, unknown> = {}
  for (const row of rows.results) {
    try {
      stored[row.key] = JSON.parse(row.value)
    } catch {
      console.warn(`[settings] ignoring malformed value for ${row.key}`)
    }
  }
  return stored
}

export async function getSettings(env: Env): Promise<RuntimeSettings> {
  let stored = await env.KV.get<Record<string, unknown>>(CACHE_KEY, { type: 'json', cacheTtl: 60 })
  if (!stored) {
    stored = await loadStored(env.DB)
    await env.KV.put(CACHE_KEY, JSON.stringify(stored))
  }
  return mergeSettings(stored)
}

// 维护模式下拒绝新的生成和下单；管理员放行，便于维护期间验证
export function assertOpen(settings: RuntimeSettings, user: UserRow) {
  if (settings.maintenance && user.role !== 'admin') throw new ApiError(503, 'maintenance')
}

// 暂停收款时拒绝新的下单；管理员放行
export function assertCheckoutOpen(settings: RuntimeSettings, user: UserRow) {
  assertOpen(settings, user)
  if (settings.checkoutPaused && user.role !== 'admin') throw new ApiError(503, 'checkout_paused')
}

export const referralActive = (settings: RuntimeSettings) => settings.referralRewardCredits > 0

// 全站每日生成上限（UTC 自然日）。预检查只为尽早拒绝；并发提交由 batch 里的断言兜底，超出时整个 batch 回滚
export const utcDayStart = (now: string) => `${now.slice(0, 10)}T00:00:00.000Z`

export async function generationsToday(db: D1Database, now: string) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM generations WHERE created_at >= ?').bind(utcDayStart(now)).first<number>('n')) ?? 0
}

export function dailyCapGuard(db: D1Database, cap: number, now: string) {
  if (cap <= 0) return []
  return [
    db.prepare('INSERT INTO credit_guard (ok) SELECT COUNT(*) <= ? FROM generations WHERE created_at >= ?').bind(cap, utcDayStart(now)),
    db.prepare('DELETE FROM credit_guard'),
  ]
}

// 前台公告条与维护提示（/api/me 下发）
export function publicNotice(settings: RuntimeSettings) {
  return {
    maintenance: settings.maintenance,
    checkoutPaused: settings.checkoutPaused,
    announcement: Object.fromEntries(LOCALES.map((locale) => [locale, settings[`announcement.${locale}`]])) as Record<Locale, string>,
  }
}

// “跟随部署配置”选项显示当前的 PAYMENT_PROVIDER，切换时能看出默认是哪家
const fieldsFor = (env: Env) =>
  SETTING_FIELDS.map((field) =>
    field.kind === 'select' && field.key === 'paymentProvider'
      ? { ...field, options: field.options.map((o) => (o.value ? o : { ...o, label: `跟随部署配置（PAYMENT_PROVIDER=${env.PAYMENT_PROVIDER || '未配置'}）` })) }
      : field,
  )

async function adminView(env: Env) {
  const db = env.DB
  const [values, meta] = await Promise.all([
    loadStored(db),
    db
      .prepare(
        `SELECT s.key, s.updated_at AS updatedAt, u.email AS updatedBy FROM settings s LEFT JOIN users u ON u.id = s.updated_by ORDER BY s.key`,
      )
      .all<{ key: string; updatedAt: string; updatedBy: string | null }>(),
  ])
  return { fields: fieldsFor(env), values: mergeSettings(values), defaults: DEFAULT_SETTINGS, overrides: meta.results }
}

export function registerSettingsAdminRoutes(routes: Hono<AppContext>) {
  // 后台读 D1 原值，不走缓存
  routes.get('/settings', async (c) => c.json(await adminView(c.env)))

  routes.post('/settings', async (c) => {
    const admin = requireAdmin(c)
    const patch = parseSettingsPatch((await readJson<{ values: unknown }>(c)).values)
    // 切换收款渠道：目标支付商的配置不全就拒绝，免得之后所有下单都失败
    if (patch.paymentProvider) {
      const problems = paymentProviderProblems(c.env, patch.paymentProvider)
      if (problems.length) throw new ApiError(400, 'invalid_setting', `收款渠道切换到 ${patch.paymentProvider} 前需要先配好：${problems.join('；')}`)
    }
    const db = c.env.DB
    const before = mergeSettings(await loadStored(db))
    if (['kieModel', 'kieResolution', 'kieCostCentsPerSecond'].some((key) => key in patch)) {
      const config = kieConfigFor({ ...before, ...patch })
      // 成本 0 允许保存，用于主动关闭 KIE 生成；仍验证玩法与分辨率的组合。
      const problems = kieConfigProblems({ ...config, costCentsPerSecond: config.costCentsPerSecond || 1 })
      if (problems.length) throw new ApiError(400, 'invalid_setting', problems.join('；'))
    }
    const now = nowIso()
    const changes: Record<string, { from: unknown; to: unknown }> = {}
    const statements: D1PreparedStatement[] = []
    for (const [key, value] of Object.entries(patch) as [SettingKey, unknown][]) {
      if (before[key] === value) continue
      changes[key] = { from: before[key], to: value }
      statements.push(
        value === DEFAULT_SETTINGS[key]
          ? db.prepare('DELETE FROM settings WHERE key = ?').bind(key)
          : db
              .prepare(
                `INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
              )
              .bind(key, JSON.stringify(value), admin.id, now),
      )
    }
    if (statements.length > 0) {
      await db.batch(statements)
      await c.env.KV.put(CACHE_KEY, JSON.stringify(await loadStored(db)))
      await audit(c.env, admin, 'settings.update', 'settings', 'runtime', changes)
    }
    return c.json(await adminView(c.env))
  })
}
