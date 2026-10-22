#!/bin/bash
# Brclio Pay's transparent, user-confirmed installer. No administrator/root trust changes.
set -euo pipefail
export LC_ALL=C
PATH='/usr/bin:/bin:/usr/sbin:/sbin'
readonly APP_ID='cn.bornforthis.brcliopay' VERSION='@VERSION@' ARCH='@ARCH@'
readonly CERT_SHA256='@CERT_SHA256@' PUBLIC_KEY_SHA256='@PUBLIC_KEY_SHA256@' MANIFEST_SHA256='@MANIFEST_SHA256@'
readonly CONFIRMATION="INSTALL BRCLIO PAY $VERSION"
fail(){ printf '\n安装已停止：%s\n未关闭 Gatekeeper，也未添加系统信任证书。\n' "$1" >&2; if [ -n "${BACKUP:-}" ]; then printf '旧应用回退副本保留在：%s\n' "$BACKUP" >&2; fi; exit 1; }
[ "$#" -eq 0 ] || fail '此助手不接受应用或安装路径参数。'
[ "$(/usr/bin/id -u)" -ne 0 ] || fail '请以普通用户运行，不要使用 sudo。'
[ ! -L "${BASH_SOURCE[0]}" ] || fail '请运行 DMG 中原始助手，不使用符号链接。'
SOURCE_DIR="$(cd -P -- "$(/usr/bin/dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SOURCE_DIR SOURCE_APP="$SOURCE_DIR/Brclio Pay.app" MANIFEST="$SOURCE_DIR/.brclio-install-manifest.tsv" SIGNATURE="$SOURCE_DIR/.brclio-install-manifest.sig" PUBLIC_KEY="$SOURCE_DIR/.brclio-update-public-key.pem"
for filename in "$MANIFEST" "$SIGNATURE" "$PUBLIC_KEY"; do [ -f "$filename" ] && [ ! -L "$filename" ] || fail '缺少原始安装核验文件。'; done
sha_file(){ /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }
[ "$(sha_file "$PUBLIC_KEY")" = "$PUBLIC_KEY_SHA256" ] || fail '固定更新公钥不匹配。'
[ "$(sha_file "$MANIFEST")" = "$MANIFEST_SHA256" ] || fail '应用摘要清单不匹配。'
/usr/bin/openssl dgst -sha256 -verify "$PUBLIC_KEY" -signature "$SIGNATURE" "$MANIFEST" >/dev/null 2>&1 || fail '安装清单的 RSA 签名不匹配。'
REAL_HOME="$(/usr/bin/dscl . -read "/Users/$(/usr/bin/id -un)" NFSHomeDirectory | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')"
[ -n "$REAL_HOME" ] && [ "${REAL_HOME#/}" != "$REAL_HOME" ] && [ -d "$REAL_HOME" ] && [ ! -L "$REAL_HOME" ] || fail '无法确定当前用户的真实主目录。'
readonly INSTALL_ROOT="$REAL_HOME/Applications" DESTINATION="$REAL_HOME/Applications/Brclio Pay.app"
[ ! -L "$INSTALL_ROOT" ] && [ ! -L "$DESTINATION" ] || fail '用户 Applications 或目标应用不能是符号链接。'
if [ -e "$INSTALL_ROOT" ]; then [ -d "$INSTALL_ROOT" ] && [ "$(/usr/bin/stat -f %u "$INSTALL_ROOT")" = "$(/usr/bin/id -u)" ] || fail '用户 Applications 目录归属不正确。'; fi
WORK="$(/usr/bin/mktemp -d -t brclio-pay-install.XXXXXXXX)"
/bin/chmod 700 "$WORK"
cleanup(){ if [ -n "${STAGE:-}" ] && [ -z "${BACKUP:-}" ]; then /bin/rm -rf -- "$STAGE"; fi; [ -z "${WORK:-}" ] || /bin/rm -rf -- "$WORK"; }
trap cleanup EXIT
verify_app(){
 local app="$1" kind mode expected rel actual target count=0 total cert
 [ -d "$app" ] && [ ! -L "$app" ] || fail '应用目录无效或是符号链接。'
 [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")" = "$APP_ID" ] || fail '应用标识不匹配。'
 [ "$(/usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")" = "$VERSION" ] || fail '应用版本不匹配。'
 actual="$(/usr/bin/lipo -archs "$app/Contents/MacOS/Brclio Pay")"
 if [ "$ARCH" = 'arm64' ]; then [ "$actual" = 'arm64' ] || fail '应用架构不匹配。'; else [ "$actual" = 'x86_64' ] || fail '应用架构不匹配。'; fi
 /usr/bin/codesign --verify --deep --strict "$app" >/dev/null 2>&1 || fail '应用代码签名验证失败。'
 /bin/rm -f -- "$WORK/code0" "$WORK/code1"
 /usr/bin/codesign --display --extract-certificates="$WORK/code" "$app" >/dev/null 2>&1 || fail '无法读取本应用代码签名证书。'
 [ -f "$WORK/code0" ] && [ "$(sha_file "$WORK/code0")" = "$CERT_SHA256" ] || fail '固定自签代码证书指纹不匹配。'
 while IFS=$'\t' read -r kind mode expected rel; do
  case "$rel" in ''|/*|..|../*|*/../*|*/..|*\\*) fail '清单路径不安全。';; esac
  target="$app/$rel"
  case "$kind" in
   D) [ -d "$target" ] && [ ! -L "$target" ] || fail '应用目录结构已变化。';;
   F) [ -f "$target" ] && [ ! -L "$target" ] || fail '应用文件类型已变化。'; [ "$(sha_file "$target")" = "$expected" ] || fail '应用文件摘要不匹配。';;
   L) [ -L "$target" ] || fail '应用链接结构已变化。'; actual="$(/usr/bin/readlink "$target")"; case "$actual" in /*|..|../*|*/../*|*/..) fail '应用链接不得指向包外。';; esac; [ "$(printf '%s' "$actual" | /usr/bin/shasum -a 256 | /usr/bin/awk '{print $1}')" = "$expected" ] || fail '应用链接摘要不匹配。';;
   *) fail '清单类型无效。';;
  esac
  [ "$(/usr/bin/stat -f %Lp "$target")" = "$mode" ] || fail '应用文件权限已变化。'
  count=$((count+1))
 done < "$MANIFEST"
 total="$(/usr/bin/find "$app" -mindepth 1 -print | /usr/bin/wc -l | /usr/bin/tr -d ' ')"
 [ "$count" -gt 0 ] && [ "$count" = "$total" ] || fail '应用中存在未列入清单的文件。'
}
printf '正在核验安装来源、代码证书与全部文件摘要…\n'
verify_app "$SOURCE_APP"
target_running(){
 local pid executable
 while IFS= read -r pid; do
  executable="$(/bin/ps -ww -p "$pid" -o comm= 2>/dev/null || true)"
  [ "$executable" != "$DESTINATION/Contents/MacOS/Brclio Pay" ] || return 0
 done < <(/usr/bin/pgrep -x "Brclio Pay" 2>/dev/null || true)
 return 1
}
if target_running; then fail '目标路径的 Brclio Pay 正在运行，请先退出它再替换。'; fi
TARGET_INODE=""
if [ "$ARCH" = arm64 ]; then [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ] || fail '这是 Apple 芯片版，请为 Intel Mac 下载 x64 安装包。'; fi
if [ -e "$DESTINATION" ]; then
 [ -d "$DESTINATION" ] && [ ! -L "$DESTINATION" ] && [ "$(/usr/bin/stat -f %u "$DESTINATION")" = "$(/usr/bin/id -u)" ] || fail '目标位置不是当前用户拥有的真实应用目录。'
 [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$DESTINATION/Contents/Info.plist")" = "$APP_ID" ] || fail '目标位置存在其它应用，不会覆盖。'
 /usr/bin/codesign --verify --deep --strict "$DESTINATION" >/dev/null 2>&1 || fail '现有目标应用签名异常，不会覆盖。'
 TARGET_INODE="$(/usr/bin/stat -f '%d:%i:%u' "$DESTINATION")"
