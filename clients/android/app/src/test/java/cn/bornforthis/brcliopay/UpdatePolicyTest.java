package cn.bornforthis.brcliopay;

import org.json.JSONObject;
import org.junit.BeforeClass;
import org.junit.Test;
import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.util.Base64;

public final class UpdatePolicyTest {
    private static KeyPair signing;
    @BeforeClass public static void key() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048); signing = generator.generateKeyPair();
    }
    private JSONObject manifest() throws Exception {
        String version = "1.0.1";
        JSONObject asset = new JSONObject().put("type", "apk").put("name", "Brclio-Pay-" + version + "-android-universal.apk")
                .put("url", "https://github.com/Brclio/Brclio-Pay/releases/download/client-v" + version + "/Brclio-Pay-" + version + "-android-universal.apk")
                .put("bytes", 1200).put("sha256", "a".repeat(64));
        return new JSONObject().put("schema", 1).put("product", "Brclio Pay").put("applicationId", "cn.bornforthis.brcliopay")
                .put("version", version).put("versionCode", 1000001).put("publishedAt", "2026-10-21T16:00:00Z")
                .put("releaseUrl", "https://github.com/Brclio/Brclio-Pay/releases/tag/client-v" + version).put("notes", "更新说明")
                .put("platforms", new JSONObject().put("android-universal", new JSONObject().put("update", asset).put("installer", asset)));
    }
    private byte[] envelope(JSONObject manifest) throws Exception {
        byte[] payload = manifest.toString().getBytes(StandardCharsets.UTF_8);
        Signature signer = Signature.getInstance("SHA256withRSA"); signer.initSign(signing.getPrivate()); signer.update(payload);
        return new JSONObject().put("schema", 1).put("algorithm", "RSA-SHA256").put("payload", Base64.getEncoder().encodeToString(payload))
                .put("signature", Base64.getEncoder().encodeToString(signer.sign())).toString().getBytes(StandardCharsets.UTF_8);
    }
    @Test public void verifiesRawSignedPayloadAndExactAsset() throws Exception {
        UpdatePolicy.Release release = UpdatePolicy.verify(envelope(manifest()), signing.getPublic());
        assertEquals("1.0.1", release.version); assertEquals(1000001, release.versionCode); assertEquals(1200, release.bytes);
    }
    @Test public void rejectsTamperedUnsignedOrWrongKeyEnvelopes() throws Exception {
        JSONObject envelope = new JSONObject(new String(envelope(manifest()), StandardCharsets.UTF_8));
        envelope.put("payload", Base64.getEncoder().encodeToString(manifest().put("notes", "tampered").toString().getBytes(StandardCharsets.UTF_8)));
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope.toString().getBytes(StandardCharsets.UTF_8), signing.getPublic()));
        envelope.put("algorithm", "none");
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope.toString().getBytes(StandardCharsets.UTF_8), signing.getPublic()));
        KeyPairGenerator generator = KeyPairGenerator.getInstance("RSA"); generator.initialize(2048);
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(manifest()), generator.generateKeyPair().getPublic()));
    }
    @Test public void rejectsWrongApplicationTagUrlOrVersionEvenWhenSigned() throws Exception {
        JSONObject wrongApp = manifest().put("applicationId", "cn.other.application");
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(wrongApp), signing.getPublic()));
        JSONObject wrongVersion = manifest().put("versionCode", 1000002);
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(wrongVersion), signing.getPublic()));
        JSONObject wrongTag = manifest().put("releaseUrl", "https://github.com/Brclio/Brclio-Pay/releases/tag/v1.0.1");
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(wrongTag), signing.getPublic()));
        JSONObject evilAsset = manifest(); evilAsset.getJSONObject("platforms").getJSONObject("android-universal").getJSONObject("update").put("url", "https://evil.test/app.apk");
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(evilAsset), signing.getPublic()));
    }
    @Test public void validatesSizeEncodingAndRedirectBoundaries() throws Exception {
        JSONObject tooBig = manifest(); tooBig.getJSONObject("platforms").getJSONObject("android-universal").getJSONObject("update").put("bytes", 100L * 1024 * 1024 + 1);
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(tooBig), signing.getPublic()));
        JSONObject fractional = manifest(); fractional.getJSONObject("platforms").getJSONObject("android-universal").getJSONObject("update").put("bytes", 1.5);
        assertThrows(Exception.class, () -> UpdatePolicy.verify(envelope(fractional), signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.verify(new byte[UpdatePolicy.MAX_MANIFEST_BYTES + 1], signing.getPublic()));
        assertFalse(UpdatePolicy.isDownloadRedirect("https://github.com.evil.test/Brclio/Brclio-Pay/releases/download/client-v1.0.1/a.apk"));
        assertFalse(UpdatePolicy.isDownloadRedirect("http://release-assets.githubusercontent.com/file.apk"));
        assertFalse(UpdatePolicy.isDownloadRedirect("https://github.com/other/repo/releases/download/client-v1.0.1/a.apk"));
        assertFalse(UpdatePolicy.isDownloadRedirect("https://user@objects.githubusercontent.com/file.apk"));
        assertTrue(UpdatePolicy.isDownloadRedirect("https://release-assets.githubusercontent.com/github-production-release-asset/file.apk?token=temporary"));
        assertTrue(UpdatePolicy.isDownloadRedirect("https://github.com/Brclio/Brclio-Pay/releases/download/client-v1.0.1/client-update.json"));
    }
    @Test public void savedCandidateReverifiesOriginalSignatureAndCurrentInstalledVersion() throws Exception {
        long now = 1800000000000L;
        String stored = Base64.getEncoder().encodeToString(envelope(manifest()));
        UpdatePolicy.Release restored = UpdatePolicy.restoreCandidate(stored, now - 1000, now, 1000000, signing.getPublic());
        assertEquals(1000001, restored.versionCode);
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(stored, now - 1000, now, 1000001, signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(stored, now - 1000, now, 2000000, signing.getPublic()));
        JSONObject changed = new JSONObject(new String(Base64.getDecoder().decode(stored), StandardCharsets.UTF_8));
        changed.put("payload", Base64.getEncoder().encodeToString(manifest().put("versionCode", 2000000).toString().getBytes(StandardCharsets.UTF_8)));
        String corrupted = Base64.getEncoder().encodeToString(changed.toString().getBytes(StandardCharsets.UTF_8));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(corrupted, now - 1000, now, 1000000, signing.getPublic()));
    }
    @Test public void savedCandidateRejectsMissingExpiredFutureOrOversizedMetadata() throws Exception {
        long now = 1800000000000L;
        String stored = Base64.getEncoder().encodeToString(envelope(manifest()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(stored, now - UpdatePolicy.CANDIDATE_MAX_AGE_MS - 1, now, 1000000, signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(stored, now + 300001, now, 1000000, signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(stored, 0, now, 1000000, signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate(null, now - 1, now, 1000000, signing.getPublic()));
        assertThrows(Exception.class, () -> UpdatePolicy.restoreCandidate("A".repeat(400000), now - 1, now, 1000000, signing.getPublic()));
    }
}
