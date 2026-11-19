---
name: brclio-pay-deploy
description: Deploy a Brclio Pay payment center on Cloudflare Workers with a private GitHub data repository, or on the user's own server/BaoTa with local SQLite for business data and runtime configuration. Supports Alipay, WeChat Native, or both; product integration uses the three separate integrate Skills.
---

# Brclio Pay 部署

为用户部署自己的支付中心，新安装默认关闭收款。支持 Cloudflare 与服务器 / 宝塔两种后端。三个产品接入 Skill 的临时授权只对应一个产品，不授予 Cloudflare、GitHub、服务器或商户配置权限。

## 选择部署与支付范围

优先使用用户指定的方式：`Cloudflare Workers + 私有 GitHub` 或 `服务器 / 宝塔 + 本地 SQLite`。用户没有指定且现有上下文无法推断时，沿用原 Cloudflare 流程；不要悄悄迁移已有系统。支付范围为 `dual`、`alipay` 或 `wechat`，只准备所选渠道资料。

读取 [部署步骤](references/deployment.md)；服务器路径另读 [服务器部署与迁移](references/server-deployment.md)。解释参数时读 [环境变量说明](references/environment-variables.md)，准备渠道时读 [商户资料](references/merchant-setup.md)。包内参考资料可独立阅读；执行需要完整源码，不能把 Skill 包当成应用。

若没有源码，在用户已授权目录获取 `https://github.com/Brclio/Brclio-Pay`，检查本地 `AGENTS.md` 和项目说明，再从根目录执行，不覆盖已有 checkout。源码不可访问时报告具体缺项，不编造部署实现。

## 共同的凭据边界

- 管理员：邮箱；可提供密码文件，否则工具生成密码并保存到本机受限文件。内部签名与管理员认证材料由首次安装工具生成。
- 支付宝：AppID、收款 PID、应用私钥文件、支付宝公钥文件。`alipay.channels` 只选已签约的 `page` / `wap`，默认两者。
- 微信：商户号、已绑定 AppID、商户证书序列号和私钥文件、APIv3 密钥文件、微信支付公钥 ID 和公钥文件。

优先复用本会话已经授权的基础设施访问，商户资料不能替代服务器或账号授权。私钥、APIv3 密钥及密码通过文件读取，禁止打印到对话或日志、写入公开源码或通用 Skill、嵌入前端。管理员维护页的敏感值默认隐藏，只能通过固定变量范围的单项查看接口读取；要求管理员会话、同源与 CSRF 校验，响应 no-store，不写浏览器持久存储。产品接入授权不能读取这些值。

先完成 `npm ci`、`node scripts/sync-docs.mjs`、`node scripts/build-skill.mjs`、`npm run check`、`npm run test:runtime`、`npm run test:security-runtime`；涉及 SQLite 时另运行 `npm run test:server` 与 `node --test tests/migrate-sqlite.test.mjs`。不把自动化测试当成真实收款证据。

## Cloudflare：保留原部署流程

使用用户自己的账号、Worker、可选 Pages 网关和私有数据仓库，不使用源码中已有 Brclio 生产目标新建服务。

- 用户完成 `npx wrangler login`，以 `npx wrangler whoami` 核对账号；现有登录足够时不重复索取授权。
- 私有数据仓库必须有初始提交分支；使用仅安装该仓库、Contents 读写的 GitHub App，不用全账号 PAT，也不把公开源码仓库作为业务库。
- 业务数据保持独立明文 JSON，Cloudflare 流程不引入 D1、KV、R2、Durable Objects 或其他数据库。

选择包内的 `references/setup-input.example.json`、`references/setup-alipay.example.json` 或 `references/setup-wechat.example.json`，复制到忽略目录 `secrets/setup-input.json`。路径相对于输入 JSON。填写自己的目标和凭据文件路径，不能推测商户标识、产品权限或域名控制权。

```sh
npm run setup:deployment -- --input secrets/setup-input.json --output secrets/setup-generated
```

该命令只生成配置，不发布，不覆盖已有目录。检查 `deployment-plan.json` 中的账号、Worker、仓库、渠道、关闭收款状态与文件摘要。`worker-secrets.json` 和 `admin-login.json` 留在本机忽略目录；只输出名称和验证结论。更改配置应使用新目录重新生成，不能修改冻结文件。

本次已授权部署时继续应用；只授权准备时交付可审阅计划。不因本 Skill 重复要求确认。

```sh
npm run setup:deployment -- --deploy --output secrets/setup-generated
```

用户选择网关且输入含自己的 `pagesProjectName` 时追加 `--pages`。应用会验证摘要、GitHub 私有属性及 App 范围，缺失时初始化维护说明，并上传同一版本代码与 Secret。域名或网关变更按本次授权执行，不绕开校验复用原生产脚本。

失败时保留冻结文件与结果。首次安装只允许新 Worker 或有同一计划成功回执的重试；远端已经创建却没有成功回执时先核对，不能删除 Worker 或循环强推。权限不足、目标冲突或摘要变化时停止对应外部动作，报告准确原因。

