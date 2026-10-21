# Cloudflare 发布

目标账号 `cacceff607775c81f667b7a951d4639f`，统一 Worker `brclio-pay-unified`。现有域名 `pay.bornforthis.cn` 使用 Pages 项目 `brclio-pay-aiyuechuang` 的服务绑定；保留现有外部 DNS，不修改根域名 nameserver。

## 发布顺序

1. `npm ci`，`npm run check`，`npm run test:runtime`，`npm run test:security-runtime`，`npm run test:migration`。
2. 先依 [migration.md](migration.md) dry-run，准备独立 Worker 与回退备份；最终切换前先冻结旧入口新单和自动发布，再以对应 digest 迁移。检查源 revision、目标私有属性、逐文件 SHA-256、订单和已付金额、平台凭据、待处理订单和通知。
3. 准备被 Git 忽略的服务端运行配置，保留支付宝原 CHECKOUT_SECRET、平台 API/Webhook 密钥与管理员认证参数；微信使用原商户配置。不要运行旧项目初始化脚本生成替代凭据。GitHub 使用指定 App 安装凭据，不复制全账号 OAuth token。
4. 首次初始化用 `node scripts/deploy-runtime.mjs secrets/runtime-vars.json` 写入已审阅的服务端 Text 参数并发布；现网日常更新用 `npm run deploy`。后者使用 `keep_vars=true` 和空 `vars`，保留全部控制台变量，避免把源码默认开关或地址覆盖到线上。核验 workers.dev 健康和签名历史查询。
5. 最终切换窗口内冻结旧自动发布和新单，复查源 revision 与队列。若前面已向暂存目标写入迁移数据，必须确认源未变化；发现变化则停止切换并核对，不能强行覆盖目标。
6. `npm run deploy:pages` 将现有域名入口绑定统一 Worker。仅在统一服务准备完成后切入口，保留原支付宝 Worker `brclio-pay` 作为回退。
7. `node scripts/deployment-preflight.mjs` 核验统一 Worker 和域名上的版本、健康、静态文件哈希和匿名拒绝边界。额外验证三 Skills 下载、签名目录/历史查询、管理员报表和微信上游签名查单。

旧支付宝仓库的自动发布会覆盖旧 Pages 项目绑定；本次切换移除了旧触发器，备份配置保存在忽略目录。未来只从新项目发布。不要继续从旧项目运行 `deploy:all`。回退前必须核对目标是否已产生新订单，禁止把新账本丢弃。

## 核验层次

分别记录：代码检查、迁移完整性、Worker部署版本、Pages入口部署、域名HTTPS、真实预下单/查单/关单、真实到账、产品权益开通。只有用户实际支付并在业务系统确认权益后，才可声称完整资金履约链路验收。

微信兼容入口 `paywc.bornforthis.cn` 的 Pages 项目 `brclio-wechatpay` 同样绑定统一 Worker；执行 `npm run deploy:wechat-gateway` 更新。旧请求、checkout token和通知协议通过适配层使用同一新账本；不要直接恢复旧微信服务造成分叉。

源码仓库为 `Brclio/Brclio-Pay`。发布使用本机已授权的 Cloudflare CLI，运行 `npm run deploy:all` 更新统一 Worker 与两个 Pages 入口。当前 GitHub OAuth 授权不含 workflow 权限，因此没有配置 GitHub Actions 自动部署，也不在源码仓库存放闲置部署 Token。日常 Worker 脚本不携带任何运行变量值；保持全部控制台 Text 配置。不要绕过脚本直接发布带显式 `vars` 的默认配置。

环境变量说明独立存储于私有数据仓库 `maintenance/environment/guide.json`，由 `GET /api/admin/environment` 鉴权读取。`scripts/sync-environment-guide.mjs` 默认只读，审阅后携带仓库版本和文档摘要同步；它不会把运行变量复制到说明中。发布后核对账单分渠道合计、历史订单覆盖、说明来源及当前所有 Text 值的哈希连续性。
