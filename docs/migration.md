# 支付历史数据迁移

迁移程序默认只读，来源固定为 `BrclioData/Brclio-Alipay-Data` 和 `BrclioData/Brclio-WeChatPay-Data`，唯一可写目标为 **私有仓库 `BrclioData/BrclioPay-Data`**。程序不修改、不删除来源仓库，也不读取或输出本机 GitHub CLI 的全账号 OAuth token。

## 凭据与来源配置

目标通过 GitHub App `brcliopay`（App ID `5411175`，所有者 `BrclioData`）获取仅限目标仓库的临时 installation token。App 需要 `Contents: Read and write`、`Metadata: Read-only`，并且已安装到目标仓库。默认使用本机 `/Users/bornforthis/cert/brcliopay.2026-10-21.private-key.pem`；可用 `--private-key` 指定其它本机路径。私钥、installation token、原商户凭据均不会打印。

来源 token 和解密密钥只从旧项目已有的 ignored 配置读取：

| 来源 | 默认文件 | 需要的字段 |
| --- | --- | --- |
| 支付宝 | `../Brclio-Alipay/secrets/initial-worker-secrets.json`、`admin-worker-secrets.json`、`runtime-variables-maintenance.json`、`.dev.vars` | `GITHUB_TOKEN`、`REGISTRY_ENCRYPTION_KEY`；缺少持久注册表时读取 `CLIENTS_JSON` |
| 微信 | `../Brclio-WeChatPay/secrets/runtime.json`、`.dev.vars` | `GITHUB_TOKEN`、`ENCRYPTION_KEY`；可附加 `CLIENTS_JSON` baseline |

新项目 `secrets/brclio-pay-live-backup.json`、`secrets/brclio-wechatpay-live-backup.json` 的 Cloudflare `settings.bindings` 中当前 `plain_text` 配置优先于本机备份；`secret_text` 只有名称，解密密钥继续使用旧项目本机备份。`--alipay-config` 和 `--wechat-config` 可提供最新 ignored JSON 覆盖，接受简单字段对象或 `settings.bindings` 形式。程序不会从 Cloudflare 修改或重新生成任何密钥。

旧微信订单没有支付环境字段。必须用已核验的当前 `PAYMENT_MODE=live|sandbox`，或显式传 `--wechat-mode live|sandbox`；程序不会把 `demo` 猜为正式环境。

## 先执行 dry-run

```sh
node scripts/migrate-data.mjs --report secrets/migration/reviewed-dry-run.json
npm run test:migration
```

可显式指定环境：

```sh
node scripts/migrate-data.mjs --wechat-mode live --report secrets/migration/reviewed-dry-run.json
```

控制台和报告仅包含来源 revision、单量、状态、已确认付款金额（分）、摘要 SHA-256、阻塞数量和目标访问状态。不会显示账号密钥、客户标识、订单正文或平台注册表。报告强制位于本项目 ignored `secrets/`，文件权限为 `0600`。

退出码 `0` 表示 dry-run 无已知阻塞且目标已核验；`2` 表示完成来源检查，但目标访问、来源 revision 或未完成任务仍需处理；`1` 表示迁移中止。目标仓库必须先存在至少一个初始化提交；若为空，由仓库管理员初始化 README 后重新运行。

## 明文独立文件布局

| 记录 | 目标路径 |
| --- | --- |
| 订单 | `orders/YYYY/MM/pay_<id>.json`，年月采用上海创建时间 |
| 订单定位 | `order-locations/<SHA256(id)前2位>/<id>.json`，内容为 `{schema:1,path}` |
| 支付通知 outbox | `events/YYYY/MM/<eventId>.json`，按事件创建时间 |
| 通知定位 | `event-locations/<SHA256(eventId)前2位>/<eventId>.json` |
| 商户订单幂等索引 | `indexes/<clientId>/<hash前2位>/<hash>.json` |
| 支付尝试映射 | `payment-attempts/<SHA256(id)前2位>/<id>.json` |
| 平台 | `registry/clients/<clientId>.json` |
| AI 授权、计划 | `registry/grants/<grantId>.json`、`registry/plans/<planId>.json` |
| 注册表审计 | `registry/audit/YYYY/MM/<auditId>.json` |
| 注册表目录 | `system/registry.json`，仅包含 revision 及独立记录的标识列表 |
| 原始解密数据 | `archives/<alipay或wechat>/<sourceCommit>/<sourcePath>` |
| 完整迁移清单 | `migrations/v1/<planDigest>/manifest.json`，逐来源记录清单在 `entries/`，每页最多 200 个目标摘要在 `inventory/` |

