# Brclio Pay · Windows 签名与安装

本说明对应客户端 **@@VERSION@@**。安装包、启动程序和卸载程序使用 Brclio Pay 自签代码签名证书。自签名用于检查文件完整性和固定发布者密钥，**不代表 Microsoft 或公共证书机构已验证发布者身份**。Windows 默认不会信任这张证书，SmartScreen 的信誉提示也不因导入证书而保证消失。

先在 [官方客户端下载页](https://pay.bornforthis.cn/clients.html) 验证本版发布签名和文件 SHA-256，再决定是否为当前 Windows 用户信任此证书。公司管理的设备应遵守组织策略；无法允许时可直接使用 [网页管理](https://pay.bornforthis.cn/admin)。

## 1. 核对公钥证书

从同一版 GitHub Release 下载 `Brclio-Pay-Windows-Code-Signing.cer` 和安装程序。这份 `.cer` 只含公钥；无需取得或安装任何私钥/PFX。

- 证书主体：

```text
@@SUBJECT@@
```

- CER 文件 SHA-256：`@@CERT_SHA256@@`
- 证书 SHA-1 指纹：`@@CERT_SHA1@@`（仅用于 Windows 证书定位，完整性校验使用 SHA-256）

将两个文件放到当前用户的“下载”文件夹，在普通 PowerShell 中执行以下代码。它只处理上述固定公钥文件及当前版本安装程序；SHA-256 不一致时立即停止。

```powershell
$certPath = Join-Path $HOME 'Downloads\Brclio-Pay-Windows-Code-Signing.cer'
$installerPath = Join-Path $HOME 'Downloads\Brclio-Pay-@@VERSION@@-windows-x64-setup.exe'
$expectedSha256 = '@@CERT_SHA256@@'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $certPath).Hash.ToLowerInvariant() -ne $expectedSha256) {
  throw '证书文件 SHA-256 不匹配，已停止。请回到官方下载页重新核对。'
}
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($certPath)
if ($certificate.Thumbprint -ne '@@CERT_SHA1@@') { throw '证书指纹不匹配。' }
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($null -eq $signature.SignerCertificate -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
  throw '安装程序签名证书不匹配，已停止。'
}
$signature | Format-List Status, StatusMessage
```

尚未信任证书时，签名状态可能为 `NotTrusted`。`HashMismatch`、缺失签名或证书不匹配时请停止安装。安装文件本身的 SHA-256 还应与下载页的本版摘要相同。

## 2. 自愿为当前用户建立信任

只有核对完来源、证书和安装文件后，才执行本节。导入会让当前用户信任由这把证书密钥签名的代码；这不是只对一个文件生效的临时例外。无须管理员 PowerShell，也不导入到 LocalMachine。

```powershell
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
$signature = Get-AuthenticodeSignature -LiteralPath $installerPath
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
  throw '签名仍未通过系统校验，请勿安装。'
}
$signature | Format-List Status, StatusMessage
```

导入后双击安装程序，并按 Windows 界面确认。若 SmartScreen 仍显示“Windows 已保护你的电脑”，应先核对本版文件摘要与签名，再自行决定是否在“更多信息”中允许运行。组织策略可能禁止继续；本项目不修改系统策略、不关闭 Defender 或 SmartScreen。

安装后可在安装目录中对 `Brclio Pay.exe` 和 `Uninstall Brclio Pay.exe` 分别运行 `Get-AuthenticodeSignature -LiteralPath <完整路径>`，应显示 `Valid`，并使用同一指纹。

## 3. 撤销当前用户信任

不再需要时，在普通 PowerShell 中执行以下命令。它们只删除这张固定指纹的当前用户信任记录，不卸载应用。

```powershell
Remove-Item -LiteralPath 'Cert:\CurrentUser\Root\@@CERT_SHA1@@' -ErrorAction SilentlyContinue
Remove-Item -LiteralPath 'Cert:\CurrentUser\TrustedPublisher\@@CERT_SHA1@@' -ErrorAction SilentlyContinue
```

## 在线更新与官方说明

客户端更新继续使用固定 RSA 公钥验签，并核对版本、官方 GitHub URL、文件大小和 SHA-256；Windows Authenticode 证书信任与更新清单验签是两项独立校验。

参考：[Microsoft PowerShell 签名说明](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_signing)、[Get-AuthenticodeSignature](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-authenticodesignature?view=powershell-7.5)。
