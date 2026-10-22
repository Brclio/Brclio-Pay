# 自行部署与现网维护

本项目提供两条路径：首次部署自己的支付中心，或维护现有 Brclio 生产服务。首次部署使用 `setup:deployment` 生成独立配置，不修改仓库中既有生产账号、Worker、Pages 项目或 DNS。完整变量用途、生成方式与展示规则见 [环境变量说明](environment-variables.md)。

## 首次部署：准备事项

选择 `providerMode=dual`（支付宝 + 微信）、`alipay`（仅支付宝）或 `wechat`（仅微信）。初始化工具生成正式环境配置，默认关闭收款；只准备所选渠道的正式商户资料，内部签名密钥、管理员认证参数由工具生成。支付宝沙箱使用独立测试部署，不与正式商户配置混用。

| 准备项 | 由谁提供 | 说明 |
| --- | --- | --- |
| Cloudflare 账号与部署授权 | 部署者 | 使用自己的账号；本机运行 `npx wrangler login` 后以 `npx wrangler whoami` 核对账号，用户在浏览器完成授权。[官方登录说明](https://developers.cloudflare.com/workers/wrangler/commands/general/) |
| 支付中心公网 HTTPS 地址 | 部署者 | 可使用自己的 Worker 地址或域名；`PAY_BASE_URL` 不自动创建 DNS。保留已有外部 DNS，域名绑定另行核对。 |
| 独立私有 GitHub 数据仓库 | 部署者 | 先创建有初始提交的分支；保存订单、事件、产品与维护说明的明文 JSON。与公开源码仓库分开。 |
| GitHub App 及该仓库安装授权 | 部署者 | 建立自己的 App，仓库权限 `Contents: Read and write`；安装时只选择此数据仓库，保存 App ID、Installation ID 和 App 私钥文件。[创建 App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)、[安装令牌与仓库范围](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation) |
| 管理员邮箱 | 部署者 | 密码可通过本机文件提供，也可由工具生成。后台维护页需要登录。 |
| 支付宝资料 | 仅 `dual` / `alipay` | AppID、收款 PID、应用私钥、支付宝公钥；所选 `page` / `wap` 产品已获准使用。 |
| 微信资料 | 仅 `dual` / `wechat` | 商户号、已绑定 AppID、商户证书序列号及私钥、APIv3 密钥、微信支付公钥 ID 及公钥。 |

商户资料取得步骤见 [商户配置准备](merchant-setup.md)。商户凭据不能代替 Cloudflare 登录、GitHub 仓库访问或 App 安装授权。公开源码与文档不包含实际运行凭据；部署者登录自己的后台后，可查看公开配置的当前值，并通过单项查看按钮读取默认隐藏的私密部署值。

## 人工部署

在项目根目录安装依赖并完成检查：

```sh
npm ci
npm run check
npm run test:runtime
npm run test:security-runtime
npx wrangler login
npx wrangler whoami
```

复制 [setup-input.example.json](setup-input.example.json) 到被 Git 忽略的 `secrets/setup-input.json`，填写自己的账号、仓库、管理员邮箱、商户标识及凭据文件路径。文件路径相对于该输入 JSON；密钥内容不放进命令行或公开示例。`providerMode` 只能是 `dual`、`alipay`、`wechat`，未选渠道的整个对象必须删除。`cloudflare.pagesProjectName` 仅在需要 Pages 网关时填写，`admin.passwordFile` 可省略。支付宝 `alipay.channels` 只选已签约的渠道，如 `["page"]`；省略时默认 `["page","wap"]`。

```sh
npm run setup:deployment -- --input secrets/setup-input.json --output secrets/setup-generated
```

此步骤只生成本机文件，不发布。输出目录必须是新目录；包含公开运行参数的 `wrangler.json`、敏感绑定的 `worker-secrets.json`、管理员本机登录资料 `admin-login.json`、维护说明种子 `environment-guide.json` 以及 `deployment-plan.json`。文件权限受限，不打印秘密值。检查计划中的目标账号、Worker、GitHub 仓库、渠道和文件摘要；需要修改时用新目录重新生成，不能手改已审阅的部署文件。

确认计划后应用同一份输出：

```sh
npm run setup:deployment -- --deploy --output secrets/setup-generated
```

工具核验文件摘要，以限定该仓库的 GitHub App 安装令牌确认目标为私有仓库及 Contents 读写授权，仅在缺失时初始化 `maintenance/environment/guide.json`，再以同一版本上传 Worker 代码与 Secret。它不会覆盖已有维护说明。新部署默认 `PAYMENT_ENABLED=false`。Cloudflare 控制台不允许读回 Secret 原值，但 Worker 可以读取自己的运行绑定；管理员在维护页可先查看状态、用途及生成方法，再逐项点击查看当前生效值。[Cloudflare Secret 说明](https://developers.cloudflare.com/workers/configuration/secrets/)

需要 Pages 网关且已在输入中填写自己的项目名时，在应用命令追加 `--pages`。网关仅通过服务绑定调用所选 Worker，不携带商户密钥，也不修改 DNS。已有现网不得使用此初始化入口生成替代密钥。

发布后使用自己的地址核对：

```sh
curl -fsS https://YOUR_PAY_HOST/api/health
curl -fsSI https://YOUR_PAY_HOST/api/skills/brclio-pay-deploy.zip
```

核对渠道、`ready` 和 `acceptingPayments`；初始关闭收款时后者应为 `false`。登录 `/admin`，确认私有维护说明来源和环境项状态，创建产品、真实 SKU、价格与 webhook。产品接入使用相应产品接入 Skill 完成服务端验签、事务去重和权益开通。公开健康检查不能证明商户权限或实际到账。

先验证签名目录读取、回调边界和产品幂等处理，再明确开放收款并进行正式小额验收。开放时，在 Cloudflare 控制台进入 `Workers & Pages → 自己的 Worker → Settings → Variables and Secrets`，将 `PAYMENT_ENABLED` 改为字符串 `true` 并保存部署；暂停时改回 `false`。不修改冻结的首次安装文件，也不重新生成服务密钥。再次查询 `/api/health`，确认所选渠道和 `acceptingPayments`，然后分别记录预下单、查单、平台到账、实际权益及客户端刷新。

新部署日常代码更新使用自己的已生成配置，如 `node scripts/deploy-worker.mjs --config secrets/setup-generated/wrangler.json`；此脚本保留全部控制台运行值。不要运行绑定既有 Brclio 生产账号的 `npm run deploy` / `deploy:all`，也不要直接发布含首次默认变量的原始配置。变更渠道或凭据时，在自己的 Worker 配置中维护并回归。

## AI Skill 部署

独立部署 Skill 为 [brclio-pay-deploy](../SKILL.md)，公开下载路径为 `/api/skills/brclio-pay-deploy.zip`。它负责部署支付中心，与三个产品接入 Skill 分工不同；产品受限接入令牌不能用于部署基础设施。

把下列任务交给已获准访问目标源码和部署环境的 AI，并提供本机文件路径：

```text
使用 skills/brclio-pay-deploy/SKILL.md 为我首次部署自己的 Brclio Pay。
支付范围：alipay（可改为 dual 或 wechat）。
使用我自己的 Cloudflare 账号、私有 GitHub 数据仓库和已限定该仓库的 GitHub App。
本机配置输入：secrets/setup-input.json；商户私钥和 APIv3 密钥通过其中的文件路径读取。
先生成并核对部署计划，再按本次授权部署；保留 PAYMENT_ENABLED=false。
我会在浏览器中完成必要的 Cloudflare / GitHub 授权。不要在对话、日志、公开页面或提交中展示凭据。
```

AI 应读取包内参考资料，在源码根目录运行工具；缺少基础设施授权时说明准确缺项，不索取全账号凭证或虚构成功。只授权准备配置时，完成可审阅计划后停止；已授权部署时，继续应用并核对结果。最终分别报告自动化检查、Worker 版本、域名状态及真实支付/履约验收状态。

## 既有 Brclio 生产服务发布

目标账号 `cacceff607775c81f667b7a951d4639f`，统一 Worker `brclio-pay-unified`。现有域名 `pay.bornforthis.cn` 使用 Pages 项目 `brclio-pay-aiyuechuang` 的服务绑定；保留现有外部 DNS，不修改根域名 nameserver。

### 发布顺序

1. `npm ci`，`npm run check`，`npm run test:runtime`，`npm run test:security-runtime`，`npm run test:migration`。
2. 先依 [migration.md](https://github.com/Brclio/Brclio-Pay/blob/main/docs/migration.md) dry-run，准备独立 Worker 与回退备份；最终切换前先冻结旧入口新单和自动发布，再以对应 digest 迁移。检查源 revision、目标私有属性、逐文件 SHA-256、订单和已付金额、平台凭据、待处理订单和通知。
3. 准备被 Git 忽略的服务端运行配置，保留支付宝原 CHECKOUT_SECRET、平台 API/Webhook 密钥与管理员认证参数；微信使用原商户配置。不要运行旧项目初始化脚本生成替代凭据。GitHub 使用指定 App 安装凭据，不复制全账号 OAuth token。
4. 首次初始化用 `node scripts/deploy-runtime.mjs secrets/runtime-vars.json` 写入已审阅的服务端 Text 参数并发布；现网日常更新用 `npm run deploy`。后者使用 `keep_vars=true` 和空 `vars`，保留全部控制台变量，避免把源码默认开关或地址覆盖到线上。核验 workers.dev 健康和签名历史查询。
5. 最终切换窗口内冻结旧自动发布和新单，复查源 revision 与队列。若前面已向暂存目标写入迁移数据，必须确认源未变化；发现变化则停止切换并核对，不能强行覆盖目标。
6. `npm run deploy:pages` 将现有域名入口绑定统一 Worker。仅在统一服务准备完成后切入口，保留原支付宝 Worker `brclio-pay` 作为回退。
7. `node scripts/deployment-preflight.mjs` 核验统一 Worker 和域名上的版本、健康、静态文件哈希和匿名拒绝边界。额外验证三个产品接入 Skill 与独立部署 Skill 下载、签名目录/历史查询、管理员报表和微信上游签名查单。

旧支付宝仓库的自动发布会覆盖旧 Pages 项目绑定；本次切换移除了旧触发器，备份配置保存在忽略目录。未来只从新项目发布。不要继续从旧项目运行 `deploy:all`。回退前必须核对目标是否已产生新订单，禁止把新账本丢弃。

### 核验层次

分别记录：代码检查、迁移完整性、Worker部署版本、Pages入口部署、域名HTTPS、真实预下单/查单/关单、真实到账、产品权益开通。只有用户实际支付并在业务系统确认权益后，才可声称完整资金履约链路验收。

微信兼容入口 `paywc.bornforthis.cn` 的 Pages 项目 `brclio-wechatpay` 同样绑定统一 Worker；执行 `npm run deploy:wechat-gateway` 更新。旧请求、checkout token和通知协议通过适配层使用同一新账本；不要直接恢复旧微信服务造成分叉。

源码仓库为 `Brclio/Brclio-Pay`。发布使用本机已授权的 Cloudflare CLI，运行 `npm run deploy:all` 更新统一 Worker 与两个 Pages 入口。当前 GitHub OAuth 授权不含 workflow 权限，因此没有配置 GitHub Actions 自动部署，也不在源码仓库存放闲置部署 Token。日常 Worker 脚本不携带任何运行变量值；保持全部控制台 Text 配置。不要绕过脚本直接发布带显式 `vars` 的默认配置。

环境变量说明独立存储于私有数据仓库 `maintenance/environment/guide.json`，由 `GET /api/admin/environment` 鉴权读取。敏感值默认不随此接口返回；管理员点击单项查看时，`POST /api/admin/environment/value` 校验管理员会话、同源请求及 CSRF 后，从当前 Worker 运行绑定读取该值，并禁止响应缓存。临时产品接入授权不能查看这些值。隐藏、离开维护页或退出登录会清除本页已查看值，页面不写入浏览器持久存储。

`scripts/sync-environment-guide.mjs` 默认只读，审阅后携带仓库版本和文档摘要同步；它不会把运行变量复制到说明中。公开文档与下载 Skill 也不包含实际部署凭据。发布后核对账单分渠道合计、历史订单覆盖、说明来源及当前所有 Text 值的哈希连续性。
