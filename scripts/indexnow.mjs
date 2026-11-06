#!/usr/bin/env node
// 手动补推指定 --url（可重复）或 --all；部署用 --snapshot / --since 比较公开内容。
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { parseArgs } from 'node:util'
import { site } from '../src/config/site.ts'

const decode = value => value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
const attr = (tag, name) => decode(tag.match(new RegExp(`\\s${name}=(["'])([\\s\\S]*?)\\1`, 'i'))?.[2] ?? '')

// 排除 nonce、水合数据、脚本和样式文件名，避免无内容变化的构建触发整站提交。
export function fingerprint(html) {
  const schemas = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter(match => attr(' ' + match[1], 'type') === 'application/ld+json')
    .map(match => JSON.stringify(JSON.parse(match[2])))
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(([tag]) => [attr(tag, 'name') || attr(tag, 'property'), attr(tag, 'content')])
    .filter(([name]) => /^(description|robots|og:|twitter:)/.test(name)).sort()
  const links = [...html.matchAll(/<(?:a|link|img|video|source)\b[^>]*>/gi)]
    .filter(([tag]) => !/^<link/i.test(tag) || /^(canonical|alternate)$/.test(attr(tag, 'rel')))
    .map(([tag]) => [attr(tag, 'href'), attr(tag, 'src'), attr(tag, 'poster'), attr(tag, 'alt'), attr(tag, 'hreflang')])
  const text = decode(html.replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(JSON.stringify({ text, meta, links, schemas })).digest('hex')
}

export function canonicalUrl(value, origin) {
  const url = new URL(value, origin)
  if (url.origin !== origin || url.search || url.hash || url.username || url.password) throw new Error(`拒绝非本站规范 URL: ${value}`)
  return url.href
}

async function get(url) {
  const response = await fetch(url, { redirect: 'manual', headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) })
  if (response.status !== 200) throw new Error(`读取 ${url} 失败: HTTP ${response.status}`)
  return response.text()
}

export async function snapshot(origin, requested) {
  const xml = await get(`${origin}/sitemap.xml`)
  const sitemapUrls = [...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => canonicalUrl(decode(match[1]), origin)))]
  if (!sitemapUrls.length) throw new Error('sitemap 没有可提交的 URL')
  const urls = requested ? [...new Set(requested.map(url => canonicalUrl(url, origin)))].sort() : sitemapUrls
  for (const url of urls) if (!sitemapUrls.includes(url)) throw new Error(`URL 不在当前公开 sitemap 中: ${url}`)
  const pages = {}
  for (let i = 0; i < urls.length; i += 4) {
    await Promise.all(urls.slice(i, i + 4).map(async url => {
      const html = await get(url)
      const canonical = [...html.matchAll(/<link\b[^>]*>/gi)].find(([tag]) => attr(tag, 'rel') === 'canonical')
      if (!canonical || canonicalUrl(attr(canonical[0], 'href'), origin) !== url) throw new Error(`canonical 不匹配: ${url}`)
      if ([...html.matchAll(/<meta\b[^>]*>/gi)].some(([tag]) => /^(robots|bingbot)$/i.test(attr(tag, 'name')) && /noindex/i.test(attr(tag, 'content')))) throw new Error(`sitemap 含 noindex 页面: ${url}`)
      pages[url] = fingerprint(html)
    }))
  }
  return { version: 1, origin, capturedAt: new Date().toISOString(), pages }
}

export function changedUrls(before, after) {
  if (before.version !== 1 || before.origin !== after.origin || !before.pages || Array.isArray(before.pages) || Object.values(before.pages).some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('基线格式或域名不符')
  return Object.keys(after.pages).filter(url => before.pages[url] !== after.pages[url]).sort()
}

async function save(path, data) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(data, null, 2) + '\n')
}

export async function submitUrls(origin, key, urls, fetcher = fetch) {
  if (!urls.length) return { status: 'skipped', urls: [] }
  urls = [...new Set(urls.map(url => canonicalUrl(url, origin)))]
  if (urls.length > 10000) throw new Error('单次提交超过 10000 个 URL')
  if (!/^[A-Za-z0-9-]{8,128}$/.test(key)) throw new Error('IndexNow key 格式不合法')
  const keyLocation = `${origin}/${key}.txt`
  const keyFile = await fetcher(keyLocation, { redirect: 'manual', signal: AbortSignal.timeout(30000) })
  if (keyFile.status !== 200 || (await keyFile.text()).trim() !== key) throw new Error('IndexNow 验证文件不可访问或内容不符')
  const response = await fetcher('https://api.indexnow.org/indexnow', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, signal: AbortSignal.timeout(30000),
    body: JSON.stringify({ host: new URL(origin).host, key, keyLocation, urlList: urls }),
  })
  const result = { submittedAt: new Date().toISOString(), status: response.status, body: await response.text(), urls }
  if (![200, 202].includes(response.status)) throw new Error(`IndexNow 提交失败: HTTP ${response.status} ${result.body}`)
  return result
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    submit: { type: 'boolean' }, all: { type: 'boolean' }, url: { type: 'string', multiple: true },
    snapshot: { type: 'string' }, since: { type: 'string' }, out: { type: 'string' },
  } })
  if (!site.domain || site.domain === 'example.com') throw new Error('请先配置正式域名')
  const origin = `https://${site.domain}`
  const modes = [values.snapshot, values.since, values.all, values.url?.length].filter(Boolean).length
  if (modes > 1 || (values.snapshot && values.submit)) throw new Error('snapshot / since / all / url 只能选一种模式；snapshot 不提交')
  if (values.submit && modes !== 1) throw new Error('提交必须指定 --url、--since 或首次使用的 --all，不默认推送整站')
  const current = await snapshot(origin, values.url)
  if (values.snapshot) {
    await save(values.snapshot, current)
    console.log(`已保存 ${Object.keys(current.pages).length} 页内容基线: ${values.snapshot}`)
    return
  }
  const urls = values.since ? changedUrls(JSON.parse(await readFile(values.since, 'utf8')), current)
    : values.url ? [...new Set(values.url.map(url => canonicalUrl(url, origin)))].sort() : Object.keys(current.pages).sort()
  for (const url of urls) if (!(url in current.pages)) throw new Error(`URL 不在当前公开 sitemap 中: ${url}`)
  console.log(`${urls.length} URLs\n${urls.join('\n')}`)
  const out = values.out ?? '.tmp/indexnow/latest.json'
  if (!values.submit) {
    // 预览不覆盖先前受理记录。
    await save(out + '.preview.json', { mode: 'preview', urls })
    console.log('仅预览，未提交；加 --submit 才发送')
    return
  }
  const selected = Object.fromEntries(urls.map(url => [url, current.pages[url]]))
  let previous
  try { previous = JSON.parse(await readFile(out, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (previous?.origin === origin && [200, 202].includes(previous.status) && JSON.stringify(previous.pages) === JSON.stringify(selected)) {
    console.log('相同页面内容已有受理记录，跳过重复提交')
    return
  }
  const result = await submitUrls(origin, site.seo.indexNowKey, urls)
  await save(out, { origin, ...result, pages: selected })
  console.log(result.status === 'skipped' ? '没有新增或变更页面，未发送请求' : `IndexNow → HTTP ${result.status}（接口受理，不代表后台显示或收录）`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