用户授权开放收款后，在自己的 Worker `Settings → Variables and Secrets` 将 `PAYMENT_ENABLED` 改为字符串 `true` 并保存部署；暂停改回 `false`。日常代码更新使用 `node scripts/deploy-worker.mjs --config secrets/setup-generated/wrangler.json`，保留当前运行参数。不要直接发布初始化配置覆盖开关或重新生成密钥。

## 服务器 / 宝塔：全部本地 SQLite

首次安装只需要已授权服务器、HTTPS 域名、管理员与所选商户资料；不需要 GitHub 数据仓库、GitHub App 或 Cloudflare 账号。源码可以从 GitHub 获取，但服务器运行时不依赖 GitHub 存储。业务记录、配置、管理员认证参数、环境说明及迁移来源保存在 SQLite，不使用 `.env` 存放运行密钥。

使用 Node.js 22.13 或更新版本以及宝塔 Nginx / 进程守护，先核对现有站点和监听端口。数据库、备份与初始化资料放在网站不可下载的私有目录。选择 `references/server-input.example.json`，复制到 `secrets/server-input.json`，只保留所选渠道的对象。

```sh
npm run setup:server -- --input secrets/server-input.json --output secrets/server-generated
npm run build:server
```

初始化输出目录必须是新目录，包含 `brclio-pay.sqlite`、`admin-login.json` 和不含秘密值的 `setup-receipt.json`。检查初始化结果与数据库中的关闭收款状态，保留私密管理员登录文件路径；不展示密码。源码和静态文件放在发布目录，数据库放在独立持久目录，不用新初始化覆盖已有库。按本次授权安装守护进程、配置 Nginx 反向代理、TLS 和 DNS；不改变无关站点与原 Cloudflare 部署。

启动只传数据库路径及非敏感运行选项，例如 `PAY_DATABASE_PATH`、`PORT`。`STORAGE_BACKEND=sqlite` 由服务器程序注入，商户和管理员配置从 SQLite 读取。暂存验证设置 `SERVER_MAINTENANCE=false`，正式切换后才启用周期查单与通知投递。配置变更先保存一致性备份，以 `npm run setup:server -- --inspect --database /private/brclio-pay.sqlite` 获取版本；将变更保存到私有 JSON（例如 `{"values":{"PAYMENT_ENABLED":"true"}}`），执行 `npm run setup:server -- --update --database /private/brclio-pay.sqlite --input /private/update.json --expected-revision sqlite:N`。该操作限定变量并保留其他原值，更改后重启；不重跑新安装工具，不复制密钥到命令行。只有用户授权开放收款后才能把开关改为 `true`。

## 既有部署迁移与备用环境

现有系统迁移必须保留原商户配置、checkout 签名、管理员参数、产品密钥、订单/支付尝试/事件身份、金额与投递状态。不要通过首次安装生成替代凭据。

既有 Brclio GitHub → SQLite 迁移使用固定限定 Brclio App 和数据仓库的 `scripts/migrate-sqlite.mjs` 的 `prepare` 和携带精确 `--expected-digest` 的 `apply`。完整步骤见服务器参考文档。源导出使用限定仓库的只读 GitHub App 令牌；全部 JSON、非 JSON 附件和部署配置都保留。应用前后核对源 revision，任何变化均拒绝发布；不覆盖已有数据库。

原 Cloudflare 与 GitHub 可按用户要求保留为备用，工具不自动修改它们。两个后端不自动同步，不能把两个独立账本同时当作同一生产账本。仅关闭 `PAYMENT_ENABLED` 不会停止回调、刷新或定时任务写入；切换前必须核对在途订单、通知和 DNS 缓存，明确单一生产写入路径。未经本次授权，不停止或改写备用部署；不能因为工具导入成功就声称切换无丢单风险。

回退前先使用 `export-recovery` 导出 SQLite 的当前记录、附件和配置，核对新增订单与投递状态，形成独立反向迁移方案。不得直接切回过时 GitHub 快照丢弃服务器新增数据。

## 验证和交付

核对自己的 `/api/health`、`/admin`、部署 Skill ZIP 和所选产品接入包；首次安装的 `acceptingPayments=false`。确认健康接口的存储类型与所选后端一致，管理员环境说明来源正确，敏感值默认隐藏，单项查看仍受会话、同源和 CSRF 限制。

为首个产品配置真实 SKU、价格、回调和返回来源，使用对应产品接入 Skill 完成验签与事务幂等。支付确认必须核对应用、商户、CNY 和精确金额；浏览器返回不确认付款。仅在用户授权后开放收款，并分别核对真实支付与产品实际开通。

交付时分别报告自动化检查、所选运行环境和部署版本、数据完整性、域名/TLS 健康、真实付款与产品权益证据。未完成的层次明确标记，不因命令退出码为 0 就声称完整上线。提供私密管理员文件与备份的位置，不在回复中展示密码或运行密钥。
