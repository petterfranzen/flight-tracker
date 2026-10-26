package com.flighttracker.ops;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigInteger;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

class AccessTokenVerifierTest {

    private static final String TEAM = "example.cloudflareaccess.com";
    private static final String AUD = "aud-tag-123";
    private static final Instant NOW = Instant.parse("2026-10-26T08:00:00Z");
    private static final JsonMapper MAPPER = new JsonMapper();
    private static final KeyPair KEYS = keyPair();
    private static final KeyPair OTHER_KEYS = keyPair();

    private final AtomicInteger fetches = new AtomicInteger();
    private final Function<URI, String> fetcher = uri -> {
        assertThat(uri.toString()).isEqualTo("https://" + TEAM + "/cdn-cgi/access/certs");
        fetches.incrementAndGet();
        return jwks("k1", (RSAPublicKey) KEYS.getPublic());
    };

    private AccessTokenVerifier verifier(String team, String aud) {
        return new AccessTokenVerifier(team, aud, Clock.fixed(NOW, ZoneOffset.UTC), MAPPER, fetcher);
    }

    private Map<String, Object> claims() {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("aud", List.of(AUD));
        c.put("iss", "https://" + TEAM);
        c.put("exp", NOW.plusSeconds(600).getEpochSecond());
        c.put("nbf", NOW.minusSeconds(60).getEpochSecond());
        return c;
    }

    @Test
    void acceptsAValidToken() {
        assertThat(verifier(TEAM, AUD).verify(token("RS256", "k1", claims(), KEYS.getPrivate()))).isTrue();
    }

    @Test
    void acceptsAudienceAsAPlainString() {
        Map<String, Object> c = claims();
        c.put("aud", AUD);
        assertThat(verifier(TEAM, AUD).verify(token("RS256", "k1", c, KEYS.getPrivate()))).isTrue();
    }

    @Test
    void failsClosedWhenNotConfigured() {
        String good = token("RS256", "k1", claims(), KEYS.getPrivate());
        assertThat(verifier("", AUD).verify(good)).isFalse();
        assertThat(verifier(TEAM, "").verify(good)).isFalse();
        assertThat(verifier("attacker.example.com", AUD).verify(good)).isFalse();
        assertThat(fetches).hasValue(0);
    }

    @Test
    void rejectsBadTokens() {
        AccessTokenVerifier v = verifier(TEAM, AUD);
        Map<String, Object> wrongAud = claims();
        wrongAud.put("aud", List.of("someone-else"));
        Map<String, Object> expired = claims();
        expired.put("exp", NOW.minusSeconds(120).getEpochSecond());
        Map<String, Object> notYet = claims();
        notYet.put("nbf", NOW.plusSeconds(120).getEpochSecond());
        Map<String, Object> wrongIssuer = claims();
        wrongIssuer.put("iss", "https://other.cloudflareaccess.com");
        Map<String, Object> noExp = claims();
        noExp.remove("exp");

        assertThat(v.verify(token("RS256", "k1", wrongAud, KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("RS256", "k1", expired, KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("RS256", "k1", notYet, KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("RS256", "k1", wrongIssuer, KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("RS256", "k1", noExp, KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("RS256", "k1", claims(), OTHER_KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(token("HS256", "k1", claims(), KEYS.getPrivate()))).isFalse();
        assertThat(v.verify(unsigned(claims()))).isFalse();
        assertThat(v.verify(null)).isFalse();
        assertThat(v.verify("")).isFalse();
        assertThat(v.verify("not.a.token")).isFalse();
        assertThat(v.verify("x".repeat(10_000))).isFalse();
    }

    @Test
    void unknownKeyIdsRefetchAtMostOncePerInterval() {
        AccessTokenVerifier v = verifier(TEAM, AUD);
        assertThat(v.verify(token("RS256", "k1", claims(), KEYS.getPrivate()))).isTrue();
        assertThat(fetches).hasValue(1);
        for (int i = 0; i < 20; i++) {
            assertThat(v.verify(token("RS256", "forged-" + i, claims(), KEYS.getPrivate()))).isFalse();
        }
        // Clock is fixed: within MIN_REFETCH_INTERVAL of the first fetch, so no more fetches.
        assertThat(fetches).hasValue(1);
        assertThat(v.verify(token("RS256", "k1", claims(), KEYS.getPrivate()))).isTrue();
    }

    // ---- helpers

    private static String token(String alg, String kid, Map<String, Object> claims, PrivateKey key) {
        String header = b64(MAPPER.writeValueAsBytes(Map.of("alg", alg, "kid", kid, "typ", "JWT")));
        String payload = b64(MAPPER.writeValueAsBytes(claims));
        try {
            Signature s = Signature.getInstance("SHA256withRSA");
            s.initSign(key);
            s.update((header + "." + payload).getBytes(StandardCharsets.US_ASCII));
            return header + "." + payload + "." + b64(s.sign());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String unsigned(Map<String, Object> claims) {
        return b64(MAPPER.writeValueAsBytes(Map.of("alg", "none", "kid", "k1"))) + "."
                + b64(MAPPER.writeValueAsBytes(claims)) + ".";
    }

    private static String jwks(String kid, RSAPublicKey key) {
        return MAPPER.writeValueAsString(Map.of("keys", List.of(Map.of(
                "kid", kid, "kty", "RSA", "alg", "RS256", "use", "sig",
                "n", b64(unsigned(key.getModulus())), "e", b64(unsigned(key.getPublicExponent()))))));
    }

    private static byte[] unsigned(BigInteger value) {
        byte[] bytes = value.toByteArray();
        return bytes[0] == 0 ? Arrays.copyOfRange(bytes, 1, bytes.length) : bytes;
    }

    private static String b64(byte[] bytes) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    private static KeyPair keyPair() {
        try {
            KeyPairGenerator g = KeyPairGenerator.getInstance("RSA");
            g.initialize(2048);
            return g.generateKeyPair();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
