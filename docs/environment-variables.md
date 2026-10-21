# 统一服务运行变量

公网参数由 `wrangler.jsonc` 管理；敏感值只通过 Cloudflare 服务端配置和忽略的 `secrets/` 维护，不能打印、提交或带入客户端。`keep_vars=true` 保留现有 Text 绑定。业务数据在指定私有仓库以明文 JSON 保存。

| 名称 | 用途 |
| --- | --- |
| PAY_BASE_URL | 固定 HTTPS 收银台与回调根地址 |
| PAYMENT_MODE / PAYMENT_ENABLED | live 或 sandbox、收款开关；微信 Native 当前仅正式环境 |
| ALIPAY_APP_ID / ALIPAY_CHANNELS | 原支付宝应用及 page,wap |
| ALIPAY_PRIVATE_KEY / ALIPAY_PUBLIC_KEY / ALIPAY_SELLER_ID | 原应用私钥、支付宝公钥、商户PID |
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