原支付宝订单的价格、创建时间、请求 hash、付款信息和通知状态保留；增加 `provider='alipay'`。支付宝 AES 注册表解密后拆为上述明文独立记录，原订单、通知、业务索引和支付尝试路径按映射移动，其余业务 JSON 保留。

微信订单保留原 32 位 ID 为 `wechatOrderId`，统一订单 ID 为 `pay_<原ID>`；`SUCCESS→PAID`，`CREATING/PENDING→PENDING`，`CLOSED/PAYERROR→CLOSED`，原始状态完整保存在档案中。整数分转换为两位小数元，`transactionId→tradeNo`，原 channel、App ID、quantity、delivery 和旧 request hash 作为兼容字段保留。新请求 hash 按统一接口的历史金额、商品、返回地址和 `provider='wechat'` 重建，支付宝 request hash 不变。缺失旧微信 return URL 使用空串保留“未配置返回地址”的历史事实，不虚构回跳域名；对应统一接口无法重放缺失的必填 return URL，原始旧接口订单仍由旧服务核对。

微信平台注册表将 `apiKey→apiSecret`，保留原 webhookSecret，products 转为统一 SKU，增加 `providers=['wechat']`。平台 ID 同名时程序直接中止，不合并不同凭据；经人工确定后可传 `--wechat-client-map ignored-map.json`，文件格式为 `{"旧微信平台ID":"独立新平台ID"}`。平台映射同时应用到规范订单及商户幂等索引，原始档案不变。

全部归档记录包含来源仓库、不可变 commit、路径、Git blob SHA、源文件原字节 SHA-256、规范明文 SHA-256 及解密后的原始 `data`。不会将 AES envelope 当成目标活跃记录，也不复制加密原文；源仓库原字节继续保留。README 的原始 UTF-8 文本作为归档 `data.text` 保存。未知非 JSON 文件会中止并要求明确检查，避免遗漏数据。

经营报表根据两种渠道的全部规范订单重建，包括已确认付款、重复付款、上海付款日、平台和环境分组；不会只复制支付宝旧汇总后漏掉微信。

## 正式写入及切换

完成审阅并冻结来源写入后，使用本次 dry-run 返回的完整 digest：

```sh
node scripts/migrate-data.mjs --apply --expected-plan <已审阅的64位SHA256> --report secrets/migration/applied.json
```

必须在流量切换前冻结订单创建、回调和定时任务写入，或安排可控维护窗口，再重新 dry-run。程序在上传前、提交准备完成后都复核两个来源分支 revision；变化即中止目标分支更新。目标所有数据以一个 Git commit 通过非 force 快进更新原子发布，保留目标已有其它文件。开始写入前逐条比较：相同记录视为幂等，任何不同记录拒绝覆盖；已成功迁移后源或目标业务数据有变化时，不应强行重跑，需单独设计增量对账。

`--apply` 不允许遗留微信 `CREATING/PENDING`、未送达/人工通知或 `work/` 项。旧微信 webhook 的事件名称、正文和签名协议与统一接口不同，不能静默重放来开通权益。应先在旧服务核验支付与通知完成，再重跑；已送达订单保留 delivered，迁移不会新建它们的投递任务。

写入后程序读取新目标 commit 全部计划记录，逐条校验内容；报告保存已写 commit 和校验数量。源 token 仅发送 GET；目标只有 App 限定仓库可写。重跑相同来源快照不会重复写入相同记录。

切换前核对：两源 commit 与清单一致、来源与目标单数/已付金额一致、注册平台及独立凭据一致、outbox 与队列一致、报表覆盖完整、所有原始归档可按 SHA 对账、生产环境和商户配置一致。随后验证自定义域名、证书、受限查单、通知验签和实际权益幂等。迁移报告、Cloudflare 部署成功、域名证书正常、人工实付与真实权益开通是分别的证据，不能相互替代。旧服务及旧仓库继续保留回退；切换后不再同时向新旧服务创建同一商户订单。
