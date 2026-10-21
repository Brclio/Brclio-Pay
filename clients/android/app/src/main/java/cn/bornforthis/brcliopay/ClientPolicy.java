package cn.bornforthis.brcliopay;

import java.net.URI;
import java.util.Base64;
import java.util.Locale;

/** Pure policy: no Android API, credentials or persistence. */
public final class ClientPolicy {
    public static final String ORIGIN = "https://pay.bornforthis.cn";
    public static final String ADMIN_URL = ORIGIN + "/admin";
    public static final int MAX_EXPORT_BYTES = 16 * 1024 * 1024;
    private ClientPolicy() {}

    public static boolean isHttps(String value) {
        try {
            URI uri = URI.create(value);
            return "https".equals(uri.getScheme()) && uri.getHost() != null && uri.getRawUserInfo() == null
                    && (uri.getPort() == -1 || uri.getPort() == 443);
        } catch (RuntimeException error) { return false; }
    }
    public static boolean isCenter(String value) {
        if (!isHttps(value)) return false;
        return "pay.bornforthis.cn".equals(URI.create(value).getHost());
    }
    public static boolean isBridgeOrigin(String value) {
        if (!isCenter(value)) return false;
        URI uri = URI.create(value);
        return (uri.getRawPath() == null || uri.getRawPath().isEmpty() || "/".equals(uri.getRawPath()))
                && uri.getRawQuery() == null && uri.getRawFragment() == null;
    }
    public static boolean isSkillDownload(String value) {
        if (!isCenter(value)) return false;
        String path = URI.create(value).getRawPath();
        return "/api/admin/skill.zip".equals(path)
                || path != null && path.matches("/api/skills/brclio-(pay|alipay|wechatpay)-integrate\\.zip");
    }
    public static String safeFilename(String value, String mime) {
        if (value == null || value.length() > 160 || !value.matches("[A-Za-z0-9][A-Za-z0-9._-]*")
                || value.contains("..")) throw new IllegalArgumentException("Invalid export filename");
        String lower = value.toLowerCase(Locale.ROOT);
        if ("text/csv".equals(mime) && lower.endsWith(".csv")
                || "application/zip".equals(mime) && lower.endsWith(".zip")) return value;
        throw new IllegalArgumentException("Unsupported export format");
    }
    public static byte[] decodeExport(String value) {
        if (value == null || value.length() == 0 || value.length() > ((MAX_EXPORT_BYTES + 2L) / 3L) * 4L
                || !value.matches("[A-Za-z0-9+/]*={0,2}")) throw new IllegalArgumentException("Export is too large or invalid");
        byte[] bytes = Base64.getDecoder().decode(value);
        if (bytes.length == 0 || bytes.length > MAX_EXPORT_BYTES || !Base64.getEncoder().encodeToString(bytes).equals(value))
            throw new IllegalArgumentException("Invalid export encoding");
        return bytes;
    }
}
