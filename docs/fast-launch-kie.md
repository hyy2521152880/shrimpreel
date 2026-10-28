# KIE 视频新词站快速启动

这份母模板保留 ShrimpReel 的 Workers + D1 + R2 + KV + Queues 架构，登录、收款、积分、订单和生成队列继续复用。每个新站独立克隆、创建资源及凭据；用 Git merge 同步母模板更新，不复制 `.dev.vars*`、`.env*` 或本地数据库。

## 一次初始化

在新站的干净克隆中运行（默认只预览，加 `--write` 写入）：

```sh
npm run site:new -- --keyword "Moon Hop" --domain moonhop.ai --admin-email owner@moonhop.ai --kie-model wan/2-2-animate-replace --resolution 480p --cost-cents-per-second 6
```

上面的 6 美分/秒只是参数示例，不是当前报价。先查报价再填写。默认选择 KIE 和 Stripe 测试环境；可通过 `--payment-provider dodo|waffo|stripe`、`--video-provider kie|fal|yir|nanoapi` 改变。初始化会重置 OAuth、统计、管理员、支付商品、D1/KV ID 和域名路由，并为 R2/队列重新命名。检测到本地凭据文件时拒绝写入。

## 内容与玩法

- 品牌、参考视频、时长和扣积分：`src/config/site.ts`。
- 页面文案：`src/content/en.ts`、`zh.ts`；重写对应搜索意图的内容，不只替换关键词。
- 示例图片/成片：`public/demo/`；生成用参考视频：`seed/templates/`，每个风格和时长都有独立文件。使用自有或已授权素材，并先验证真实成片效果。
- `/admin/settings` 可修改 KIE 玩法、分辨率和每秒估算成本，约 60 秒生效，只影响新任务。默认成本 0 表示未确认，拒绝新生成；每次重新部署前还需同步 `site.video.kie` 的默认值供离线检查。
- 网站向用户扣多少积分仍来自 `site.durations`；套餐价格来自 `site.packages/plans`，需与支付商商品一致。KIE 成本不是用户售价。

| KIE 玩法 | 分辨率 | 图片上限 | 参考视频上限 |
| --- | --- | --- | --- |
| `wan/2-2-animate-replace` 人物替换 | 480p / 580p / 720p | 10 MB | 10 MB |
| `wan/2-2-animate-move` 动作迁移 | 720p | 5 MB | 100 MB |

参数按 2026-10-29 官方公开 OpenAPI 适配。Wan 这两个接口不接受提示词，也不支持 `styles[].scene` 的 yir 两步场景流程；不能只改模型名就启用未适配的模型。时长、原声及人物一致性须用本站素材验收。

## 必须配置的外部项

1. 独立 Cloudflare Worker、D1、R2、KV、主队列和死信队列；按初始化输出创建并填回资源 ID，应用数据库迁移，上传参考视频到 R2。
2. 独立 Google OAuth Client；授权回调 `https://域名/api/auth/google/callback`，填写 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`。
3. 独立 `KIE_API_KEY` 和随机 `SESSION_SECRET`；密钥放 Cloudflare Secrets，不写入站点源码或后台数据库。
4. Stripe / Dodo / Waffo 的本站商品、密钥和 webhook；用已有的 `scripts/<provider>-setup.mjs` 初始化，真实收款前将商品、密钥和环境一起切换到正式模式。
5. 发信域名、图片审核、Turnstile 和统计按本站需要配置；详细变量见 `docs/env.md`。

只读核对 KIE（需要独立 Key，不提交生成、不扣生成费用）：

```sh
node --env-file=.dev.vars.production scripts/check-kie.mjs
```

它查询当前账号的模型目录、schema、报价和余额，遇到模型下线、分辨率不支持或新增必填参数会停止。后台“视频生成 → 测试连接”检查配置、鉴权和余额；不代表真实成片验收。

## 失败与费用

- HTTP 200 仍检查 KIE 业务状态码；无 Key 不请求、不回退其它服务商。
- 每个任务保存模型、分辨率和成本快照，后台改配置不改变排队中的旧任务。完成时把成片转存到本站 R2，实际费用优先按 KIE 消耗积分换算；换算率 `creditPriceCents` 按自己的采购价设置。
- 只有明确拒收的 429 可以自动重提。提交超时、断网、5xx 或接收成功后落库失败时，保留处理中状态，绝不自动重复创建任务。
- 带任务 token 的回调会向 KIE 重新查证任务归属后恢复 taskId；不信任回调中的结果 URL。回调也丢失时，45 分钟后失败并原路退积分，可能存在已发生但尚未核对的供应商费用，需在 KIE 后台查证。

## 上线验收

模板检查与真实服务分开：相关单元/账务测试、后台保存与生成流程的本地测试、一次 Workers 构建；`npm run doctor` 检查配置、参考素材和迁移。上线后验证本站 Google 登录、支付到账、真实生成/R2 下载和失败处理，再检查 SEO 输出。

本轮没有真实 KIE Key 或付费测试授权；真实成片效果、实际成本、线上回调和生产部署不属于已验证结果。
