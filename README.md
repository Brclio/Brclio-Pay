# Brclio Pay

统一的支付宝与微信收银服务，运行在 Cloudflare Workers，通过 Cloudflare Pages 提供 `https://pay.bornforthis.cn` 入口。产品只需使用对应完整 Skill 和单平台受限授权，让项目 AI 接入签名下单、外部收银台、付款通知、幂等权益开通与客户端状态刷新。

| 支付范围 | 完整 Skill |
| --- | --- |
| 支付宝 + 微信 | [brclio-pay-integrate](skills/brclio-pay-integrate/SKILL.md) |
| 仅支付宝 | [brclio-alipay-integrate](skills/brclio-alipay-integrate/SKILL.md) |
| 仅微信 | [brclio-wechatpay-integrate](skills/brclio-wechatpay-integrate/SKILL.md) |

首页可直接下载三种独立 ZIP；后台选择对应 Skill 后可复制不含凭据的说明、下载完整包，或生成包含完整 Skill 与最长两小时单平台授权的任务。每个包包括协议、项目扫描器、context/plan/apply CLI、后端签名客户端、webhook 模板和无密钥的客户端完成状态模板。通用 Skill 不包含商户、管理员、GitHub 或产品凭据。

## 已实现的支付能力

支付宝使用 `page` / `wap` 电脑与手机网站支付；微信使用 `native` 扫码。网页、桌面、Android/iOS 均可打开外部 HTTPS 收银台，微信 Native 需要微信扫一扫。原生 App SDK、微信 JSAPI/H5、小程序支付及自动深链回到客户端未作为本服务现有能力提供。

平台配置 `providers` 控制可使用的支付方式。下单 `provider` 为 `alipay` 或 `wechat`，省略时兼容已有支付宝客户端。每笔订单固选 provider、商品与金额，幂等重试保留原单，不能暗中改价或改变渠道。验签通知与查单确认付款后，订单、稳定 outbox 事件、统计和队列在同一个 Git 提交内落库；产品以持久事务幂等开通权益。

管理员保留经营概览、订单查询与 CSV、商品价格、平台配置、短期授权及审计。订单可核实关单、重新启用新的付款尝试、验真补记，保留重复实付证据并只通知一次产品权益。营业额表示已确认付款，不代表净结算或退款后收入。退款与退款后的权益调整需要独立实现或人工处理。

## 数据与历史兼容

所有持久业务数据以明文 JSON 保存在指定私有仓库 `BrclioData/BrclioPay-Data`，由 GitHub App 安装令牌读写。订单、事件按上海年月分目录并独立保存，ID 定位索引与业务幂等索引分片保存；平台注册表按平台、授权、计划与年月审计分别保存。商户私钥、GitHub App 私钥和运行凭据留在服务端配置，不进入前端或客户端包。

历史支付宝与微信账本迁移保留原始证据、订单身份、金额、事件去重、投递记录和已接入产品凭据；原系统回调及旧链接需要连续兼容。迁移工具与验收记录见 [部署文档](docs/deployment.md) 和 [交付状态](docs/status.md)。部署成功不等于真实到账或产品权益验收完成。

## 开发与验证

```sh
npm ci
npm run check
npm run test:runtime
npm run test:security-runtime
npm run test:migration
```

`node scripts/build-skill.mjs` 同步三个完整包的模板与 Worker 内置资源；不向包内写入任何任务凭据。运行时测试使用临时内存密钥和模拟上游，不发起真实付款。

产品协议见 [docs/integration.md](docs/integration.md)，后端示例见 [examples/payment-client.mjs](examples/payment-client.mjs)。部署前核对目标账号、GitHub App 安装范围、原凭据连续性与迁移清单；发布后分别核对域名证书、订单/目录读取、回调边界、真实付款与产品实际开通证据。

页面沿用 [Brclio Design System](https://github.com/Brclio/brclio-design-system) 品牌规范，署名 Brclio；本地二维码组件许可证保留于 `public/vendor/qrcode.LICENSE.txt`。
