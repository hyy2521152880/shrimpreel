// 参数依据 KIE 官方公开 OpenAPI（2026-10-29）。上线前仍需 kie:check 核对当前账号的目录、schema 和报价。
export const KIE_RECIPES = {
  'wan/2-2-animate-replace': {
    label: '人物替换（Wan Animate Replace）',
    resolutions: ['480p', '580p', '720p'],
    imageMaxBytes: 10_000_000,
    videoMaxBytes: 10_000_000,
  },
  'wan/2-2-animate-move': {
    label: '动作迁移（Wan Animate Move）',
    resolutions: ['720p'],
    imageMaxBytes: 5_000_000,
    videoMaxBytes: 100_000_000,
  },
} as const

export interface KieConfig {
  model: string
  resolution: string
  costCentsPerSecond: number
  creditPriceCents: number
}

export function kieRecipe(model: string) {
  return Object.hasOwn(KIE_RECIPES, model) ? KIE_RECIPES[model as keyof typeof KIE_RECIPES] : undefined
}

export function kieConfigProblems(config: KieConfig): string[] {
  const recipe = kieRecipe(config.model)
  const problems: string[] = []
  if (!recipe) problems.push('请选择已经适配的 KIE 玩法')
  else if (!(recipe.resolutions as readonly string[]).includes(config.resolution)) problems.push(`${recipe.label} 只支持 ${recipe.resolutions.join('、')}`)
  if (!Number.isFinite(config.costCentsPerSecond) || config.costCentsPerSecond <= 0) problems.push('请先根据当前报价填写 KIE 每秒成本（美分），0 表示尚未确认')
  if (!Number.isFinite(config.creditPriceCents) || config.creditPriceCents <= 0) problems.push('KIE 积分的美分换算必须大于 0')
  return problems
}
