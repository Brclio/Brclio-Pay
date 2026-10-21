package cn.bornforthis.brcliopay;

import org.json.JSONObject;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.X509EncodedKeySpec;
import java.time.Instant;
import java.util.Base64;

public final class UpdatePolicy {
    public static final String REPOSITORY = "Brclio/Brclio-Pay";
    public static final String APPLICATION_ID = "cn.bornforthis.brcliopay";
    public static final String UPDATE_URL = ClientPolicy.ORIGIN + "/client-update.json";
    public static final String FALLBACK_URL = "https://github.com/" + REPOSITORY + "/releases/latest/download/client-update.json";
    public static final int MAX_MANIFEST_BYTES = 256 * 1024;
    public static final long MAX_APK_BYTES = 100L * 1024 * 1024;
    public static final long CANDIDATE_MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000;
    private UpdatePolicy() {}

    public static final class Release {
        public final String version, notes, releaseUrl, name, url, sha256;
        public final long versionCode, bytes;
        Release(String version, long versionCode, String notes, String releaseUrl, String name, String url, long bytes, String sha256) {
            this.version = version; this.versionCode = versionCode; this.notes = notes; this.releaseUrl = releaseUrl;
            this.name = name; this.url = url; this.bytes = bytes; this.sha256 = sha256;
        }
    }
    public static PublicKey publicKey(String pem) throws Exception {
        String body = pem.replace("-----BEGIN PUBLIC KEY-----", "").replace("-----END PUBLIC KEY-----", "").replaceAll("\\s", "");
        PublicKey key = KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(Base64.getDecoder().decode(body)));
        if (!(key instanceof RSAPublicKey) || ((RSAPublicKey) key).getModulus().bitLength() < 2048)
            throw new IllegalArgumentException("Unsupported update verification key");
        return key;
    }
    private static byte[] base64(String value, int maxBytes) {
        if (value == null || value.length() > ((maxBytes + 2L) / 3) * 4 || !value.matches("[A-Za-z0-9+/]*={0,2}"))
            throw new IllegalArgumentException("Invalid signed envelope encoding");
        byte[] bytes = Base64.getDecoder().decode(value);
        if (bytes.length == 0 || bytes.length > maxBytes || !Base64.getEncoder().encodeToString(bytes).equals(value))
            throw new IllegalArgumentException("Invalid signed envelope length");
        return bytes;
    }
    private static long positiveLong(JSONObject object, String name, long max) throws Exception {
        Object value = object.get(name);
        if (!(value instanceof Number) || !value.toString().matches("[1-9][0-9]*")) throw new IllegalArgumentException("Invalid numeric field");
        long number = Long.parseLong(value.toString());
        if (number > max) throw new IllegalArgumentException("Numeric field exceeds limit");
        return number;
    }
    public static long versionCode(String version) {
        if (version == null || !version.matches("(0|[1-9][0-9]{0,3})\\.(0|[1-9][0-9]{0,2})\\.(0|[1-9][0-9]{0,2})"))
            throw new IllegalArgumentException("Invalid release version");
        String[] parts = version.split("\\.");
        long code = Long.parseLong(parts[0]) * 1000000L + Long.parseLong(parts[1]) * 1000L + Long.parseLong(parts[2]);
        if (code <= 0 || code > 2100000000L) throw new IllegalArgumentException("Version out of range");
        return code;
    }
    public static Release verify(byte[] envelopeBytes, PublicKey key) throws Exception {
        if (envelopeBytes.length == 0 || envelopeBytes.length > MAX_MANIFEST_BYTES) throw new IllegalArgumentException("Manifest too large");
        JSONObject envelope = new JSONObject(new String(envelopeBytes, StandardCharsets.UTF_8));
        if (envelope.getInt("schema") != 1 || !"RSA-SHA256".equals(envelope.getString("algorithm")))
            throw new IllegalArgumentException("Unsupported signed envelope");
        byte[] payload = base64(envelope.getString("payload"), MAX_MANIFEST_BYTES);
        byte[] signature = base64(envelope.getString("signature"), 1024);
        Signature verifier = Signature.getInstance("SHA256withRSA");
        verifier.initVerify(key); verifier.update(payload);
        if (!verifier.verify(signature)) throw new IllegalArgumentException("Update signature did not match");
        JSONObject manifest = new JSONObject(new String(payload, StandardCharsets.UTF_8));
        if (manifest.getInt("schema") != 1 || !"Brclio Pay".equals(manifest.getString("product"))
                || !APPLICATION_ID.equals(manifest.getString("applicationId"))) throw new IllegalArgumentException("Wrong update application");
        String version = manifest.getString("version");
        long code = positiveLong(manifest, "versionCode", 2100000000L);
        if (code != versionCode(version)) throw new IllegalArgumentException("Release version code mismatch");
        Instant.parse(manifest.getString("publishedAt"));
        String releaseUrl = "https://github.com/" + REPOSITORY + "/releases/tag/client-v" + version;
        if (!releaseUrl.equals(manifest.getString("releaseUrl"))) throw new IllegalArgumentException("Wrong release location");
        String notes = manifest.getString("notes");
        if (notes.length() > 20000) throw new IllegalArgumentException("Release notes exceed limit");
        JSONObject update = manifest.getJSONObject("platforms").getJSONObject("android-universal").getJSONObject("update");
        String name = "Brclio-Pay-" + version + "-android-universal.apk";
        String assetUrl = "https://github.com/" + REPOSITORY + "/releases/download/client-v" + version + "/" + name;
        if (!"apk".equals(update.getString("type")) || !name.equals(update.getString("name")) || !assetUrl.equals(update.getString("url")))
            throw new IllegalArgumentException("Wrong Android update asset");
        String hash = update.getString("sha256");
        if (!hash.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid update checksum");
        long bytes = positiveLong(update, "bytes", MAX_APK_BYTES);
        return new Release(version, code, notes, releaseUrl, name, assetUrl, bytes, hash);
    }
    /** Stored metadata is untrusted: recover only the original signed envelope, never a stored path or parsed release. */
    public static Release restoreCandidate(String encodedEnvelope, long savedAt, long now, long installedCode, PublicKey key) throws Exception {
        if (savedAt <= 0 || savedAt > now + 300000 || now - savedAt > CANDIDATE_MAX_AGE_MS)
            throw new IllegalArgumentException("Saved update candidate expired");
        Release release = verify(base64(encodedEnvelope, MAX_MANIFEST_BYTES), key);
        if (release.versionCode <= installedCode) throw new IllegalArgumentException("Saved update is no longer newer");
        return release;
    }
    public static boolean isManifestUrl(String value) {
        return UPDATE_URL.equals(value) || FALLBACK_URL.equals(value);
    }
    public static boolean isDownloadRedirect(String value) {
        if (!ClientPolicy.isHttps(value)) return false;
        URI uri = URI.create(value);
        String host = uri.getHost();
        if ("github.com".equals(host)) return uri.getRawQuery() == null && uri.getRawFragment() == null
                && uri.getRawPath().matches("/Brclio/Brclio-Pay/releases/download/client-v[0-9]+\\.[0-9]+\\.[0-9]+/[A-Za-z0-9._-]+");
        return ("release-assets.githubusercontent.com".equals(host) || "objects.githubusercontent.com".equals(host))
                && uri.getRawFragment() == null && uri.getRawPath() != null && !uri.getRawPath().contains("%2f") && !uri.getRawPath().contains("..");
    }
}
