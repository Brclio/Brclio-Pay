# 支付宝配置与上线检查

本项目为 Brclio 的自营产品提供统一收银台，计划域名为 `https://pay.bornforthis.cn`。产品可以部署在 `brclio.com` 及已登记的子域名，付款结果由支付中心发送到产品后端，再由产品开通服务。

用户提供的应用信息：

| 项目 | 值 |
| --- | --- |
| 应用名称 | Brclio |
| AppID | `2021007109602288` |
| 应用类型 | 网页应用 |
| 计划收银台域名 | `pay.bornforthis.cn` |

创建应用、取得 AppID、产品签约、配置密钥、部署成功、真实收款成功分别是独立状态；最新交付结果见 status.md。

2026-10-13 首次读取控制台时，应用状态为**开发中**，接口加签方式为**未设置**；应用网关、授权回调也显示未设置。应用主页当时为 `https://open.alipay.com`，简介为“我的网页嘻嘻哈哈122333简介”，这些占位资料需要替换为真实收银台和业务介绍。随后用户完成应用公钥设置并提供支付宝公钥，已确认应用公钥与本机私钥配对并保存。正式收款仍需完善资料并完成平台审核。应用网关和 OAuth 授权回调是否需要设置取决于实际使用能力，未设置它们不意味着普通支付必须额外使用 OAuth。

## 1. 确认签约产品和实际经营信息

在支付宝开发平台打开 Brclio 应用，逐项核对应用审核状态、已添加能力、商户签约状态和收款账号。

| 使用场景 | 对应产品 / 接口 | 本项目初始支持 |
| --- | --- | --- |
| PC 网页、桌面客户端打开系统浏览器 | 电脑网站支付 / `alipay.trade.page.pay` | 已列入可调用产品，代码启用 page 渠道 |
| 手机浏览器 | 手机网站支付 / `alipay.trade.wap.pay` | 已列入可调用产品，代码启用 wap 渠道 |
| Android 原生 SDK | App 支付 / `alipay.trade.app.pay` | 首版未实现；Android 使用系统浏览器收银台 |
| 自己生成支付宝订单二维码 | 当面付 / `alipay.trade.precreate` | 首版未实现 |

电脑网站支付收银台本身可以展示二维码；这不等于已经开通当面付。网页应用的创建成功也不等于手机网站支付、App 支付已获准使用。实际支持以当前控制台权限和签约合同为准。

收银台应展示真实商品、价格、经营主体和必要的售后信息。支付宝提供的产品文档对网站备案、可正常访问和明确经营内容提出要求。`bornforthis.cn` 的备案不能被解释为任意产品域名均获准收款；统一收银台也不能被承诺为规避备案的方案。请根据控制台的实际要求，如实提交收银台及产品业务信息；如对 `brclio.com` 的业务来源或回跳有疑问，向支付宝确认后再开放相应产品。