fi
printf '\nBrclio Pay %s · %s\n\n来源、应用身份、代码签名证书与全部文件摘要已经核验。\n证书 SHA-256：%s\n\n此版本使用 Brclio 自签证书，没有 Apple Developer ID，也没有 Apple 公证。\n这不是 Apple 的安全背书。只有你信任官方 GitHub 下载来源时才继续。\n\n将安装到：%s\n只移除此核验副本自身的下载隔离标记，以执行你这次明确允许的安装。\n不会关闭 Gatekeeper，不会添加 CA/根证书，不使用管理员权限。\n不会修改 /Applications 中可能已有的旧副本；之后请打开上面的新路径。\n开始前请先退出所有 Brclio Pay 窗口和正在运行的旧版。\n现有登录配置保留，目标旧应用若存在会备份，可手工回退。\n\n如不同意，请直接关掉此窗口。继续请输入：%s\n> ' "$VERSION" "$ARCH" "$CERT_SHA256" "$DESTINATION" "$CONFIRMATION"
IFS= read -r answer || fail '未收到明确确认。'
[ "$answer" = "$CONFIRMATION" ] || fail '没有收到完全一致的确认，未安装。'
if target_running; then fail '目标路径的 Brclio Pay 正在运行，请先退出它再替换。'; fi
/bin/mkdir -p -- "$INSTALL_ROOT"
[ -d "$INSTALL_ROOT" ] && [ ! -L "$INSTALL_ROOT" ] && [ "$(/usr/bin/stat -f %u "$INSTALL_ROOT")" = "$(/usr/bin/id -u)" ] || fail '安装目录已变化。'
STAGE="$(/usr/bin/mktemp -d "$INSTALL_ROOT/.brclio-pay-install.XXXXXXXX")"
/bin/chmod 700 "$STAGE"
printf '\n正在建立并重新核验独立副本…\n'
/usr/bin/ditto --rsrc --extattr "$SOURCE_APP" "$STAGE/Brclio Pay.app"
verify_app "$STAGE/Brclio Pay.app"
printf '正在应用本次逐应用授权并完成安装…\n'
# find does not follow symbolic links. xattr -s applies to a link itself, never its target.
while IFS= read -r -d '' target; do
 if [ -L "$target" ]; then
  if /usr/bin/xattr -s -p com.apple.quarantine "$target" >/dev/null 2>&1; then /usr/bin/xattr -s -d com.apple.quarantine "$target"; fi
 else
  if /usr/bin/xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then /usr/bin/xattr -d com.apple.quarantine "$target"; fi
 fi
 done < <(/usr/bin/find "$STAGE/Brclio Pay.app" -print0)
