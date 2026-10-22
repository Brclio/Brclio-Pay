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

从 1.0.1 起，Mac DMG 内提供安装助手；Windows 的启动程序、安装程序和卸载程序使用固定自签证书。Mac 没有 Apple Developer ID 签名，也未通过 Apple 公证；Windows 自签证书没有公共证书机构的身份背书，系统默认不会自动信任。发布清单的 RSA 签名用于核对官方发布文件，与系统代码签名信任分别校验。

### Mac 首次安装

1. 从官方页面下载对应 Apple / Intel 芯片的 DMG，双击挂载。
2. 打开 DMG 内的 `安装 Brclio Pay.command`。若系统拦截助手，打开“终端”，输入 `/bin/bash` 和一个空格，将这个 `.command` 文件拖入终端，回车执行。
3. 助手核对应用身份、版本、架构、自签代码证书及 RSA 签名逐文件清单；阅读提示后输入明确确认短语，才会安装到当前用户的 `~/Applications/Brclio Pay.app`。请退出正在运行的旧版，再从这个新路径打开，避免继续打开 `/Applications` 中的旧副本。
4. 助手只移除已验证的应用副本自身的下载隔离标记，不使用 `sudo`、不关闭全局 Gatekeeper，也不为 Mac 安装根证书信任。若系统仍有提示，可在“系统设置 → 隐私与安全性”中核对 Brclio Pay 后选择“仍要打开”。

