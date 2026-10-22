# 2026-10-22 上线复核

当前服务版本为 1.2.0，管理客户端为 1.0.0。下载入口：[pay.bornforthis.cn/clients](https://pay.bornforthis.cn/clients)；安装包与原始审计文件：[client-v1.0.0](https://github.com/Brclio/Brclio-Pay/releases/tag/client-v1.0.0)。

## 本轮重新执行

- 550 项项目测试、TypeScript 检查、Worker 构建及 workerd 支付、安全、管理员、注册表和网络存储运行时检查全部通过。运行时测试使用隔离数据与模拟上游，不产生真实付款。
- 主域名与直连 Worker 的健康、版本、管理页、收银台、静态资源完整性及匿名访问边界全部通过。客户端页面、脚本、样式和主/备用更新清单与本地发布文件逐字节相同，固定公钥验签通过。
- 使用受限 GitHub App 安装令牌只读扫描既有账本，并逐笔通过现有 API 核对订单身份、状态、金额和渠道；现有产品目录、报表完整覆盖与总额一致。三种公开 Skill 下载和匿名拒绝边界验证通过。
- GitHub Release 的九个文件与首次发布的大小和 SHA-256 一致，六个安装/更新文件同时匹配签名清单、SHA256SUMS 和 release-audit。标签指向二进制源码提交 `839c5a8acc07abe40eeb5b66abfeadad238bd61d`，latest 指向该正式版本。客户端源码与该标签一致。
- Mac 两个正式架构包重新启动，登录页面和远程页面隔离检查通过；Intel 包在 Rosetta 下验证。Windows 原生安装升级的 GitHub Actions 运行仍为 success，并绑定同一二进制源码。Android 正式 APK 重新核对签名、包名、版本和摘要。
- Cloudflare 30 个 Text 变量、0 个 Secret Text 及四个资源绑定与原值校验一致。两套 Pages 均为 main 的成功部署；业务数据仍只保存在指定私有 GitHub 仓库。

## 原始安装与升级证据

首次发布已完成 Windows 原生 NSIS 安装、旧版升级及配置保留；Mac 原样更新助手在独立重签测试副本中的成功替换、启动超时回滚及配置保留；Android 独立 API 35 模拟器的完整公开网络发现、下载、验签、系统安装器升级及最终最新版本检查。原始签名清单与安装包保持不变，后续复核记录独立保存。

Mac 的网络版本检查与更新助手 fixture 属于两项独立验证，不宣称完整 Mac 联网自动安装端到端验收；Android 模拟器证据不代表全部真机。Windows 原生运行证据见 [Actions 运行](https://github.com/Brclio/Brclio-Pay/actions/runs/39638772867)。

## 使用和验证范围

沿用现有支付后台账号登录。Mac 当前只有临时签名，尚无 Apple Developer ID 签名和公证，首次运行需要系统信任操作；Windows 尚无 Authenticode 商业签名，可能出现未知发行者提示。Android 后续升级须继续使用既有正式签名证书。

本次未创建订单、修改业务配置或发起实际扣款。已有历史实付记录的只读一致性验证，与发布后新付款到账、成功通知及真实产品权益开通属于不同验收范围。
