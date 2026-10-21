# Brclio Pay 管理客户端

Mac、Windows 与 Android 客户端连接现有 `https://pay.bornforthis.cn/admin`，使用同一管理后台及管理员登录。订单、账单和接入配置仍由统一支付中心处理；不在客户端嵌入商户私钥、GitHub App 私钥或管理员凭据，也不新增业务数据库。

下载入口为 `https://pay.bornforthis.cn/clients.html`。安装文件托管于公开的 `Brclio/Brclio-Pay` GitHub Releases。下载页只有在签名验证、平台完整性与下载 URL 校验均通过后才显示可点击链接；还没有有效发布时，明确显示“尚无可用发布”。

## 支持范围

| 客户端 | 安装文件 | 最低系统 |
| --- | --- | --- |
| Mac / Apple 芯片 | `Brclio-Pay-<版本>-mac-arm64.dmg` | macOS 13 |
| Mac / Intel 芯片 | `Brclio-Pay-<版本>-mac-x64.dmg` | macOS 13 |
| Windows / Intel、AMD 64 位 | `Brclio-Pay-<版本>-windows-x64-setup.exe` | Windows 10 / 11 64 位 |
| Android / 通用 | `Brclio-Pay-<版本>-android-universal.apk` | Android 8 / API 26 |

Mac 的两个架构另各提供同名 `.zip` 更新文件。Windows ARM 设备的 x64 兼容运行取决于系统，本发布不提供 Windows ARM 原生包。

若构建环境没有 Apple Developer ID 证书、Apple 公证或 Windows Authenticode 证书，相应安装包不能声称已通过这些系统信任认证。macOS 可能显示无法验证开发者；Windows SmartScreen 可能显示未知发行者。请核对官方 GitHub 下载来源与 SHA-256，按照系统提示确认是否安装。Android APK 必须使用长期保留的正式签名密钥，更新时保持同一 applicationId 和签名；不得以调试 APK 代替正式包。

## 版本检查与更新

客户端版本独立于 Worker 版本，统一记录在 `clients/shared/release-settings.json`。发布标签格式为 `client-v<版本>`。`1.0.0` 的 Android versionCode 为 `1000000`；计算规则为 `major * 1000000 + minor * 1000 + patch`，各段最多三位且禁止前导零。

后续发版同时更新桌面 `package.json` / lockfile 的版本，以及 Windows 验证流程和 PowerShell 脚本中的正式版本、上一版 fixture 与产物文件名。Android 默认读取共享版本。保留现有 RSA 更新私钥和 Android 发布密钥；每版重新构建并收集对应源码提交和文件摘要的验证证据，不能复用旧版核验记录。

版本入口为 `https://pay.bornforthis.cn/client-update.json`；客户端也可使用共享配置中的 GitHub Release 备用入口。元数据使用下列签名封装：

```json
{"schema":1,"algorithm":"RSA-SHA256","payload":"<manifest JSON 的 UTF-8 base64>","signature":"<RSA-SHA256 签名的 base64>"}
```

公钥固定在 `clients/shared/update-public-key.pem`，并随各客户端打包；网页的固定公钥须保持一致。元数据包含所有四个平台的文件名、精确 GitHub Release URL、文件字节数和 SHA-256。下载完成后仍须核验安装文件摘要，不能只信任版本号或 HTTPS。当前版本与历史已接受版本比较，拒绝降级。网页只保存最高已验签客户端版本号，不保存业务数据。

RSA 私钥仅保存在忽略目录 `secrets/client-release-signing-key.pem`，权限为 0600，不进入源仓库或安装包。Android 签名密钥与 RSA 元数据签名密钥用途不同，二者均应单独备份。不要重新生成已发布客户端的信任根来代替正常升级。

## 可审计发布流程

1. 完成源代码、客户端测试和本机可执行的安装验证，将源码提交到 Git；源码工作区必须干净。构建可执行包使用这个提交，不把真实订单、后台会话、`.env` 或 `secrets/` 放入源码或包中。
2. 按各客户端构建说明生成 `dist-clients/` 中的六个文件：两个 Mac DMG、两个 Mac ZIP、一个 Windows EXE、一个正式签名 Android APK。各文件名必须和共享版本一致。对非本机系统，应分别记录交叉构建和原生运行证据，不能将交叉构建成功写成该系统的安装成功。
3. 默认只读审计：`node clients/scripts/release-manifest.mjs`。它检查干净源提交、完整文件集、体积、摘要、ZIP/APK 条目、运行凭据精确匹配及真实私钥泄漏；ZIP/APK 解压内容也会扫描。DMG/NSIS 的解压内容还需要在对应构建审计中核验，工具的 JSON 报告明确记录扫描范围。
4. 收集综合核验 JSON，绑定同一干净源码提交及六个安装/更新文件的字节数、SHA-256。必须包含 Mac ARM 原生和 Intel/Rosetta 打包客户端登录隔离检查、Mac 生产更新 helper 的独立重签 fixture 成功与回滚、Android 模拟器或真机的系统安装升级及配置保留、Windows 原生 runner 的 NSIS 安装升级及配置保留。各项应明确环境、核验范围和原始报告摘要，不能把 helper fixture 写成正式包完整端到端更新。写好发布说明后执行 `node clients/scripts/release-manifest.mjs --prepare --notes <本地说明文件> --evidence <综合核验JSON>`。缺少核验证据、核验范围或任一文件/源码摘要不一致均拒绝准备。只有审计通过才生成 `dist-clients/client-update.json`、`SHA256SUMS` 和 `release-audit.json`。签名工具会校对私钥和固定公钥，并对生成的完整 envelope 再验签。
5. 创建 GitHub 草稿发布 `client-v<版本>`，指定步骤 1 的源码提交，上传全部六个安装/更新文件及上述三个元数据文件。回读 GitHub API，逐一核对文件名、字节数和 `sha256:` digest；确认没有缺件后再将草稿发布。不要上传含会话、凭据或本地绝对目录的诊断文件。
6. 正式发布后执行 `node clients/scripts/release-manifest.mjs --copy-public --evidence <同一综合核验JSON>`。它读取步骤 4 已签名的同一份 envelope，再验签、本地产物摘要与 GitHub 已发布 Release 的 digest；全部一致才原字节复制到 `public/client-update.json`。这一步不会重新签名或改变发布时间。提交这个公开元数据并部署网站入口，保留实际二进制对应的源码提交证据。
7. 核验线上下载页验签、四个平台链接、线上 envelope 与 Release envelope 完全一致、文件大小及摘要；客户端版本检查应对当前版本显示已是最新，对上一版本显示可更新。记录真实本机验证范围及未取得的签名/公证状态。

默认审计和签名准备均不创建、上传或发布 GitHub Release，不部署 Cloudflare。`--copy-public` 也只在本地写公开元数据；实际网站部署沿用项目正常发布流程。

## 检查

```sh
node --test tests/client-release.test.mjs
```

这些测试包含 Node 与浏览器 WebCrypto 的跨实现验签、篡改拒绝、文件与平台缺失、URL 注入、版本不符、降级、私钥占位文档与真实私钥区分，以及未提交源码拒绝。客户端各自的测试与运行验证需另行执行；这里的通过结果不代表 Windows 原生安装或 Android 真机运行已经验证。
