# 统一支付架构

公网入口 `pay.bornforthis.cn` 经 Cloudflare Pages 服务绑定访问 `brclio-pay-unified` Worker。业务数据只在私有仓库 `BrclioData/BrclioPay-Data`；没有 D1、KV、R2、Durable Objects 或业务数据库。

## 支付协议

统一 v1 API 保留原支付宝 HMAC 协议。创建订单的 `provider` 为 `alipay` 或 `wechat`，省略为 `alipay`。平台 `providers` 控制可用方式；未配置的平台仍仅支持支付宝。支付宝开放 page/wap；微信开放 Native。网页、桌面、移动应用通过可信后端创建订单并打开 HTTPS 收银台。原生 APP、JSAPI、小程序和 H5 直调尚未开放，不能将 Native 扫码描述为这些通道。

订单的 provider、商品、金额、业务订单号和购买快照不可在幂等重试时改变。微信上游单号移除统一 ID 的 `pay_` 前缀以满足长度限制。每个逻辑订单保留支付尝试，管理员重开使用新的上游单号；迟到付款仍校验，额外付款保留记录，权益事件只生成一次。

仅经上游签名验证的通知或查单可以确认付款。进一步核对商户、应用、CNY、上游订单号和历史金额。浏览器回跳、二维码生成和预下单都不能确认支付。

旧 XHS 微信消费者继续使用 `paywc.bornforthis.cn`。兼容层验证原签名并映射32位订单号，写入同一统一账本；outbox 固定原 `payment.success` 协议和外部身份。历史checkout token经受保护接口换取同域新收银台链接。新产品统一使用 `brclio-v1` 协议。

## 明文分片存储

- `orders/YYYY/MM/pay_<id>.json`：每笔订单，按上海创建年月。
- `order-locations/<sha256(id)[0:2]>/<id>.json`：订单定位，兼容无日期的历史 ID。
- `events/YYYY/MM/evt_<id>.json`、`event-locations/...`：独立支付通知 outbox。
- `indexes/<client>/<hash[0:2]>/<businessHash>.json`：业务订单幂等定位。
- `payment-attempts/<hash[0:2]>/<attemptId>.json`、`order-actions/<order>/<actionHash>.json`：尝试和管理员操作。
- `registry/clients/<client>.json`：独立平台、商品、API/Webhook 凭据；grants、plans 独立文件，audit 按年月独立文件。`system/registry.json` 仅保留活跃记录 ID 索引。
- `reporting/v1/`：每订单投影、按月汇总、按平台汇总；均可从订单重建。
- `archives/<provider>/<sourceCommit>/...`：解密后的历史源记录及来源校验信息。
- `migrations/v1/<digest>/`：分文件校验清单和迁移证据。

所有这些业务 JSON 都是明文，包含个人数据和产品凭据；仓库必须保持私有，通用 Skills 和前端均不带这些凭据。商户私钥、GitHub App 私钥和管理员认证参数仅留在 Cloudflare 服务端配置及被忽略的本机备份，不放进源码仓库或客户端。密码验证保留既有哈希机制。

GitHub App 5411175 为单目标仓库签发短期 installation token，内存缓存并在过期前更新。每次业务事务读取不可变 Git 快照，将订单、通知和索引写入同一 commit，通过非强制更新分支引用防止并发覆盖。冲突会从新快照重新运行纯存储事务；外部付款请求不放进可重试事务。

## 交付与运行界限

Cron 每分钟处理限量待查单和通知；outbox 至少一次投递，接入项目必须在数据库事务中去重事件并实际发放权益。中心 `delivered` 只说明产品回调返回成功，最终权益仍需产品证据。

为保证失败可见，单 JSON 限制 256 KiB，单事务 64 文件/1 MiB，队列为有上限的工作索引，报表最多列举 20,000 笔源订单。年月目录避免巨型订单文件，但 GitHub API 速率与总文件数仍限制吞吐；本系统适用于当前低至中等交易量，容量错误必须显式返回，不能漏单或丢弃任务。

退款和自动权益回收没有实现。真实扣款和实际权益开通由人工验收，自动测试、预支付和关单不能替代。