DMG 同时附有 `安装说明.txt`。安装助手属于用户主动确认的本地安装支持，不能称为 Apple 公证或保证绕过组织安装策略。官方说明：[Apple：在 Mac 上安全打开 App](https://support.apple.com/102445)。

### Windows 签名与安装

先核对下载页显示的本版安装程序 SHA-256。Windows 支持文件与安装程序保存在同一版 GitHub Release：

- `Brclio-Pay-Windows-Code-Signing.cer`：仅公开代码签名公钥。
- `Brclio-Pay-Windows-Signing.md`：包含完整证书指纹、PowerShell 校验、当前用户信任与撤销步骤。
- `client-installation.json`：用现有 RSA 发布密钥独立签名，绑定本版证书和说明文件的名字、URL、大小、SHA-256。

当前固定 CER 文件 SHA-256：

```text
f790fdc69416ab498774854f46ca179a2fb8fe6c4c44f8e7fcb7d7d7037e3200
```

证书 SHA-1 定位指纹为 `54E4378450A3DB86C0D11E338FA30B0FD8C19A4B`；主体为 `C=CN / O=Brclio / CN=Brclio Pay`。SHA-1 只用于 Windows 证书定位，文件完整性使用 SHA-256。

未信任根证书时，`Get-AuthenticodeSignature` 可能显示 `UnknownError`；只有原生 `WinVerifyTrust` 的 `0x800B0109` 可明确归类未信任根，其它 `UnknownError` 不能当正常，`NotTrusted` 也可能代表显式不信任。先核对固定 CER 和本版安装程序的 SHA-256，尚未通过时不运行安装程序。若依据已验签发布清单决定信任固定公钥，再按本版说明手动导入 `Cert:\CurrentUser\Root` 与 `Cert:\CurrentUser\TrustedPublisher`，并重新确认签名状态为 `Valid`；仍失败则停止并撤销信任。导入代表当前用户信任这张证书签名的代码，不是仅对一个文件的临时例外；不使用 LocalMachine，也不自动导入。

导入自签证书不保证 SmartScreen 的信誉提示消失。客户端不关闭 Defender、SmartScreen 或修改组织策略。签名缺失、`HashMismatch`、证书或 SHA-256 不匹配时应停止安装；管理设备无法允许时可继续使用网页后台。参见 [Microsoft 签名说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_signing) 与 [Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.5)。

### Android 安装

首次安装 APK 时，根据系统提示为当前下载来源允许安装。Android APK 使用长期保留的正式签名密钥，更新时保持同一 applicationId 和签名，不使用调试 APK。客户端验证更新文件后交给系统安装器，由用户确认。

## 版本检查与更新

客户端版本独立于 Worker 版本，统一记录在 `clients/shared/release-settings.json`。发布标签格式为 `client-v<版本>`。`1.0.1` 的 Android versionCode 为 `1000001`；计算规则为 `major * 1000000 + minor * 1000 + patch`，各段最多三位且禁止前导零。

后续发版同时更新桌面 `package.json` / lockfile 的版本，以及 Windows 验证流程和 PowerShell 脚本中的正式版本、上一版 fixture 与产物文件名。Android 默认读取共享版本。保留现有 RSA 更新私钥和 Android 发布密钥；每版重新构建并收集对应源码提交和文件摘要的验证证据，不能复用旧版核验记录。

版本入口为 `https://pay.bornforthis.cn/client-update.json`；客户端也可使用共享配置中的 GitHub Release 备用入口。元数据使用下列签名封装：

```json
{"schema":1,"algorithm":"RSA-SHA256","payload":"<manifest JSON 的 UTF-8 base64>","signature":"<RSA-SHA256 签名的 base64>"}
```

公钥固定在 `clients/shared/update-public-key.pem`，并随各客户端打包；网页的固定公钥须保持一致。元数据包含所有四个平台的文件名、精确 GitHub Release URL、文件字节数和 SHA-256。下载完成后仍须核验安装文件摘要，不能只信任版本号或 HTTPS。当前版本与历史已接受版本比较，拒绝降级。网页只保存最高已验签客户端版本号，不保存业务数据。

RSA 私钥仅保存在忽略目录 `secrets/client-release-signing-key.pem`，权限为 0600，不进入源仓库或安装包。Android 签名密钥与 RSA 元数据签名密钥用途不同，二者均应单独备份。不要重新生成已发布客户端的信任根来代替正常升级。

## 可审计发布流程

1. 完成源代码、客户端测试和本机可执行的安装验证，将源码提交到 Git；源码工作区必须干净。构建可执行包使用这个提交，不把真实订单、后台会话、`.env` 或 `secrets/` 放入源码或包中。
2. 按各客户端构建说明生成 `dist-clients/` 中的六个文件：两个 Mac DMG、两个 Mac ZIP、一个 Windows EXE、一个正式签名 Android APK。各文件名必须和共享版本一致。1.0.1 起额外准备固定命名 CER 和签名说明；工具会从跟踪的公开证书、identity JSON 与说明模板生成并核对这两份支持文件。对非本机系统，应分别记录交叉构建和原生运行证据，不能将交叉构建成功写成该系统的安装成功。
3. 默认只读审计：`node clients/scripts/release-manifest.mjs`。它检查干净源提交、完整文件集、体积、摘要、ZIP/APK 条目、运行凭据精确匹配及真实私钥泄漏；ZIP/APK 解压内容也会扫描。DMG/NSIS 的解压内容还需要在对应构建审计中核验，工具的 JSON 报告明确记录扫描范围。
4. 收集综合核验 JSON，绑定同一干净源码提交及八个文件的字节数、SHA-256（原六包加 CER、签名说明）。保留原五项原生检查：Mac ARM 和 Intel/Rosetta 打包客户端登录隔离、Mac 生产更新 helper 独立重签 fixture 成功与回滚、Android 系统安装升级及配置保留、Windows 原生 NSIS 安装升级及配置保留。1.0.1 起再要求 Mac 下载隔离应用经确认安装启动、Windows Authenticode 导入当前用户信任前后签名检查，共七项。各项明确环境、核验范围和原始报告摘要，不能把 helper fixture 写成正式包完整端到端更新。写好说明后执行 `node clients/scripts/release-manifest.mjs --prepare --notes <本地说明文件> --evidence <综合核验JSON>`。缺少任何核验、范围、文件或源码摘要不一致均拒绝准备。审计通过后生成 `client-update.json`、`SHA256SUMS`、`release-audit.json`，以及独立签名的 `client-installation.json`；签名工具会核对固定公钥并对生成的 envelope 再验签。原更新清单 schema 不变，1.0.0 客户端可继续升级。
5. 创建 GitHub 草稿发布 `client-v<版本>`，指定步骤 1 的源码提交，上传六个安装/更新包、两个公开支持文件和四个元数据文件，共 **12 个固定资产**。回读 GitHub API，逐一核对文件名、字节数和 `sha256:` digest；缺失、多余、摘要不符均拒绝通过。不要上传含会话、私钥、凭据或本地绝对目录的诊断文件。
6. 正式发布后执行 `node clients/scripts/release-manifest.mjs --copy-public --evidence <同一综合核验JSON>`。它读取已签名的更新和安装支持 envelope，再验签、核对本地产物摘要、公开证书 identity 和 GitHub 正式 Release 的全部 digest；全部一致才原字节复制到 `public/client-update.json` 与 `public/client-installation.json`，不会重新签名或改变发布时间。提交公开元数据并部署网站入口，保留实际二进制对应的源码提交证据。
7. 核验线上下载页验签、四个平台链接、线上 envelope 与 Release envelope 完全一致、文件大小及摘要；客户端版本检查应对当前版本显示已是最新，对上一版本显示可更新。记录真实本机验证范围及未取得的签名/公证状态。

默认审计和签名准备均不创建、上传或发布 GitHub Release，不部署 Cloudflare。`--copy-public` 也只在本地写公开元数据；实际网站部署沿用项目正常发布流程。

## 检查

```sh
node --test tests/client-release.test.mjs
```

这些测试包含 Node 与浏览器 WebCrypto 的双清单验签、篡改拒绝、文件与平台缺失、URL 注入、版本不符、降级、私钥占位文档与真实私钥区分、未提交源码拒绝、公开证书一致性与支持说明生成，以及 12 资产 / 7 原生检查门槛。客户端各自的测试与运行验证需另行执行；这里的通过结果不代表 Windows 原生安装或 Android 真机运行已经验证。
