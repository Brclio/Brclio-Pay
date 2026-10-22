# 支付宝配置与上线检查

首次自行部署使用 [商户配置准备](merchant-setup.md) 的支付宝部分和 [部署文档](deployment.md)，选择 `providerMode=alipay` 或 `dual`。完整变量用途、生成方式和展示边界见 [环境变量说明](environment-variables.md)。

当前支持 RSA2 普通公钥模式的电脑网站支付 `page` 与手机网站支付 `wap`。需要自己的 AppID、实际收款 PID、与应用已登记公钥配对的应用私钥，以及支付宝提供的支付宝公钥。商户应用、支付产品签约、密钥配置、代码部署、真实到账和产品权益开通是独立验收状态。

已有 Brclio 生产应用 `2021007109602288` 的维护必须保留原商户凭据、CHECKOUT_SECRET、产品 API/Webhook 密钥与管理员认证参数，不能运行首次安装工具生成替代配置。生产账号、Worker、Pages 网关和迁移流程见部署文档的“既有 Brclio 生产服务发布”；历史现场与交付证据见 [status.md](status.md)，历史观察不代表当前平台状态。

订单、通知和产品资料仅保存为私有 GitHub 数据仓库中的明文 JSON，使用限定该仓库的 GitHub App 安装令牌读写；不新增业务数据库。旧 PAT 和加密注册表方案不是新部署路径。公开源码中不存放私钥、产品凭据、会话或真实业务数据。

服务端通知地址为 `<PAY_BASE_URL>/api/alipay/notify`，返回地址为 `<PAY_BASE_URL>/payment/return`。通知验签后仍须核对 AppID、PID、CNY 与订单保存的精确金额；前台跳转不确认付款。产品端必须持久化事务去重，并在实际权益提交后刷新客户端状态。
