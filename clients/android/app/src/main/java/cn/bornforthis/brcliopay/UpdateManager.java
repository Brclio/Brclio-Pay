package cn.bornforthis.brcliopay;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

/** Only signed release metadata can choose an APK; installer confirmation remains with Android. */
public final class UpdateManager {
    public interface Status { void show(String text); }
    private final Activity activity;
    private final Status status;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final PublicKey key;
    private final SharedPreferences candidateState;
    private boolean busy, destroyed, waitingPermission, resumeInstallWhenRestored;
    private File verifiedFile;
    private UpdatePolicy.Release verifiedRelease;

    public UpdateManager(Activity activity, Status status) throws Exception {
        this.activity = activity; this.status = status;
        candidateState = activity.getSharedPreferences("verified-client-update", Activity.MODE_PRIVATE);
        try { waitingPermission = candidateState.getBoolean("awaiting_permission", false); }
        catch (ClassCastException error) { candidateState.edit().clear().commit(); waitingPermission = false; }
        try (InputStream stream = activity.getAssets().open("update-public-key.pem")) {
            key = UpdatePolicy.publicKey(new String(readBounded(stream, 8192), StandardCharsets.UTF_8));
        }
    }
    private void ui(Runnable action) { activity.runOnUiThread(() -> { if (!destroyed && !activity.isFinishing()) action.run(); }); }
    public void check(boolean manual) {
        if (busy || destroyed) { if (manual) status.show("正在处理更新，请稍候"); return; }
        busy = true; status.show("正在检查客户端新版本…");
        executor.execute(() -> {
            try {
                UpdatePolicy.Release saved = restoreCandidate();
                if (saved != null) {
                    ui(() -> {
                        busy = false; status.show("已下载 v" + saved.version + " · 点击检查更新继续安装");
                        if (resumeInstallWhenRestored) { resumeInstallWhenRestored = false; install(); }
                        else if (manual) offerInstall(saved);
                    });
                    return;
                }
                byte[] envelope;
                UpdatePolicy.Release release;
                try { envelope = getManifest(UpdatePolicy.UPDATE_URL); release = UpdatePolicy.verify(envelope, key); }
                catch (Exception primaryError) { envelope = getManifest(UpdatePolicy.FALLBACK_URL); release = UpdatePolicy.verify(envelope, key); }
                long currentCode = installedVersionCode();
                UpdatePolicy.Release checked = release;
                byte[] signedEnvelope = envelope;
                ui(() -> {
                    busy = false;
                    if (checked.versionCode <= currentCode) {
                        status.show("客户端 v" + BuildConfig.VERSION_NAME + " · 已是最新版本");
                        if (manual) new AlertDialog.Builder(activity).setTitle("已是最新版本").setMessage("当前客户端 v" + BuildConfig.VERSION_NAME)
                                .setPositiveButton("知道了", null).show();
                    } else {
                        status.show("发现客户端新版本 v" + checked.version + " · 点击检查更新安装");
                        if (manual) offerDownload(checked, signedEnvelope);
                    }
                });
            } catch (Exception error) {
                ui(() -> {
                    busy = false;
                    status.show("无法检查更新 · 当前客户端 v" + BuildConfig.VERSION_NAME);
                    if (manual) new AlertDialog.Builder(activity).setTitle("无法检查更新")
                            .setMessage("网络连接或发布校验暂不可用。请稍后重试，或在官方 GitHub 发布页查看。")
                            .setPositiveButton("重试", (dialog, which) -> check(true)).setNegativeButton("关闭", null).show();
                });
            }
        });
    }
    private void offerDownload(UpdatePolicy.Release release, byte[] envelope) {
        new AlertDialog.Builder(activity).setTitle("客户端 v" + release.version)
                .setMessage((release.notes.isEmpty() ? "有可用更新。" : release.notes) + "\n\n下载后将校验发布签名、安装包完整性与应用签名，并交由系统确认安装。")
                .setPositiveButton("下载并更新", (dialog, which) -> download(release, envelope))
                .setNegativeButton("稍后", null).show();
    }
    private void offerInstall(UpdatePolicy.Release release) {
        new AlertDialog.Builder(activity).setTitle("继续安装客户端 v" + release.version)
                .setMessage("已下载的更新已重新核验发布签名、完整性与应用签名，无需重复下载。安装前仍会再次校验。")
                .setPositiveButton("继续安装", (dialog, which) -> install())
                .setNeutralButton("检查其他更新", (dialog, which) -> {
                    if (busy) return;
                    busy = true;
                    executor.execute(() -> { clearCandidate(); ui(() -> { busy = false; check(true); }); });
                }).setNegativeButton("稍后", null).show();
    }
    private void download(UpdatePolicy.Release release, byte[] envelope) {
        if (busy || destroyed) return;
        busy = true; status.show("正在下载并校验更新…");
        executor.execute(() -> {
            File partial = null;
            try {
                clearCandidate();
                File directory = candidateDirectory();
                partial = File.createTempFile("download-", ".part", directory);
                HttpsURLConnection connection = connect(release.url, false);
                try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                    long declared = connection.getContentLengthLong();
                    if (declared != -1 && declared != release.bytes) throw new IOException("APK size mismatch");
                    byte[] buffer = new byte[32768]; long count = 0; int size;
                    while ((size = input.read(buffer)) != -1) {
                        count += size;
                        if (destroyed || count > release.bytes || count > UpdatePolicy.MAX_APK_BYTES) throw new IOException("APK download limit");
                        output.write(buffer, 0, size);
                    }
                    output.getFD().sync();
                    if (count != release.bytes) throw new IOException("Incomplete APK download");
                } finally { connection.disconnect(); }
                verifyApk(partial, release);
                // A fixed private cache identity prevents preferences from choosing any filesystem path.
                File complete = new File(directory, "candidate.apk");
                if (!partial.renameTo(complete)) throw new IOException("Could not finish update download");
                partial = null;
                UpdatePolicy.Release signed = UpdatePolicy.verify(envelope, key);
                if (!signed.sha256.equals(release.sha256) || signed.versionCode != release.versionCode) throw new IOException("Saved release identity changed");
                if (!candidateState.edit().putString("signed_envelope", Base64.getEncoder().encodeToString(envelope))
                        .putLong("saved_at", System.currentTimeMillis()).putBoolean("awaiting_permission", false).commit())
                    throw new IOException("Could not preserve verified update state");
                verifiedFile = complete; verifiedRelease = release;
                ui(() -> {
                    busy = false; status.show("更新已校验 · 等待系统安装");
                    offerInstall(release);
                });
            } catch (Exception error) {
                if (partial != null) partial.delete();
                clearCandidate();
                ui(() -> { busy = false; status.show("更新下载或校验失败，请重试");
                    new AlertDialog.Builder(activity).setTitle("未能完成更新")
                            .setMessage("安装包下载不完整、签名或版本校验未通过。未启动安装器，请稍后重试。")
                            .setPositiveButton("关闭", null).show(); });
            }
        });
    }
    public void onResume() {
        if (waitingPermission && activity.getPackageManager().canRequestPackageInstalls()) {
            if (busy) resumeInstallWhenRestored = true;
            else install();
        } else if (waitingPermission) {
            waitingPermission = false; candidateState.edit().putBoolean("awaiting_permission", false).apply();
            status.show("尚未允许安装更新 · 可重新检查更新");
        }
    }
    private void install() {
        if (busy || destroyed) return;
        busy = true;
        executor.execute(() -> {
            try {
                // Re-read public signed metadata and the fixed file; memory/preferences never skip verification.
                if (restoreCandidate() == null) throw new IOException("Verified update candidate is no longer available");
                ui(() -> {
                    busy = false;
                    if (!activity.getPackageManager().canRequestPackageInstalls()) {
                        new AlertDialog.Builder(activity).setTitle("允许安装客户端更新")
                                .setMessage("Android 需要允许 Brclio Pay 安装来源于官方 GitHub 发布页的更新。授权后返回即可继续安装。")
                                .setPositiveButton("前往设置", (dialog, which) -> {
                                    try {
                                        waitingPermission = true;
                                        if (!candidateState.edit().putBoolean("awaiting_permission", true).commit()) throw new IllegalStateException("Could not preserve install consent");
                                        activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())));
                                    } catch (RuntimeException error) {
                                        waitingPermission = false; candidateState.edit().putBoolean("awaiting_permission", false).apply();
                                        status.show("无法打开安装授权设置，请在系统设置中允许");
                                    }
                                }).setNegativeButton("取消", null).show();
                        return;
                    }
                    try {
                        waitingPermission = false; candidateState.edit().putBoolean("awaiting_permission", false).apply();
                        Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", verifiedFile);
                        Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        activity.startActivity(intent);
                        status.show("请在系统安装器中确认更新");
                    } catch (RuntimeException error) { status.show("无法打开系统安装器，请稍后重试"); }
                });
            } catch (Exception error) {
                clearCandidate();
                ui(() -> { busy = false; resumeInstallWhenRestored = false; status.show("已下载更新失效，正在重新检查…"); check(true); });
            }
        });
    }
    private File candidateDirectory() throws IOException {
        File base = activity.getCacheDir().getCanonicalFile();
        File directory = new File(base, "verified-updates");
        if (Files.isSymbolicLink(directory.toPath())) throw new IOException("Invalid update cache identity");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Update cache unavailable");
        if (!base.equals(directory.getCanonicalFile().getParentFile())) throw new IOException("Invalid update cache parent");
        return directory.getCanonicalFile();
    }
    private UpdatePolicy.Release restoreCandidate() {
        try {
            String envelope = candidateState.getString("signed_envelope", null);
            if (envelope == null) return null;
            UpdatePolicy.Release release = UpdatePolicy.restoreCandidate(envelope, candidateState.getLong("saved_at", 0),
                    System.currentTimeMillis(), installedVersionCode(), key);
            File file = new File(candidateDirectory(), "candidate.apk");
            verifyApk(file, release);
            verifiedFile = file; verifiedRelease = release; return release;
        } catch (Exception error) { clearCandidate(); return null; }
    }
    private void clearCandidate() {
        verifiedFile = null; verifiedRelease = null; waitingPermission = false; resumeInstallWhenRestored = false;
        candidateState.edit().clear().commit();
        try { Files.deleteIfExists(new File(candidateDirectory(), "candidate.apk").toPath()); } catch (Exception ignored) { }
    }
    private long installedVersionCode() throws PackageManager.NameNotFoundException {
        PackageInfo installed = activity.getPackageManager().getPackageInfo(activity.getPackageName(), 0);
        return Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
    }
    @SuppressWarnings("deprecation")
    private void verifyApk(File file, UpdatePolicy.Release release) throws Exception {
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS)
                || !file.getParentFile().getCanonicalFile().equals(candidateDirectory())
                || file.length() != release.bytes || !release.sha256.equals(hash(file))) throw new IOException("APK checksum mismatch");
        PackageManager manager = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo archive = manager.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), flags);
        if (archive == null || !UpdatePolicy.APPLICATION_ID.equals(archive.packageName) || !installed.packageName.equals(archive.packageName)
                || !release.version.equals(archive.versionName) || archive.applicationInfo == null
                || (archive.applicationInfo.flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) throw new IOException("Wrong APK application");
        long code = Build.VERSION.SDK_INT >= 28 ? archive.getLongVersionCode() : archive.versionCode;
        long current = Build.VERSION.SDK_INT >= 28 ? installed.getLongVersionCode() : installed.versionCode;
        if (code != release.versionCode || code <= current) throw new IOException("APK version mismatch");
        if (!certificates(archive).equals(certificates(installed))) throw new IOException("APK signing certificate mismatch");
    }
    @SuppressWarnings("deprecation")
    private List<String> certificates(PackageInfo info) throws Exception {
        Signature[] signatures = Build.VERSION.SDK_INT >= 28
                ? info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners() : info.signatures;
        if (signatures == null || signatures.length == 0) throw new IOException("APK signing identity absent");
        List<String> hashes = new ArrayList<>();
        for (Signature signature : signatures) hashes.add(hex(MessageDigest.getInstance("SHA-256").digest(signature.toByteArray())));
        Collections.sort(hashes); return hashes;
    }
    private static String hash(File file) throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream stream = new FileInputStream(file)) {
            byte[] buffer = new byte[32768]; int length;
            while ((length = stream.read(buffer)) != -1) digest.update(buffer, 0, length);
        }
        return hex(digest.digest());
    }
    private static String hex(byte[] value) {
        StringBuilder result = new StringBuilder(); for (byte item : value) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 255)); return result.toString();
    }
    private static byte[] getManifest(String url) throws Exception {
        if (!UpdatePolicy.isManifestUrl(url)) throw new IOException("Wrong manifest location");
        HttpsURLConnection connection = connect(url, true);
        try (InputStream stream = connection.getInputStream()) {
            if (connection.getContentLengthLong() > UpdatePolicy.MAX_MANIFEST_BYTES) throw new IOException("Manifest exceeds limit");
            return readBounded(stream, UpdatePolicy.MAX_MANIFEST_BYTES);
        } finally { connection.disconnect(); }
    }
    private static HttpsURLConnection connect(String initial, boolean manifest) throws Exception {
        String url = initial;
        for (int redirects = 0; redirects <= 5; redirects++) {
            if (!(redirects == 0 && manifest && UpdatePolicy.isManifestUrl(url)) && !UpdatePolicy.isDownloadRedirect(url))
                throw new IOException("Untrusted update destination");
            HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
            connection.setRequestProperty("User-Agent", "Brclio-Pay-Android/" + BuildConfig.VERSION_NAME);
            connection.setRequestProperty("Accept", manifest ? "application/json" : "application/octet-stream");
            connection.setRequestProperty("Accept-Encoding", "identity");
            int code = connection.getResponseCode();
            if (code >= 300 && code <= 399) {
                String location = connection.getHeaderField("Location"); connection.disconnect();
                if (redirects == 5 || location == null) throw new IOException("Invalid update redirect");
                url = new URL(new URL(url), location).toString();
            } else if (code == 200) return connection;
            else { connection.disconnect(); throw new IOException("Update request did not succeed"); }
        }
        throw new IOException("Too many update redirects");
    }
    static byte[] readBounded(InputStream stream, int limit) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream(); byte[] buffer = new byte[8192]; int length;
        while ((length = stream.read(buffer)) != -1) {
            if (output.size() + length > limit) throw new IOException("Response exceeds limit");
            output.write(buffer, 0, length);
        }
        return output.toByteArray();
    }
    public void destroy() { destroyed = true; executor.shutdownNow(); }
}
