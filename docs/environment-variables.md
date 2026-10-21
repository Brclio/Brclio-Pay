# 统一服务运行变量

全部生产运行变量在 Cloudflare 服务端以 **Text 明文**维护，可在 `Workers & Pages → brclio-pay-unified → Settings → Variables and Secrets` 查看或修改并保存部署。实际私钥、签名密钥和管理员认证材料不进入公开源码或客户端。`ASSETS`、`ADMIN_LOGIN_LIMITER`、`INTEGRATION_LIMITER`、`PAYMENT_API_LIMITER` 是资源绑定，不转换成文本。

日常 `npm run deploy` 通过 `scripts/deploy-worker.mjs` 使用空 `vars` 和 `keep_vars=true` 发布代码，保留控制台全部现有 Text 值，包括收款开关、地址等公开参数；源码 `wrangler.jsonc` 中的 `vars` 只作初始配置和本地构建默认值。直接运行原始 `wrangler deploy` 仍会发送文件中的显式变量，因此维护时使用项目脚本。此保留机制见 [Cloudflare 官方配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/#top-level-only-keys)。

首次创建 Worker 或明确重新配置时才运行 `scripts/deploy-runtime.mjs`，它会读取受控本地运行配置；不要用旧备份覆盖线上维护结果。预检默认按 `wrangler.jsonc` 的支付环境、开关与域名核验；如果主动调整这些值，应同步核验预期后再发布。业务数据在指定私有仓库以明文 JSON 保存。

| 名称 | 用途 |
| --- | --- |
| PAY_BASE_URL | 固定 HTTPS 收银台与回调根地址 |
| PAYMENT_MODE / PAYMENT_ENABLED | live 或 sandbox、收款开关；微信 Native 当前仅正式环境 |
| ALIPAY_APP_ID / ALIPAY_CHANNELS | 原支付宝应用及 page,wap |
| ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY / ALIPAY_SELLER_ID | 原应用私钥、支付宝公钥、商户PID |
| ALIPAY_GATEWAY | 可选；通常不填，按 PAYMENT_MODE 使用官方网关 |
| WECHAT_APP_ID / WECHAT_MCH_ID / WECHAT_CHANNELS | 原微信应用、商户号及 native |
| WECHAT_SERIAL_NO / WECHAT_PRIVATE_KEY | 商户证书序列号和原私钥 |
| WECHAT_API_V3_KEY | 微信通知 AES-GCM 解密密钥；这是上游协议要求，不代表仓库加密 |
| WECHAT_PUBLIC_KEYS_JSON / WECHAT_PUBLIC_KEY_ID | 固定可信微信支付公钥映射和请求公钥ID |
| GITHUB_APP_ID | 5411175；也可使用该 App Client ID 签JWT |
| GITHUB_APP_PRIVATE_KEY | 指定 GitHub App PEM，仅服务端 |
| GITHUB_APP_INSTALLATION_ID | 可选，不填时按目标仓库查询安装 |
| GITHUB_REPOSITORY / GITHUB_BRANCH | BrclioData/BrclioPay-Data / main，必须为私有 |
| REGISTRY_STORAGE_MODE | 生产固定 plain，独立平台注册和授权文件 |
| CLIENTS_JSON | 新生产固定空数组；完整平台从私有注册表读取 |
| LEGACY_WECHAT_BASE_URL / LEGACY_WECHAT_CHECKOUT_SECRET | 旧微信域名与原checkout密钥，仅用于兼容旧链接；不交给产品 |
| CHECKOUT_SECRET | 保留支付宝原值以兼容历史链接 |
| ADMIN_EMAIL / ADMIN_PASSWORD_HASH / ADMIN_PASSWORD_PEPPER / ADMIN_SESSION_SECRET | 保留原支付宝后台登录参数，不保存或打印管理员明文密码 |

新统一系统不需要旧 REGISTRY_ENCRYPTION_KEY / ENCRYPTION_KEY；只读迁移工具使用它们解密源数据。GITHUB_TOKEN 仅为旧代码兼容，不用于指定 App 的新生产部署。不要把旧备份全量上传覆盖统一服务。

平台接入后端仅需要 PAY_BASE_URL、PAY_CLIENT_ID、PAY_API_SECRET、PAY_WEBHOOK_SECRET；商户凭据和GitHub App凭据均不应交给接入项目。临时AI接入使用单产品、两小时有效的 BRCLIO_PAY_INTEGRATION_TOKEN，通用Skill本身不含凭据。

## 后台说明页与数据仓库

后台 `/admin#environment` 的说明来自私有 `BrclioData/BrclioPay-Data` 中独立的 `maintenance/environment/guide.json`。它包含上述名称、用途、占位示例、修改步骤和影响，不存当前运行值；状态只表示是否提供，不能代替商户配置验收。编辑该文件后刷新页面即可读取，文档缺失或结构错误会明确报错。

源码 `resources/environment-guide.json` 是可审阅的初始说明模板。同步工具默认只读：

```sh
node scripts/sync-environment-guide.mjs --dry-run
node scripts/sync-environment-guide.mjs --apply --expected-head <dry-run的仓库版本> --expected-document <dry-run的文档摘要>
```

已有文档默认不覆盖。确需同步新版模板，先比较私仓维护内容，增加文档 `updatedAt`，再使用 `--update --expected-remote-sha <dry-run的remoteBlobSha>`，同时提交最新仓库版本和文档摘要；并发变化会拒绝写入。直接编辑私仓文件也须保留 schema 1 与原字段结构。不要把实际运行值填入说明示例。
