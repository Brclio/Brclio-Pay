package cn.bornforthis.brcliopay;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.HttpsURLConnection;

public final class MainActivity extends Activity {
    private static final int SAVE_EXPORT = 301;
    private WebView webView;
    private TextView status, failure;
    private Button retry;
    private UpdateManager updates;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private boolean destroyed, failed, exportBusy;
    private byte[] pendingExport;
    private ExportTransfer transfer;
    private static final class ExportTransfer {
        String id, filename, mime;
        int bytes, sequence;
        long createdAt = System.currentTimeMillis();
        ByteArrayOutputStream output = new ByteArrayOutputStream();
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        LinearLayout root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(Color.rgb(255, 253, 244));
        LinearLayout bar = new LinearLayout(this); bar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        TextView title = new TextView(this); title.setText("Brclio Pay"); title.setTextSize(18); title.setTextColor(Color.rgb(28, 33, 51)); title.setPadding(14, 8, 8, 8);
        bar.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button refresh = new Button(this); refresh.setText("刷新"); refresh.setContentDescription("刷新当前支付后台页面"); refresh.setOnClickListener(view -> reload()); bar.addView(refresh);
        Button update = new Button(this); update.setText("检查更新"); update.setOnClickListener(view -> { if (updates != null) updates.check(true); }); bar.addView(update);
        root.addView(bar);
        status = new TextView(this); status.setText("客户端 v" + BuildConfig.VERSION_NAME); status.setTextSize(12); status.setPadding(14, 0, 14, 5); root.addView(status);
        failure = new TextView(this); failure.setText("连接失败，请检查网络后重试。"); failure.setPadding(16, 18, 16, 6); failure.setVisibility(View.GONE); root.addView(failure);
        retry = new Button(this); retry.setText("重试连接"); retry.setVisibility(View.GONE); retry.setOnClickListener(view -> reload()); root.addView(retry);
        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setJavaScriptCanOpenWindowsAutomatically(false); settings.setSupportMultipleWindows(true);
        settings.setGeolocationEnabled(false); settings.setSaveFormData(false); settings.setSafeBrowsingEnabled(true);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        webView.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean userGesture, android.os.Message result) {
                if (!userGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                        openExternal(request.getUrl().toString()); view.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget(); return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (request.isForMainFrame() && ClientPolicy.isCenter(url)) return false;
                if (request.isForMainFrame() && request.hasGesture()) openExternal(url);
                return true;
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (ClientPolicy.isCenter(request.getUrl().toString())) return null;
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                transfer = null; failed = false; failure.setVisibility(View.GONE); retry.setVisibility(View.GONE);
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (ClientPolicy.isCenter(url) && !failed) { CookieManager.getInstance().flush(); injectNativeActions(); }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showFailure();
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) showFailure();
            }
            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                Toast.makeText(MainActivity.this, "页面已停止，请重新打开客户端。", Toast.LENGTH_LONG).show(); finish(); return true;
            }
        });
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(webView, "BrclioPayNative", Collections.singleton(ClientPolicy.ORIGIN),
                    (view, message, sourceOrigin, mainFrame, reply) -> {
                        if (destroyed || !mainFrame || !ClientPolicy.isBridgeOrigin(sourceOrigin.toString()) || !ClientPolicy.isCenter(view.getUrl())) return;
                        try { handleMessage(message.getData(), reply); } catch (RuntimeException error) { status.setText("本次复制或导出未完成，请重试"); }
                    });
        } else { status.setText("请更新 Android System WebView 以使用复制和文件导出"); }
        webView.setDownloadListener((url, userAgent, disposition, mime, length) -> downloadSkill(url));
        root.addView(webView, new LinearLayout.LayoutParams(-1, 0, 1));
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets padding = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(padding.left, padding.top, padding.right, padding.bottom); return WindowInsetsCompat.CONSUMED;
        });
        setContentView(root); ViewCompat.requestApplyInsets(root);
        webView.loadUrl(ClientPolicy.ADMIN_URL);
        try { updates = new UpdateManager(this, text -> status.setText(text)); updates.check(false); }
        catch (Exception error) { status.setText("更新校验资源不可用，请从官方发布页重新安装"); }
    }
    private void showFailure() {
        failed = true; failure.setVisibility(View.VISIBLE); retry.setVisibility(View.VISIBLE);
    }
    private void reload() { if (webView != null) webView.loadUrl(ClientPolicy.isCenter(webView.getUrl()) ? webView.getUrl() : ClientPolicy.ADMIN_URL); }
    private void openExternal(String url) {
        if (!ClientPolicy.isHttps(url)) return;
        try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)); }
        catch (ActivityNotFoundException error) { status.setText("未找到可打开此链接的浏览器"); }
    }
    private void handleMessage(String data, JavaScriptReplyProxy reply) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        String id = "";
        try {
            if (data == null || data.length() > 400000) throw new IllegalArgumentException("Message limit");
            JSONObject message = new JSONObject(data); id = message.getString("id");
            if (!id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid request ID");
            String action = message.getString("action");
            switch (action) {
                case "copyText": {
                    String text = message.getString("text");
                    if (text.length() > 262144) throw new IllegalArgumentException("Clipboard limit");
                    ((ClipboardManager) getSystemService(CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("Brclio Pay", text));
                    break;
                }
                case "external": openExternal(message.getString("url")); break;
                case "exportStart": {
                    if (exportBusy || pendingExport != null) throw new IllegalArgumentException("Another export is waiting");
                    ExportTransfer next = new ExportTransfer(); next.id = message.getString("transfer");
                    if (!next.id.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Invalid transfer ID");
                    next.mime = message.getString("mime"); next.filename = ClientPolicy.safeFilename(message.getString("filename"), next.mime);
                    next.bytes = message.getInt("bytes");
                    if (next.bytes <= 0 || next.bytes > ClientPolicy.MAX_EXPORT_BYTES) throw new IllegalArgumentException("Export size limit");
                    transfer = next; break;
                }
                case "exportChunk": {
                    ExportTransfer current = requireTransfer(message);
                    if (message.getInt("sequence") != current.sequence++) throw new IllegalArgumentException("Wrong export sequence");
                    String encoded = message.getString("data");
                    if (encoded.length() > 262144) throw new IllegalArgumentException("Chunk size limit");
                    byte[] bytes = Base64.getDecoder().decode(encoded);
                    if (!Base64.getEncoder().encodeToString(bytes).equals(encoded) || current.output.size() + bytes.length > current.bytes)
                        throw new IllegalArgumentException("Invalid export chunk");
                    current.output.write(bytes); break;
                }
                case "exportFinish": {
                    ExportTransfer current = requireTransfer(message);
                    if (current.output.size() != current.bytes) throw new IllegalArgumentException("Incomplete export");
                    transfer = null; saveExport(current.filename, current.mime, current.output.toByteArray()); break;
                }
                default: throw new IllegalArgumentException("Unsupported native action");
            }
            reply.postMessage(new JSONObject().put("id", id).put("ok", true).toString());
        } catch (Exception error) {
            transfer = null;
            try { reply.postMessage(new JSONObject().put("id", id).put("ok", false).put("error", "本次操作未完成，请重试").toString()); } catch (Exception ignored) { }
        }
    }
    private ExportTransfer requireTransfer(JSONObject message) throws Exception {
        if (transfer == null || !transfer.id.equals(message.getString("transfer")) || System.currentTimeMillis() - transfer.createdAt > 120000)
            throw new IllegalArgumentException("No active export");
        return transfer;
    }
    private void saveExport(String filename, String mime, byte[] bytes) {
        ClientPolicy.safeFilename(filename, mime);
        if (pendingExport != null || bytes.length == 0 || bytes.length > ClientPolicy.MAX_EXPORT_BYTES) throw new IllegalArgumentException("Export unavailable");
        pendingExport = bytes;
        try { startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime).putExtra(Intent.EXTRA_TITLE, filename), SAVE_EXPORT); }
        catch (ActivityNotFoundException error) { pendingExport = null; status.setText("未找到系统文件保存器"); }
    }
    private void downloadSkill(String url) {
        if (!ClientPolicy.isSkillDownload(url) || exportBusy || pendingExport != null) { status.setText("仅支持支付中心的 Skills ZIP 和页面 CSV 导出"); return; }
        exportBusy = true; String cookies = CookieManager.getInstance().getCookie(url); status.setText("正在准备 Skills ZIP…");
        worker.execute(() -> {
            try {
                HttpsURLConnection connection = (HttpsURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(false); connection.setConnectTimeout(15000); connection.setReadTimeout(20000);
                if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                connection.setRequestProperty("Accept", "application/zip");
                byte[] bytes;
                try (InputStream stream = connection.getInputStream()) {
                    String mime = connection.getContentType();
                    if (connection.getResponseCode() != 200 || mime == null || !(mime.startsWith("application/zip") || mime.startsWith("application/octet-stream")))
                        throw new IllegalArgumentException("Download did not return ZIP");
                    bytes = UpdateManager.readBounded(stream, ClientPolicy.MAX_EXPORT_BYTES);
                    if (bytes.length < 4 || bytes[0] != 'P' || bytes[1] != 'K') throw new IllegalArgumentException("Invalid ZIP response");
                } finally { connection.disconnect(); }
                String filename = "brclio-pay-skills.zip";
                Uri source = Uri.parse(url); String variant = source.getQueryParameter("variant");
                if (variant != null && variant.matches("brclio-(pay|alipay|wechatpay)-integrate")) filename = variant + ".zip";
                String finalName = filename;
                runOnUiThread(() -> { exportBusy = false; if (!destroyed) { status.setText("Skills ZIP 已准备好"); saveExport(finalName, "application/zip", bytes); } });
            } catch (Exception error) { runOnUiThread(() -> { exportBusy = false; if (!destroyed) status.setText("Skills ZIP 下载失败，请检查登录状态后重试"); }); }
        });
    }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request != SAVE_EXPORT) return;
        byte[] bytes = pendingExport; pendingExport = null;
        if (result != RESULT_OK || data == null || data.getData() == null || bytes == null) { status.setText("已取消保存"); return; }
        Uri destination = data.getData();
        if (!"content".equals(destination.getScheme())) { status.setText("文件保存位置不可用"); return; }
        exportBusy = true;
        worker.execute(() -> {
            boolean success = false;
            try (OutputStream output = getContentResolver().openOutputStream(destination, "wt")) {
                if (output != null) { output.write(bytes); output.flush(); success = true; }
            } catch (Exception ignored) { }
            boolean saved = success;
            runOnUiThread(() -> { exportBusy = false; if (!destroyed) { status.setText(saved ? "文件已保存" : "文件保存失败，请重试"); Toast.makeText(this, saved ? "文件已保存" : "文件保存失败", Toast.LENGTH_SHORT).show(); } });
        });
    }
    private void injectNativeActions() {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        try (InputStream stream = getAssets().open("native-actions.js")) {
            webView.evaluateJavascript(new String(UpdateManager.readBounded(stream, 20000), StandardCharsets.UTF_8), null);
        } catch (Exception error) { status.setText("原生复制和导出功能加载失败，请重新打开客户端"); }
    }
    @Override protected void onPause() { CookieManager.getInstance().flush(); super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (updates != null) updates.onResume(); }
    @Override public void onBackPressed() { if (webView != null && webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy() {
        destroyed = true; pendingExport = null; transfer = null; worker.shutdownNow();
        if (updates != null) updates.destroy();
        if (webView != null) { webView.stopLoading(); webView.destroy(); }
        super.onDestroy();
    }
}
