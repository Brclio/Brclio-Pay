# Brclio Pay Android

Java + Android WebView 客户端，直接连接 `https://pay.bornforthis.cn/admin`。登录、管理、支付核验和业务数据继续由支付中心处理；应用不包含商户、GitHub 或管理员凭证。

- 最低 Android 8 / API 26，目标 API 35。
- WebView 只加载支付中心 HTTPS；外部 HTTPS 用户点击交给系统浏览器。
- 禁止 file/content、混合内容、第三方 Cookie、网页权限、应用备份和 release 调试。
- AndroidX WebMessageListener 只允许支付中心精确来源且仅接受主 frame。桥仅提供复制、受限 CSV/ZIP 导出和外部 HTTPS 打开，不使用 `addJavascriptInterface`。
- CSV/Blob 导出分块传输，上限 16 MiB，经系统文件选择器保存；Skills ZIP 使用同源会话下载。
- 启动检查一次更新，支持手动检查。仅验证成功的 RSA-SHA256 发布清单可以选择官方 GitHub APK；下载校验大小、SHA256、包名、版本号与当前安装证书后，交由系统安装器确认。
- 选择“稍后”会在应用私有偏好设置中保留原始公开签名清单，APK 仅保存在固定私有缓存位置。重新打开或授权安装返回时，重新核验清单、APK 和当前安装证书后提供继续安装；候选超过 7 天、文件缺失、校验失败或版本已经更新时会清除并重新检查。此缓存不包含订单或商户数据，也不存储可选择的文件路径。
- 版本更新保留应用登录数据。退出登录使用后台的退出入口。

构建需要完整 JDK 17、Android SDK API 35、Build Tools 35.0.0，设置 `JAVA_HOME` 和 `ANDROID_HOME`。Gradle Wrapper 8.11.1 已固定校验和。

```sh
node clients/scripts/build-android.mjs --check
node clients/scripts/build-android.mjs --debug
# 正式版需在子进程环境提供四个 ANDROID_SIGNING_* 变量：
node clients/scripts/build-android.mjs
# 构建同包名、同签名的低版本模拟器升级验证种子：
node clients/scripts/build-android.mjs --seed-version-name=0.9.9 --seed-version-code=999999
```

四个签名变量是 `ANDROID_SIGNING_STORE_FILE`、`ANDROID_SIGNING_STORE_PASSWORD`、`ANDROID_SIGNING_KEY_ALIAS`、`ANDROID_SIGNING_KEY_PASSWORD`。签名材料只保留在被忽略的 `secrets/`；不要打印或提交。构建脚本先执行 Java 策略测试和 Android lint，再打包并通过 apksigner/aapt 核对身份，导出 `dist-clients/` APK、SHA256 和构建证据。安装与升级验证由独立模拟器流程完成，构建通过不代表已经安装或升级成功。

也支持直接向 Gradle 传入 `-PclientVersionName=0.9.9 -PclientVersionCode=999999`。默认正式版从共享配置取版本；版本覆盖不修改共享文件，不改变包名或签名。验证种子仅用于模拟器，不能作为正式发布资产。原生界面和更新判断始终读取实际安装包的 `BuildConfig` / PackageManager 版本。启动图标由 Gradle 仅从共享 `icon.png` 生成 Android 资源，APK 不包含桌面 ICO/ICNS。
