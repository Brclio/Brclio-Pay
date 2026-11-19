# 宝塔服务器与 SQLite 部署

服务器部署使用 Node.js 22.13 或更新版本、宝塔管理的 Nginx 和服务器本地 SQLite。迁移既有 Cloudflare 服务时，可保留 Worker、Pages 与原 GitHub 数据仓库作为独立备用环境；迁移工具不会修改它们。服务器运行时不请求 GitHub，业务记录、运行配置、迁移来源和历史附件均存储在本地 SQLite。商户参数、管理员认证参数、checkout 密钥和产品 API/webhook 密钥沿用原值。

## 首次安装：无需 GitHub 业务仓库

新建独立支付中心时，复制 [server-input.example.json](../examples/deployment/server-input.example.json) 到 `secrets/server-input.json`，填写自己的 `baseUrl`、管理员邮箱及所选支付渠道的商户文件路径。`providerMode` 为 `dual`、`alipay` 或 `wechat`；未选渠道的对象必须删除。文件路径相对于输入 JSON。可提供 `admin.passwordFile`，否则生成初始密码。

```sh
npm ci
npm run setup:server -- --input secrets/server-input.json --output secrets/server-generated
npm run build:server
```

初始化完全离线，不需要 Cloudflare 或 GitHub 授权；输出目录必须不存在，生成以下私有文件：

- `brclio-pay.sqlite`：业务表、全部运行参数、内部签名密钥、管理员认证参数和环境维护说明，默认 `PAYMENT_ENABLED=false`。
- `admin-login.json`：首次登录资料；工具生成的初始密码只保存在这个受限文件。若提供密码文件，不再次复制明文密码。
- `setup-receipt.json`：初始化结果与校验信息，不含秘密值。

确认数据库与输出文件权限，将发布代码和 SQLite 分别放入发布目录与独立持久目录，继续下文服务器运行步骤。已有 Cloudflare 账本迁移应使用后文迁移工具，不能用首次安装生成新凭据替换旧配置。

## 配置检查与维护

业务参数保存在 SQLite，不使用 `.env` 保存商户、管理员或产品密钥。先通过一致性备份保留当前数据库，再读取可用于并发保护的 revision：

```sh
npm run setup:server -- --inspect --database /private/brclio-pay.sqlite
```

检查命令只显示配置名和 `sqlite:N` 版本，不显示实际值。将本次明确要修改的项保存到私有 JSON，例如 `secrets/runtime-update.json` 内容为 `{"values":{"PAYMENT_ENABLED":"true"}}`；然后使用刚读取的版本：

```sh
npm run setup:server -- --update \
  --database /private/brclio-pay.sqlite \
  --input secrets/runtime-update.json \
  --expected-revision sqlite:N
```

工具限定可更新变量并合并其余原配置，版本变化时拒绝写入。更改后重启服务器进程，再检查健康状态与后台单项查看；原初始化输出不重写。只有明确授权开放收款后才把开关改为 `true`。暂停收款改回 `false`，商户与原订单身份保持不变。

## 既有 Brclio 环境迁移准备

以下 `migrate-sqlite.mjs` 流程专用于既有 Brclio 私有账本，固定限定下述 App 和仓库；独立新安装使用前文 `setup:server`，不需要这些授权。

先验证服务器网络、磁盘、Node.js、HTTPS 证书与域名配置。源码与静态文件放在发布目录；数据库和配置备份放在独立私有目录，不能位于 Nginx 可下载的网站目录。运行用户只获得必要目录权限，数据库为 `0600`；迁移包目录为 `0700`，其中的文件为 `0600`。

将当前 Cloudflare Worker 的字符串配置导出到被忽略的私有文件，例如 `secrets/server-migration/runtime.json`。配置是变量名到字符串值的 JSON 映射，应保留所有当前值，不能只复制源码中的默认值或旧备份。不要把密钥放进命令行、版本库、公开说明或浏览器存储。`ASSETS` 和限流绑定由服务器运行时实现，不属于字符串配置。

迁移使用 GitHub App `5411175`，安装令牌严格限定私有仓库 `BrclioData/BrclioPay-Data`，仅申请 `contents:read` 与 `metadata:read`。准备阶段固定源 commit/tree，逐个验证 Git blob SHA-1，并为每个原始文件计算 SHA-256。全部文件都会保留：业务 JSON 进入 `documents` 表；非 JSON、隐藏路径和不属于业务路径规范的文件进入 `source_archives` 表；原始字节不改写。运行变量进入独立 `runtime_config` 表，迁移来源和计划摘要进入元数据表。

```sh
node scripts/migrate-sqlite.mjs prepare \
  --config secrets/server-migration/runtime.json \
  --output secrets/server-migration/plan-001
```

输出目录必须不存在。准备阶段生成私有的 `plan.json`、`snapshot.json` 和 `runtime-config.json`，终端只输出计划摘要、源版本与计数。也可使用已导出的 `--snapshot PRIVATE_SNAPSHOT.json`；快照包含 `repository`、`branch`、`revision`、`tree`，以及各文件的 `path`、Git blob `sha`、`contentBase64`。离线快照仍会验证每个 blob，最终应用仍须在线确认源版本。

核对文件计数、订单/事件/平台/授权/计划/审计计数、待处理订单和通知计数，以及源版本。计划文件本身不授权切换域名。确认本次准备产生的摘要后，将精确摘要交给应用命令：

