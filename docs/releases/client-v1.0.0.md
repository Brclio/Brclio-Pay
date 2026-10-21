# Brclio Pay 客户端 1.0.0

Mac、Windows 和 Android 管理客户端连接统一支付后台，可查看概览、订单、支付宝及微信账单，管理平台与授权，导出文件和查看环境说明。首次使用仍需管理员登录。

- Mac：Apple 芯片与 Intel 两种安装包，最低 macOS 13。
- Windows：64 位安装程序，适用于 Windows 10 / 11。
- Android：通用 APK，最低 Android 8。
- 客户端提供在线版本检查。更新信息使用固定公钥验证签名，安装文件核对大小与 SHA-256；Mac 使用应用替换与启动确认，Windows 使用安装程序，Android 使用系统安装器确认升级。
- 切换后台页面会复用当前页面缓存，点击“刷新数据”获取最新业务数据。客户端不会嵌入支付商户私钥或 GitHub 凭据。

安装包均从本项目 GitHub Releases 下载。Mac 当前采用临时签名，未取得 Apple Developer ID 签名及公证；Windows 当前未取得 Authenticode 签名，首次运行可能出现系统信任提示。Android 使用固定正式发布密钥签名，后续更新沿用同一证书。源码测试和各平台验证范围另见发布验收记录，不能将打包成功视为所有系统的原生运行验证。
