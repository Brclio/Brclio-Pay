# Brclio Pay desktop

Mac 与 Windows 客户端承载 `https://pay.bornforthis.cn/admin`，所有订单、账单、平台授权和环境变量说明沿用生产后台。登录 Cookie 留在此应用独立的本地 profile；安装包中没有管理员、GitHub App 或支付商户凭据。后台页面缓存与手动刷新保持网页行为。

本地壳与远程后台使用两个独立的 WebContents。只有本地壳预加载最小 IPC；后台没有 preload、Node 或原生桥，启用 Chromium sandbox/contextIsolation，导航仅允许固定后台。HTTPS 外链必须经本地对话框明确同意后交给系统浏览器。后台可通过原生保存对话框保存 CSV/ZIP，可复制文本；不授予读剪贴板、摄像头或文件系统权限。

## 构建

```sh
npm ci --prefix clients/desktop
npm run test --prefix clients/desktop
npm run build:mac:arm64 --prefix clients/desktop
npm run build:mac:x64 --prefix clients/desktop
npm run build:win --prefix clients/desktop
```

产物位于根目录 `dist-clients/`。Mac 为 DMG 和 ZIP；Windows 为 x64 NSIS 用户级安装程序。Mac 使用 ad-hoc 签名，尚无 Apple Developer ID 或公证；首次运行可能受到 Gatekeeper 阻止。Windows 未使用商业 Authenticode 证书，系统可能显示未知发布者。SHA-256 与应用更新描述的 RSA 签名用于核验发布内容，不替代操作系统的发布者认证。

## 更新

启动自动检查一次，也可手动“检查更新”。只接受固定公钥签名的 `client-update.json`，检查失败明确显示失败。更新必须属于 `Brclio/Brclio-Pay` 的 `client-v<version>` Release；下载检查发布资产 URL、大小和 SHA-256，安装前重新核验文件。

Mac ZIP 在当前应用所在卷建立私有暂存目录，检查 bundle id、版本、架构、代码签名与完整目录摘要。用户同意退出后，独立助手等待原进程退出，原子更换应用并保留回退副本；新版本确认本地壳启动后再删除回退副本。启动超时回滚。当前目录不可写时提供已核验的 DMG 手动安装。Windows 用户同意后退出并启动已核验的 NSIS；不请求自动提权。

## 安装包验证

```sh
npm run verify:packaged --prefix clients/desktop -- /absolute/path/to/Brclio-Pay-executable
```

生产可执行程序也支持 `--client-smoke-report <absolute-json-path> --client-profile <absolute-isolated-profile>`。该模式隐藏窗口，只读加载真实登录页并检测壳、HTTP 状态与远程隔离，输出安全字段后退出；不会登录、创建订单或更改后台数据。首次 profile 必须为空，复用只允许包含固定用途验证标记的目录，真实默认 profile 始终拒绝。报告不覆盖已有文件。升级前后可复用此专用 profile，报告包含前一轮成功版本与是否复用。

安全实现参考 [Electron 官方安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view) 与 [DownloadItem](https://www.electronjs.org/docs/latest/api/download-item)。界面沿用 Brclio Design System app template（Brclio / CC BY-NC-SA 4.0）。
