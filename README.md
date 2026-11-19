# Brclio Pay

开源的支付宝与微信收银服务，支持两种独立部署方式：Cloudflare Workers + 私有 GitHub 数据仓库，或自有服务器 / 宝塔 + 本地 SQLite。两种方式均支持支付宝 + 微信、仅支付宝或仅微信。服务入口使用部署者自己的 HTTPS 域名；现有 Brclio 入口为 `https://pay.bornforthis.cn`，当前运行位置以线上核验为准。

首次部署见 [人工 / AI 部署文档](docs/deployment.md)、[服务器 / 宝塔部署](docs/server-deployment.md)、[环境变量完整清单](docs/environment-variables.md) 与 [商户资料取得方式](docs/merchant-setup.md)。独立 [brclio-pay-deploy 部署 Skill](skills/brclio-pay-deploy/SKILL.md) 按所选方式部署。Cloudflare 方式使用 `setup:deployment`，服务器方式使用 `setup:server`；初始化工具生成内部密钥及管理员认证参数，只要求所选支付渠道的商户资料。服务器新安装不需要 Cloudflare 或 GitHub 数据仓库授权，业务数据和运行配置都保存在 SQLite，不依赖 `.env` 保存密钥。公开文档与 Skill 不包含实际值；管理员可在维护页逐项查看当前部署值。

已部署支付中心的产品，使用下列接入 Skill 和单产品受限授权，完成签名下单、外部收银台、付款通知、幂等权益开通与客户端刷新：

| 支付范围 | 完整 Skill |
| --- | --- |
| 支付宝 + 微信 | [brclio-pay-integrate](skills/brclio-pay-integrate/SKILL.md) |
| 仅支付宝 | [brclio-alipay-integrate](skills/brclio-alipay-integrate/SKILL.md) |
| 仅微信 | [brclio-wechatpay-integrate](skills/brclio-wechatpay-integrate/SKILL.md) |

首页可直接下载三种产品接入 ZIP，以及独立的 [部署 Skill ZIP](https://pay.bornforthis.cn/api/skills/brclio-pay-deploy.zip)；后台产品授权仅对应前三种接入 Skill。接入包包括协议、项目扫描器、context/plan/apply CLI、签名客户端、webhook 和客户端完成状态模板；部署包包括人工部署、环境与商户参考资料。通用包不包含商户、管理员、GitHub 或产品凭据。

## 已实现的支付能力

支付宝使用 `page` / `wap` 电脑与手机网站支付；微信使用 `native` 扫码。网页、桌面、Android/iOS 均可打开外部 HTTPS 收银台，微信 Native 需要微信扫一扫。原生 App SDK、微信 JSAPI/H5、小程序支付及自动深链回到客户端未作为本服务现有能力提供。

平台配置 `providers` 控制可使用的支付方式。下单 `provider` 为 `alipay` 或 `wechat`，省略时兼容已有支付宝客户端。每笔订单固选 provider、商品与金额，幂等重试保留原单，不能暗中改价或改变渠道。验签通知与查单确认付款后，订单、稳定 outbox 事件、统计和队列原子落库：Cloudflare 使用同一个 Git 提交，服务器使用同一个 SQLite 事务；产品以持久事务幂等开通权益。

管理员可查看经营概览、订单查询与 CSV、支付宝/微信独立账单、环境变量说明及当前部署值、商品价格、平台配置、短期授权及审计。私密环境值默认隐藏，登录后点击单项查看才读取，并在隐藏、离开维护页或退出时清除页面内容。账单按上海付款月份统计并支持完整 CSV，环境说明独立保存在所选数据后端。订单可核实关单、重新启用新的付款尝试、验真补记，保留重复实付证据并只通知一次产品权益。营业额表示已确认付款，不代表净结算或退款后收入。退款与退款后的权益调整需要独立实现或人工处理。

Mac、Windows、Android 管理客户端提供同一后台、文件导出及签名版本检查，安装与更新文件托管于 GitHub Releases。[客户端下载](https://pay.bornforthis.cn/clients) · [构建与更新说明](docs/clients.md)。

## 数据与历史兼容

Cloudflare 方式把独立明文 JSON 保存到部署者自己的私有 GitHub 数据仓库，由限定该仓库的 GitHub App 安装令牌读写；既有 Cloudflare 环境使用 `BrclioData/BrclioPay-Data`。服务器方式将相同记录、索引和 outbox 保存在本地 SQLite，运行参数与商户、管理员配置保存在独立配置表，运行时不访问 GitHub。订单和事件保留上海年月分区及独立定位索引；平台、授权、计划与审计独立保存。两种部署不自动同步业务数据，不能把独立账本同时当作一个生产账本使用。商户私钥和运行凭据仅供服务端使用及管理员按需查看，不进入公开页面、客户端包或临时产品接入授权。

历史支付宝与微信账本迁移保留原始证据、订单身份、金额、事件去重、投递记录和已接入产品凭据；原系统回调及旧链接需要连续兼容。GitHub → SQLite 迁移会保留全部原始文件、部署参数及校验摘要；私密恢复包也可从 SQLite 导出，工具不会自动修改备用 Cloudflare / GitHub 环境。迁移步骤见 [服务器部署文档](docs/server-deployment.md)，既有验收记录见 [交付状态](docs/status.md)。部署成功不等于真实到账或产品权益验收完成。

## 开发与验证

```sh
npm ci
node scripts/sync-docs.mjs
node scripts/build-skill.mjs
npm run check
npm run test:runtime
npm run test:security-runtime
npm run test:migration
npm run test:server
node --test tests/migrate-sqlite.test.mjs
```

`node scripts/build-skill.mjs` 同步三个产品接入包、独立部署包及 Worker 内置资源；不向包内写入任何任务凭据。运行时测试使用临时内存密钥和模拟上游，不发起真实付款。

产品协议见 [docs/integration.md](docs/integration.md)，后端示例见 [examples/payment-client.mjs](examples/payment-client.mjs)。部署前核对目标账号或服务器目录、所选后端权限、原凭据连续性与迁移清单；发布后分别核对域名证书、订单/目录读取、回调边界、真实付款与产品实际开通证据。

页面沿用 [Brclio Design System](https://github.com/Brclio/brclio-design-system) 品牌规范，署名 Brclio；本地二维码组件许可证保留于 `public/vendor/qrcode.LICENSE.txt`。