```sh
node scripts/migrate-sqlite.mjs apply \
  --plan secrets/server-migration/plan-001 \
  --expected-digest REVIEWED_SHA256 \
  --database /private/server-migration/new-brclio-pay.sqlite
```

应用命令只创建新数据库，拒绝覆盖已有文件（包括空文件）、WAL 或 SHM 文件。它先验证计划、快照和配置摘要，再确认源 GitHub revision。所有业务 JSON、历史附件、配置与来源信息在一个 SQLite 事务内导入。随后逐文件验证原始 SHA-256 和全部运行变量，复查源 revision，关闭并完整落盘，最后原子发布数据库文件。任何源版本变化都会阻止发布，应重新准备并核对计划。

可对尚未开始接收业务写入的数据库复核：

```sh
node scripts/migrate-sqlite.mjs verify \
  --plan secrets/server-migration/plan-001 \
  --expected-digest REVIEWED_SHA256 \
  --database /private/server-migration/new-brclio-pay.sqlite
```

上线后的业务记录会正常变化，不能再要求它与迁移时快照逐字节相同。

## 服务器运行

```sh
npm ci
node scripts/sync-docs.mjs
node scripts/build-skill.mjs
npm run check
npm run test:runtime
npm run test:security-runtime
node --test tests/migrate-sqlite.test.mjs
npm run build:server
```

将 `dist-server/` 部署到服务器发布目录，将已验证的数据库放到独立私有目录。通过 systemd 或宝塔进程守护运行服务，并配置崩溃重启与开机启动：

```sh
PAY_DATABASE_PATH=/www/server/brclio-pay/data/brclio-pay.sqlite \
PORT=3187 \
node /www/server/brclio-pay/current/index.mjs
```

服务监听本机回环接口，通过 Nginx 反向代理公开 HTTPS。测试暂存实例时设置 `SERVER_MAINTENANCE=false`，避免在正式切换前运行查单和通知投递。正式实例会执行周期维护；不要同时启动多个独立账本处理同一批支付任务。

Nginx 必须保留经过白名单校验的原始 Host，将协议明确设置为 HTTPS，并覆盖客户端地址相关代理头。为自己的 `PAY_BASE_URL` 域名配置证书与代理。仅在迁移已有微信兼容入口时，同时迁移 `LEGACY_WECHAT_BASE_URL` 的证书、Host 路由与解析；全新安装不要求存在旧入口。既有 Brclio 环境对应 `pay.bornforthis.cn` 和 `paywc.bornforthis.cn`，迁移该环境时不能只迁移主域名，否则微信旧链接仍会进入备用账本。数据库、运行配置和迁移包不通过网站路由提供。

## 切换与备用环境

准备、构建和暂存验证期间不修改现有 Cloudflare 部署、GitHub 数据或域名。切换域名前验证服务器首页、静态文件、签名目录读取、历史订单查询、管理员会话、同源/CSRF 边界、双渠道配置和 TLS。源 GitHub 账本必须在最终导出到切换之间保持同一版本；源变化时停止并重新迁移，不能覆盖服务器已经产生的新业务记录。

`PAYMENT_ENABLED=false` 只阻止新购买，不会禁止回调、刷新、管理员订单操作或定时维护写账。仅更改 DNS，也不能保证缓存中的旧请求立即停止到达 Cloudflare。保留备用环境不等于同时启用两个可独立写入的生产账本。最终切换方案必须明确处理待支付订单、回调缓存、待投递通知和旧定时任务；若需要修改备用环境或配置临时转发，应另行遵循当前任务授权。此迁移工具不自动执行这些操作，也不自动修改 DNS。

DNS 变更只针对需要迁移的支付域名记录，保留其他业务解析和 nameserver。记录变更前的记录类型、值、代理状态和 TTL，发布后分别检查权威解析、HTTPS 与实际到达的服务。原 Cloudflare 与 GitHub 部署保持可恢复；切换后产生的新订单以服务器 SQLite 为准，不能直接用旧账本覆盖或通过改回 DNS 丢弃新记录。

## 备份与回退资料

SQLite 开启 WAL 和 `synchronous=FULL`。在线备份应使用 SQLite 的一致性备份能力，不能只复制正在写入的主文件而漏掉 WAL。可使用 `python3 scripts/backup-sqlite.py --database /private/brclio-pay.sqlite --output /private/backups/NEW.sqlite`；输出必须是新文件，备份包含配置与全部业务表。`deploy/server/` 提供服务、备份计时器与 Nginx 模板，安装前核对用户、目录、域名和证书路径。另可导出当前数据库的一致性恢复包：

```sh
node scripts/migrate-sqlite.mjs export-recovery \
  --database /private/server-migration/new-brclio-pay.sqlite \
  --output secrets/server-migration/recovery-NEW.json
```

恢复包包含当前业务记录、历史附件、运行变量、SQLite revision、迁移来源、每个文件的 SHA-256/Git blob SHA-1 和整体摘要。它是私密资料，输出目标必须不存在；命令不会向 GitHub 写入。回退前须核对服务器新增订单、金额、支付尝试、投递状态和平台配置，生成并审阅反向迁移计划，再决定如何恢复备用环境，不能直接切回过时快照。

验收分别记录自动化检查、数据完整性、服务器部署、域名/TLS、真实付款和产品实际开通证据。健康接口就绪和迁移校验通过，不代表已经完成真实资金与产品权益验收。