verify_app "$STAGE/Brclio Pay.app"
[ ! -L "$DESTINATION" ] || fail '目标位置在安装期间发生变化。'
if target_running; then fail '目标路径的 Brclio Pay 在安装期间开始运行，未替换。'; fi
BACKUP=''
if [ -e "$DESTINATION" ]; then
 [ -n "$TARGET_INODE" ] && [ "$(/usr/bin/stat -f '%d:%i:%u' "$DESTINATION")" = "$TARGET_INODE" ] && [ "$(/usr/bin/stat -f %u "$DESTINATION")" = "$(/usr/bin/id -u)" ] || fail '目标应用的归属或目录在等待期间发生变化。'
 [ "$(/usr/bin/plutil -extract CFBundleIdentifier raw -o - "$DESTINATION/Contents/Info.plist")" = "$APP_ID" ] && [ ! -L "$DESTINATION" ] || fail '目标应用在安装期间发生变化。'
 BACKUP="$STAGE/previous-Brclio-Pay.app"
 /usr/bin/perl -e 'rename($ARGV[0],$ARGV[1]) or die "Atomic backup failed\n"' "$DESTINATION" "$BACKUP"
fi
if ! /usr/bin/perl -e 'rename($ARGV[0],$ARGV[1]) or die "Atomic installation failed\n"' "$STAGE/Brclio Pay.app" "$DESTINATION"; then
 if [ -n "$BACKUP" ] && [ ! -e "$DESTINATION" ]; then /usr/bin/perl -e 'rename($ARGV[0],$ARGV[1]) or die "Restore failed\n"' "$BACKUP" "$DESTINATION"; fi
 fail '无法原子完成安装，原应用已保留或尝试恢复。'
fi
verify_app "$DESTINATION"
printf '\n安装完成：%s\n请从此新路径启动，不要继续打开其它位置的旧副本。\n' "$DESTINATION"
if [ -n "$BACKUP" ]; then printf '旧版本回退副本：%s\n' "$BACKUP"; else /bin/rmdir -- "$STAGE" 2>/dev/null || true; fi
/usr/bin/open -R "$DESTINATION"
if /usr/bin/pgrep -x "Brclio Pay" >/dev/null 2>&1; then
 printf '\n检测到其它位置的 Brclio Pay 正在运行，已跳过自动启动，不会中断它。\n请先退出全部旧版，再从此新路径打开：%s\n' "$DESTINATION"
 exit 0
fi
/usr/bin/open -n "$DESTINATION" || fail '应用已安装，但系统未能启动。请在该路径重试并查看“隐私与安全性”。'
printf '\n已请求启动核验后的应用。如系统仍提示，请按 Apple 的逐应用“仍要打开”流程确认。\n'
