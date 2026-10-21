package cn.bornforthis.brcliopay;

import org.junit.Test;
import static org.junit.Assert.*;
import java.util.Base64;

public final class ClientPolicyTest {
    @Test public void onlyExactCenterHttpsGetsWebViewAccess() {
        assertTrue(ClientPolicy.isCenter("https://pay.bornforthis.cn/admin#bills"));
        assertFalse(ClientPolicy.isCenter("http://pay.bornforthis.cn/admin"));
        assertFalse(ClientPolicy.isCenter("https://pay.bornforthis.cn.evil.test/admin"));
        assertFalse(ClientPolicy.isCenter("https://someone@pay.bornforthis.cn/admin"));
        assertFalse(ClientPolicy.isCenter("https://pay.bornforthis.cn:8443/admin"));
        assertFalse(ClientPolicy.isCenter("file:///admin.html"));
        assertFalse(ClientPolicy.isCenter("content://downloads/admin.html"));
        assertFalse(ClientPolicy.isCenter("javascript:alert(1)"));
        assertTrue(ClientPolicy.isBridgeOrigin("https://pay.bornforthis.cn"));
        assertFalse(ClientPolicy.isBridgeOrigin("https://pay.bornforthis.cn/admin"));
    }
    @Test public void onlyKnownSkillsRoutesCanUseAuthenticatedDownloader() {
        assertTrue(ClientPolicy.isSkillDownload("https://pay.bornforthis.cn/api/admin/skill.zip?variant=brclio-pay-integrate"));
        assertTrue(ClientPolicy.isSkillDownload("https://pay.bornforthis.cn/api/skills/brclio-alipay-integrate.zip"));
        assertFalse(ClientPolicy.isSkillDownload("https://example.com/skill.zip"));
        assertFalse(ClientPolicy.isSkillDownload("https://pay.bornforthis.cn/api/admin/environment"));
    }
    @Test public void exportsRejectPathsExecutablesAndOversizedData() {
        assertEquals("brclio-pay-2026-10.csv", ClientPolicy.safeFilename("brclio-pay-2026-10.csv", "text/csv"));
        assertEquals("brclio-pay-integrate.zip", ClientPolicy.safeFilename("brclio-pay-integrate.zip", "application/zip"));
        for (String filename : new String[]{"../data.csv", "path/data.csv", "test.exe", "..csv", "a\\b.csv"}) {
            assertThrows(IllegalArgumentException.class, () -> ClientPolicy.safeFilename(filename, "text/csv"));
        }
        assertArrayEquals(new byte[]{1, 2, 3}, ClientPolicy.decodeExport(Base64.getEncoder().encodeToString(new byte[]{1, 2, 3})));
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.decodeExport("AQI"));
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.decodeExport("!!!!"));
        assertThrows(IllegalArgumentException.class, () -> ClientPolicy.decodeExport("A".repeat(24000000)));
    }
}
