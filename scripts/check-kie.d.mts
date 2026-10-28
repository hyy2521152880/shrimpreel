export function validateKieSchema(doc: unknown, model: string, resolution: string): void
export function checkKie(options: {
  key: string | undefined
  model?: string
  resolution?: string
  request?: (url: string, init: RequestInit) => Promise<Response>
  wait?: (ms: number) => Promise<void>
}): Promise<{ model: string; resolution: string; pricing: string; balanceCredits: number; generated: false }>
