# 商户配置准备

首次部署选择 `dual`、`alipay` 或 `wechat`，只提供所选渠道的商户资料。管理员密码、收银台签名密钥及会话密钥可由工具生成；Cloudflare 和私有 GitHub 仓库仍需部署者授权。流程见 [deployment.md](deployment.md)，变量用途及生成方法见 [environment-variables.md](environment-variables.md)。

## 支付宝：电脑网站与手机网站支付

本项目实现 `alipay.trade.page.pay`（`page`）和 `alipay.trade.wap.pay`（`wap`），采用 RSA2 普通公钥模式。使用自己的网页应用，确认对应产品已签约且应用获准使用；AppID 存在不代表两项支付能力都已开通。参考 [支付宝网站支付接入](https://developer.alibaba.com/docs/doc.htm?articleId=105899&docType=1&treeId=270) 与 [官方 Node.js SDK 配置](https://github.com/alipay/alipay-sdk-nodejs-all#平台配置)。商户准入和实际权限以当前平台为准。

| 输入字段 | 环境变量 | 取得方式 |
| --- | --- | --- |
| `alipay.appId` | `ALIPAY_APP_ID` | 自己的支付宝网页应用 AppID。 |
| `alipay.sellerId` | `ALIPAY_SELLER_ID` | 实际收款支付宝账号的用户 ID / PID；不是 AppID。 |
| `alipay.privateKeyFile` | `ALIPAY_PRIVATE_KEY` | 可信本机生成、与该应用已登记公钥配对的 RSA 私钥 PEM。 |
| `alipay.publicKeyFile` | `ALIPAY_PUBLIC_KEY` | 配置应用公钥后由支付宝提供的支付宝公钥 PEM；不是自己的应用公钥。 |
| `alipay.gateway`（可选） | `ALIPAY_GATEWAY` | 首次安装工具只生成正式配置，此处一般省略；如填写仅接受正式官方网关。 |

新应用可在可信本机生成 RSA 密钥对，将应用公钥上传支付宝，私钥留在 `secrets/`。已有正式应用复用已登记、已配对密钥，不为部署重新生成。支付宝公钥必须从支付宝取得。

```sh
umask 077
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out secrets/alipay-private.pem
openssl pkey -in secrets/alipay-private.pem -pubout -out secrets/alipay-app-public.pem
```

应用私钥签名商户请求，支付宝公钥验证平台返回。当前初始化入口不支持支付宝证书模式，不能把证书直接填作公钥。沙箱需使用对应沙箱 AppID、密钥和网关，沙箱通过不证明正式收款通过。

## 微信：Native 扫码支付

本项目接入普通直连商户 APIv3 Native 支付。需要 Native 产品权限及商户号与 AppID 绑定，按 [Native 开发接入准备](https://pay.wechatpay.cn/doc/v3/merchant/4015614538) 核对。Native 返回 `code_url` 供二维码展示，由用户微信扫一扫付款；本项目未实现 JSAPI、H5 或原生 App SDK 支付。[Native 产品介绍](https://pay.wechatpay.cn/doc/v3/merchant/4012791874)

| 输入字段 | 环境变量 | 取得方式 |
| --- | --- | --- |
| `wechat.merchantId` | `WECHAT_MCH_ID` | 自己的直连商户号。 |
| `wechat.appId` | `WECHAT_APP_ID` | 已认证且已绑定此商户号的 AppID。 |
| `wechat.serialNo` | `WECHAT_SERIAL_NO` | 商户 API 证书序列号。 |
| `wechat.privateKeyFile` | `WECHAT_PRIVATE_KEY` | 申请商户 API 证书时生成的 `apiclient_key.pem`。 |
| `wechat.apiV3KeyFile` | `WECHAT_API_V3_KEY` | 商户平台设置的 APIv3 密钥，以 32 字节文本文件提供。 |
| `wechat.publicKeyId` | `WECHAT_PUBLIC_KEYS_JSON` 的键 | 微信支付公钥 ID，形如 `PUB_KEY_ID_...`。 |
| `wechat.publicKeyFile` | `WECHAT_PUBLIC_KEYS_JSON` 的值 | 对应该 ID 的微信支付公钥 PEM，工具生成 ID 到 PEM 的 JSON 映射。 |

商户超级管理员在商户平台“账户中心 → API安全”申请证书并设置 APIv3 密钥；私钥来自证书工具。`openssl x509 -in secrets/apiclient_cert.pem -noout -serial` 可查看商户证书序列号。[申请商户 API 证书](https://pay.wechatpay.cn/doc/v3/merchant/4012072428)、[配置 APIv3 密钥](https://pay.wechatpay.cn/doc/v3/merchant/4012072195)

微信支付公钥用于验证微信应答和回调，APIv3 密钥用于解密回调资源。两者与商户签名私钥用途不同。新接入按 [微信支付公钥指引](https://pay.wechatpay.cn/doc/v3/merchant/4012153196) 获取对应 ID 与公钥，不以商户公钥、支付宝公钥或临时本机密钥替代。既有平台证书配置的轮换需保留仍在用的验签材料并验证过渡，不因首次部署示例而清空原映射。

## 通知、验收与维护

服务端下单设置支付宝通知 `<PAY_BASE_URL>/api/alipay/notify` 或微信通知 `<PAY_BASE_URL>/api/wechat/notify`；这些公网 HTTPS 入口应允许平台 POST，不能被登录页或人机验证拦截。支付宝返回页 `<PAY_BASE_URL>/payment/return` 用于展示、查单，不确认付款。

新部署初始关闭收款。完成商品配置和产品端幂等 webhook 后，按部署文档核实正式小额付款、精确金额/币种/商户与应用、通知持久化和实际权益。私钥与 APIv3 密钥只进入本机受限文件及服务端 Secret；通用 Skill、开源文档和客户端仅出现字段名与占位符。轮换前核对平台登记、公私钥配对和历史待处理交易。
