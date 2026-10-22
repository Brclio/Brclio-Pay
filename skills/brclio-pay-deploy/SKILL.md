---
name: brclio-pay-deploy
description: Deploy a new Brclio Pay payment center in the user's own Cloudflare account with a private GitHub data repository, supporting Alipay, WeChat Native, or both. Use for self-hosting the center; product integration uses the three separate integrate Skills.
---

# Brclio Pay 部署

为用户部署自己的支付中心，默认关闭收款。保留三个产品接入 Skill 的职责与单产品授权边界；它们的临时接入令牌不授予 Cloudflare、GitHub 或商户配置权限。

## 先确定部署范围

确认用户选择 `dual`、`alipay` 或 `wechat`。只收集所选渠道资料，不为单渠道索取另一渠道凭据。新部署只使用用户自己的账号、Worker、可选 Pages 网关和私有 GitHub 数据仓库；源码仓库中的现有 Brclio 生产目标不能用于新安装。

读取 [部署步骤](references/deployment.md)。需要解释环境项时读 [环境变量说明](references/environment-variables.md)，准备所选渠道时读 [商户资料](references/merchant-setup.md)。包内参考资料可独立阅读；执行需要完整源码及 `scripts/setup-deployment.mjs`，不能把本 Skill 包当成完整应用。

若没有源码，在用户已授权的工作目录获取 `https://github.com/Brclio/Brclio-Pay`，检查本地 `AGENTS.md` 和项目说明，再从该根目录执行。不覆盖已有 checkout。源码若不可访问，报告具体缺项，不临时编造部署代码。

## 凭据与基础设施

- Cloudflare：用户完成 `npx wrangler login`，使用 `npx wrangler whoami` 核对目标账号。现有登录足够时不重复索取授权。
- GitHub：用户自己的私有数据仓库、已有初始提交的分支、自己的 GitHub App ID 与 Installation ID、App 私钥文件；App 只安装该数据仓库，Contents 读写。不能用全账号 PAT 替代，也不能把公开源码仓库作为业务数据仓库。
- 管理员：邮箱；可提供密码文件，否则初始化工具生成密码并保存到本机受限文件。内部收银台和管理员认证密钥由工具生成。
- 支付宝：AppID、收款 PID、应用私钥文件、支付宝公钥文件。`alipay.channels` 只选择已签约的 `page` / `wap`，默认两者。
- 微信：直连商户号、已绑定 AppID、商户证书序列号和私钥文件、APIv3 密钥文件、微信支付公钥 ID 和公钥文件。

用户提供商户资料仍不能替代基础设施授权。优先复用当前会话已授权的访问；需要用户完成的浏览器授权或缺失参数应准确指出，不索取全账号凭据。私钥、APIv3 密钥及密码通过本机文件读取，禁止打印到对话或日志、写入公开源码或通用 Skill、嵌入静态前端或 Pages。维护页登录后显示公开配置实际值，敏感项默认隐藏，仅允许管理员通过单项查看按钮读取当前 Worker 运行值；临时产品接入授权无此权限。业务数据只保存在私有仓库的明文 JSON，不增加 D1、KV、R2、Durable Objects 或其他业务数据库。

## 生成并应用同一份部署计划

在源码根目录执行 `npm ci`、`npm run check`、`npm run test:runtime`、`npm run test:security-runtime`。选择包内对应的 `references/setup-input.example.json`、`references/setup-alipay.example.json` 或 `references/setup-wechat.example.json`，复制到 Git 忽略的 `secrets/setup-input.json`，填写本次目标和凭据文件路径。路径相对于输入 JSON。不要替用户推测商户标识、产品权限或域名控制权。

```sh
npm run setup:deployment -- --input secrets/setup-input.json --output secrets/setup-generated
```

此命令离线生成配置，不部署，不覆盖已有目录。检查 `deployment-plan.json` 的账号、Worker、数据仓库、渠道、关闭收款状态和文件摘要。`worker-secrets.json` 与 `admin-login.json` 仅留在本机忽略目录；检查时输出名称和验证结果，不输出内容。更改配置需要使用新输出目录重新生成，不能手改已冻结文件。

如果本次用户已授权部署，继续执行；仅授权准备时交付这份可审阅计划。无需因通用 Skill 额外要求重复确认。

```sh
npm run setup:deployment -- --deploy --output secrets/setup-generated
```

仅在用户选择网关且输入含自己的 `pagesProjectName` 时追加 `--pages`。应用会验证摘要、核对 GitHub 私有属性及 App 范围，在缺失时初始化维护说明，并上传同一版本代码与 Secret。不要绕开校验去复用生产脚本，不自动修改 DNS；域名或网关操作按本次授权范围执行。

若部署失败，保留冻结文件与部署结果，按实际故障修复。首次安装工具仅允许新 Worker 或有同一计划成功回执的重试；若远端已创建而没有成功回执，先核对远端状态，不能删 Worker 或循环强推。权限不足、目标冲突或摘要变化时停止该外部动作并报告具体原因。

## 验证和交付

核对自有 URL 的 `/api/health`、`/admin`、`/api/skills/brclio-pay-deploy.zip` 和所选产品接入包；初始 `acceptingPayments=false`。登录后台验证维护说明来自所选私有仓库、公开值与服务端参数一致、敏感值默认隐藏。管理员单项查看应读取当前 Worker 值，隐藏、离开维护页或退出登录会清除页面内容；勿将查看结果抄到对话或文档。检查部署回执中的账号与 Worker 版本，不因命令退出码为 0 就声称域名或付款成功。

为首个产品配置真实 SKU、价格、回调与返回来源，使用对应的 `brclio-pay-integrate`、`brclio-alipay-integrate` 或 `brclio-wechatpay-integrate`。支付确认必须验签并核对应用、商户、CNY 和精确金额；产品事务幂等提交权益，浏览器返回不确认付款。未经用户明确开放收款，不更改 `PAYMENT_ENABLED=false`。

用户授权开放收款后，在自己的 Worker 的 Cloudflare `Settings → Variables and Secrets` 把 `PAYMENT_ENABLED` 改为字符串 `true` 并保存部署，再核对健康检查与正式小额交易；暂停时改回 `false`。不修改冻结的首次安装配置或重新生成凭据。后续代码发布使用 `node scripts/deploy-worker.mjs --config secrets/setup-generated/wrangler.json`，保留控制台当前开关和商户参数。

最终分别说明自动化检查、Worker 版本、Pages/域名健康和真实支付及产品权益证据；未实际付款就标记待验收。交付本机管理员登录文件路径，不在回答中展示密码。后续代码更新用 `node scripts/deploy-worker.mjs --config secrets/setup-generated/wrangler.json` 保留当前运行参数，不直接发布初始化配置覆盖线上开关；既有 Brclio 生产服务按参考文档的独立维护流程处理，保留所有原凭据及业务记录。