参考：[电脑网站支付接入](https://developer.alibaba.com/docs/doc.htm?articleId=105899&docType=1&treeId=270)、[PC 产品准入条件](https://developer.alibaba.com/docs/doc.htm?articleId=105898&docType=1&treeId=270)、[手机网站支付产品](https://developer.alibaba.com/docs/doc.htm?articleId=105288&docType=1&treeId=203)。这些支付宝提供的旧版文档用于说明接口及接入原则；费率、最新准入条件和控制台入口以当前平台为准。

## 2. 配置 RSA2 密钥

首版使用**普通公钥模式**，配置项为应用私钥和支付宝公钥。请在应用的开发设置中确认接口加签方式采用 RSA2，并与部署配置一致。

1. 在可信的本地环境使用支付宝密钥工具或 OpenSSL 生成 RSA 密钥对，使用至少 2048 位密钥。
2. 只把**应用公钥**提交到支付宝应用的接口加签设置。
3. 保存该应用对应的**支付宝公钥**，供服务端验证通知及查单返回。
4. 把**应用私钥**和**支付宝公钥**分别配置为 Worker 的 `ALIPAY_PRIVATE_KEY`、`ALIPAY_PUBLIC_KEY` 运行时变量。按用户 2026-10-18 的 [Text 维护约定](environment-variables.md) 保留原值，使用 PEM 格式并保留正确换行；已有正式应用不重新生成密钥。
5. 确认 `ALIPAY_SELLER_ID` 是该应用实际收款账号的支付宝用户 ID / PID；它不是 AppID。

应用公钥用于支付宝验证商户请求；支付宝公钥用于商户验证支付宝返回。不要把两者混用。私钥不得进入源码、GitHub 数据仓库、网页或移动客户端；仅保留本机受限备份和 Cloudflare Worker 服务端配置，控制台显示方式以 [环境变量说明](environment-variables.md) 为准。

支付宝官方 SDK 推荐证书模式，但首版没有实现证书序列号及证书链配置。如果当前应用已经使用证书模式，应先扩展并验证证书模式支持，不能仅把证书内容填入普通公钥字段，也不要擅自替换已经在用的应用密钥。

参考：[官方 SDK 的公钥和证书配置](https://github.com/alipay/alipay-sdk-nodejs-all#平台配置)、[生成 RSA 密钥](https://developer.alibaba.com/docs/doc.htm?articleId=105971&docType=1&treeId=291)、[上传应用公钥并取得支付宝公钥](https://developer.alibaba.com/docs/doc.htm?articleId=105972&docType=1&treeId=291)。

## 3. 准备私有 GitHub 数据仓库

使用专用的**私有** GitHub 仓库保存订单、幂等记录和通知投递队列；不使用 D1、KV 或 Durable Objects。配置：

- `GITHUB_REPOSITORY`：`owner/repository`。
- `GITHUB_BRANCH`：已存在的分支，默认 `main`。仓库需要已有初始提交。
- `GITHUB_TOKEN`：仅授权该数据仓库的细粒度令牌，具备 Contents 读写权限。Worker 需要创建 Git 对象、提交并更新该分支引用。

目标分支须允许该令牌完成正常的非强制更新。数据仓库不要与公开源码仓库共用，不得在其中存放应用私钥，也不得明文保存产品 API Secret 或 webhook Secret；产品长期凭据仅由现有 AES-256-GCM 加密注册表保存。

GitHub 方案适合低交易量自营产品。每次订单创建或状态更新会产生提交，并消耗多次 GitHub REST 请求。订单数量增长后必须评估速率限制、延迟、提交历史及队列规模；它不适合作为高并发支付数据库。详见 [架构与边界](./architecture.md)。

## 4. 配置 Worker

配置定义以 `src/types.ts` 和 `wrangler.jsonc` 为准。首次未完成验收时关闭收款：`PAYMENT_ENABLED=false`；现有正式服务经此前用户授权为 `true`，维护时保留。渠道为 `page,wap`。当前 Text 类型、变量生成方式及发布保留规则见 [环境变量说明](environment-variables.md)。

| 配置 | 用途 |
| --- | --- |
| `PAY_BASE_URL` | 收银台 HTTPS 基础地址，计划为 `https://pay.bornforthis.cn` |
| `PAYMENT_MODE` | `live` 或 `sandbox`，必须与密钥、AppID 和网关环境一致 |
| `PAYMENT_ENABLED` | 收款开关；完成配置和验证前保持 `false` |
| `ALIPAY_CHANNELS` | 允许渠道，当前 `page,wap` |
| `ALIPAY_APP_ID` | 正式应用为 `2021007109602288`；沙箱使用沙箱 AppID |
| `ALIPAY_PRIVATE_KEY` | 应用私钥，敏感运行时变量 |
| `ALIPAY_PUBLIC_KEY` | 支付宝公钥，运行时验签配置 |
| `ALIPAY_SELLER_ID` | 实际收款账号 PID，用于业务核对 |
| `ALIPAY_GATEWAY` | 可选网关覆盖；仅使用对应环境的官方 HTTPS 网关 |
| `GITHUB_REPOSITORY` / `GITHUB_BRANCH` | 私有数据仓库和分支 |
| `GITHUB_TOKEN` | 数据仓库访问令牌，敏感运行时变量 |
| `CHECKOUT_SECRET` | 支付页面令牌签名密钥，与产品长期密钥分开 |
| `CLIENTS_JSON` | legacy 产品配置及凭据，仅加密注册表不存在时初始化 |

当前 Worker 按 [Text 维护约定](environment-variables.md) 在原控制台配置中以同名同值维护。Wrangler Secret 输入功能仍可供首次采用 Secret 管理或明确恢复 Secret 类型时使用，例如 `npx wrangler secret put ALIPAY_PRIVATE_KEY`；此命令会恢复对应变量的 Secret 类型，不是当前 Text 维护下的日常发布步骤。不要将真实值作为命令行参数、提交到配置文件或打印到日志。legacy `CLIENTS_JSON` 中每个产品至少包含 `id`、`name`、`apiSecret`、`webhookSecret`、`webhookUrl`、`returnOrigins` 和 `skus`，字段结构以 `ProductClient` 类型为准；已有加密注册表时通过后台更新，不能用旧配置覆盖。

每个 SKU 包含服务端固定的 `subject` 和两位小数字符串 `amount`。产品前端不提交可被直接采用的付款金额。每个产品使用独立 API 和 webhook Secret，并登记实际 HTTPS webhook 与允许的回跳 origin；新增子域名须加入该产品配置。

Cron 在 `wrangler.jsonc` 中初始为每 5 分钟运行一次，用于订单补偿查单和 webhook 重试；部署后需在 Cloudflare 确认计划任务已生效。

## 5. 绑定域名与支付宝通知

1. 在 Cloudflare 中部署 Worker，绑定 `pay.bornforthis.cn` 并确认 HTTPS 证书可用；仅写入 `PAY_BASE_URL` 不会自动创建 DNS 或自定义域名。
2. 根据应用当前要求填写应用主页、经营网址等字段。OAuth 授权回调与支付回跳用途不同，不要把支付 URL 任意填入无关设置。
3. 支付请求由服务端传入 `notify_url=https://pay.bornforthis.cn/api/alipay/notify` 和 `return_url=https://pay.bornforthis.cn/payment/return`，保持公网可访问。回跳入口根据 `out_trade_no` 返回收银台查询状态，不直接确认付款。
4. 支付宝异步通知入口必须能够接受外部 POST，不可被登录页、验证码、人机挑战或部署保护拦截。
5. 在产品端部署 webhook 验签处理和查单接口，保证同一付款事件重复发送也只开通一次。

支付宝通知中的前台回跳只能用于展示结果。最终付款事实由验签和业务校验后的异步通知，或服务端主动查单确定。不能凭回跳到页面、客户端提示成功或收银台截图开通服务。产品服务端使用 `POST /api/v1/orders` 创建订单，`GET /api/v1/orders/:id` 查单，`POST /api/v1/orders/:id/refresh` 请求补偿刷新；认证规则见 [架构说明](./architecture.md)。

参考：[支付宝异步通知规范](https://developer.alibaba.com/docs/doc.htm?articleId=105902&docType=1&source=search&treeId=193)、[统一交易查询](https://developer.alibaba.com/docs/doc.htm?articleId=757&docType=4&treeId=180)。

## 6. 从验证到开放收款

先完成本地自动化检查和沙箱联调，再验证正式环境。沙箱通过不代表正式产品权限、域名、正式密钥和资金到账已通过。

正式小额验收至少覆盖：产品服务端创建固定 SKU 订单、实际付款、支付宝通知验签与金额/PID/AppID 核对、订单持久化、产品 webhook 验签和幂等开通、回跳后后端查单、关闭浏览器仍能开通，以及通知暂时失败后计划任务能补偿。分别保留订单号、支付宝交易号和最终开通状态，避免在证据中展示密钥或完整买家信息。

桌面客户端和 Android 首版通过系统浏览器打开 HTTPS 支付页面，付款后跳转到允许的产品 HTTPS 页面。自动切回原生应用、原生 SDK 调起和深链回跳未包含在首版验收范围。

完成以上验证，再开启 `PAYMENT_ENABLED=true` 并仅开放已确认签约的渠道。真实退款及售后处理需要独立验证；首版没有提供自动退款功能。

## 尚需现场确认的阻塞项

- 应用现场状态为开发中，须完善真实资料、完成接口加签及应用审核；电脑网站支付、手机网站支付各自的签约状态仍需核对。
- 接口加签现场状态为未设置，须配置 RSA2 普通公钥模式并安全保存应用私钥，取得对应支付宝公钥及收款 PID。
- `pay.bornforthis.cn` 的 DNS / Cloudflare 控制权、实际部署及 HTTPS 状态。
- 私有数据仓库、初始分支及最小权限令牌是否准备完成。
- 首个产品的真实 SKU / 价格、产品后端 webhook 和允许的 HTTPS 回跳 origin。
- 实际经营主体、商品售后信息及支付宝对当前域名和业务的要求。
- 正式小额付款及产品实际开通证据。

这些项应通过当前控制台、部署结果和真实交易核实；本文件没有把它们标记为已完成。
