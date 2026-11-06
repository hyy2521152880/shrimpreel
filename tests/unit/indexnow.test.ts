import { describe, expect, it, vi } from 'vitest'
import { canonicalUrl, changedUrls, fingerprint, submitUrls } from '../../scripts/indexnow.mjs'
import { deploy } from '../../scripts/deploy.mjs'

const origin = 'https://example.org'
const key = 'example-key-1234'
const page = (description = 'Create a video', nonce = 'first') => `<html><head><title>Video</title><meta name="description" content="${description}"><link rel="stylesheet" href="/assets/${nonce}.css"><script nonce="${nonce}" src="/assets/${nonce}.js"></script><script type="application/ld+json" nonce="${nonce}">{"@type":"WebSite"}</script></head><body><h1>Make videos</h1><a href="/pricing">Pricing</a><img src="/sample.jpg" alt="Example"><script>window.state="${nonce}"</script></body></html>`

describe('IndexNow 增量提交', () => {
  it('忽略打包哈希、nonce、水合数据，但识别摘要、正文、链接和媒体变化', () => {
    const hash = fingerprint(page())
    expect(fingerprint(page('Create a video', 'second'))).toBe(hash)
    for (const html of [page('Updated description'), page().replace('Make videos', 'Make duets'), page().replace('/pricing', '/plans'), page().replace('/sample.jpg', '/new.jpg'), page().replace('WebSite', 'Article')]) expect(fingerprint(html)).not.toBe(hash)
    expect(fingerprint(page("It's free"))).not.toBe(fingerprint(page("It's paid")))
  })
  it('只选新增和内容变化页，无改动不提交，删除页不混入新增清单', () => {
    const a = fingerprint(page()), b = fingerprint(page('New'))
    const before = { version: 1, origin, pages: { '/': a, '/same': a, '/removed': a } }
    const after = { version: 1, origin, pages: { '/': b, '/same': a, '/added': a } }
    expect(changedUrls(before, after)).toEqual(['/', '/added'])
    expect(changedUrls(after, after)).toEqual([])
    expect(() => changedUrls({ ...before, origin: 'https://other.org' }, after)).toThrow()
  })
  it('拒绝其他站、查询参数和锚点 URL', () => {
    expect(canonicalUrl('/', origin)).toBe(origin + '/')
    for (const url of ['https://other.org/', '/?token=private', '/#sample', 'https://user:pass@example.org/']) expect(() => canonicalUrl(url, origin)).toThrow()
  })
  it('空清单不发送；key 不符时不 POST', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('wrong'))
    expect((await submitUrls(origin, key, [], fetcher)).status).toBe('skipped')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(submitUrls(origin, key, [origin], fetcher)).rejects.toThrow('验证文件')
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it.each([200, 202, 403, 429, 500])('正确处理接口 HTTP %i，无自动重试', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(key)).mockResolvedValueOnce(new Response('', { status }))
    const result = submitUrls(origin, key, [origin, origin + '/'], fetcher)
    if ([200, 202].includes(status)) expect((await result).status).toBe(status)
    else await expect(result).rejects.toThrow(`HTTP ${status}`)
    expect(fetcher).toHaveBeenCalledTimes(2)
    const payload = JSON.parse(fetcher.mock.calls[1]![1]!.body as string)
    expect(payload).toEqual({ host: 'example.org', key, keyLocation: `${origin}/${key}.txt`, urlList: [origin + '/'] })
  })
  it('发布失败不提交，未配置 key 不读取线上基线', () => {
    const calls: string[] = []
    expect(() => deploy({ npm: 'npm-cli.js', hasKey: true, release: 'release', execute: (_file, args) => {
      calls.push(args.join(' '))
      if (args.includes('wrangler')) throw new Error('deployment failed')
    }, log: () => {} })).toThrow('deployment failed')
    expect(calls.some(call => call.includes('--snapshot'))).toBe(true)
    expect(calls.some(call => call.includes('--submit'))).toBe(false)
    const execute = vi.fn()
    deploy({ npm: 'npm-cli.js', hasKey: false, release: 'release', execute, log: () => {} })
    expect(execute.mock.calls.some(([, args]) => args.includes('--snapshot') || args.includes('--submit'))).toBe(false)
  })
  it('成功发布后才推送，提交失败留下仅补推命令且不重复部署', () => {
    const calls: string[][] = [], messages: string[] = []
    expect(() => deploy({ npm: 'npm-cli.js', hasKey: true, release: 'release', execute: (_file, args) => {
      calls.push(args)
      if (args.includes('--submit')) throw new Error('submission failed')
    }, log: message => messages.push(message) })).toThrow('submission failed')
    expect(calls.filter(args => args.includes('wrangler'))).toHaveLength(1)
    expect(calls.at(-1)).toEqual(['--since', 'release/before.json', '--submit', '--out', 'release/submission.json'])
    expect(messages.some(message => message.includes('补推命令:'))).toBe(true)
  })
})
