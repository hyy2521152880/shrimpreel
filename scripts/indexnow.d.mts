type Snapshot = { version: number; origin: string; capturedAt?: string; pages: Record<string, string> }
export function fingerprint(html: string): string
export function canonicalUrl(value: string, origin: string): string
export function changedUrls(before: Snapshot, after: Snapshot): string[]
export function snapshot(origin: string, requested?: string[]): Promise<Snapshot>
export function submitUrls(origin: string, key: string, urls: string[], fetcher?: typeof fetch): Promise<{ status: number | string; urls: string[] }>
export function main(args?: string[]): Promise<void>
