package com.flighttracker.ops;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

import java.math.BigInteger;
import java.net.URI;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Arrays;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import static org.assertj.core.api.Assertions.assertThat;

class AccessSigningKeysTest {

    private static final String TEAM = "example.cloudflareaccess.com";
    private static final JsonMapper MAPPER = new JsonMapper();
    private static final RSAPublicKey KEY = (RSAPublicKey) keyPair().getPublic();

    private final MutableClock clock = new MutableClock(Instant.parse("2026-10-26T08:00:00Z"));
    private final AtomicInteger fetches = new AtomicInteger();

    private AccessSigningKeys keys(Function<URI, String> body) {
        return new AccessSigningKeys(TEAM, clock, MAPPER, uri -> {
            assertThat(uri.toString()).isEqualTo("https://" + TEAM + "/cdn-cgi/access/certs");
            fetches.incrementAndGet();
            return body.apply(uri);
        });
    }

    @Test
    void loadsAndCachesKnownKeys() {
        AccessSigningKeys keys = keys(uri -> jwks(rsa("k1")));
        assertThat(keys.keyFor("k1")).isEqualTo(KEY);
        assertThat(keys.keyFor("k1")).isEqualTo(KEY);
        assertThat(fetches).hasValue(1);
    }

    @Test
    void nullKeyIdNeverFetches() {
        assertThat(keys(uri -> jwks(rsa("k1"))).keyFor(null)).isNull();
        assertThat(fetches).hasValue(0);
    }

    @Test
    void skipsNonRsaAndIncompleteEntries() {
        Map<String, Object> ec = Map.of("kid", "ec", "kty", "EC", "n", "AQAB", "e", "AQAB");
        Map<String, Object> noModulus = Map.of("kid", "nomod", "kty", "RSA", "e", "AQAB");
        Map<String, Object> noKid = Map.of("kty", "RSA", "n", "AQAB", "e", "AQAB");
        AccessSigningKeys keys = keys(uri -> jwks(ec, noModulus, noKid, rsa("k1")));
        assertThat(keys.keyFor("k1")).isEqualTo(KEY);
        assertThat(keys.keyFor("ec")).isNull();
        assertThat(keys.keyFor("nomod")).isNull();
    }

    @Test
    void unknownKeyIdsRefetchOnlyAfterTheInterval() {
        AccessSigningKeys keys = keys(uri -> jwks(rsa("k1")));
        assertThat(keys.keyFor("forged-1")).isNull();
        assertThat(keys.keyFor("forged-2")).isNull();
        assertThat(fetches).hasValue(1);

        clock.advance(AccessSigningKeys.MIN_REFETCH_INTERVAL.plusSeconds(1));
        assertThat(keys.keyFor("forged-3")).isNull();
        assertThat(fetches).hasValue(2);
        assertThat(keys.keyFor("k1")).isEqualTo(KEY);
        assertThat(fetches).hasValue(2);
    }

    @Test
    void aFailedFetchYieldsNoKeyAndIsThrottled() {
        AccessSigningKeys keys = keys(uri -> { throw new IllegalStateException("HTTP 500"); });
        assertThat(keys.keyFor("k1")).isNull();
        assertThat(keys.keyFor("k1")).isNull();
        assertThat(fetches).hasValue(1);
    }

    @Test
    void textReadsOnlyStringNodes() {
        assertThat(AccessSigningKeys.text(null)).isNull();
        assertThat(AccessSigningKeys.text(MAPPER.readTree("1"))).isNull();
        assertThat(AccessSigningKeys.text(MAPPER.readTree("\"a\""))).isEqualTo("a");
    }

    // ---- helpers

    private static Map<String, Object> rsa(String kid) {
        return Map.of("kid", kid, "kty", "RSA", "alg", "RS256", "use", "sig",
                "n", b64(unsigned(KEY.getModulus())), "e", b64(unsigned(KEY.getPublicExponent())));
    }

    @SafeVarargs
    private static String jwks(Map<String, Object>... keys) {
        return MAPPER.writeValueAsString(Map.of("keys", List.of(keys)));
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

    private static final class MutableClock extends Clock {
        private Instant now;

        MutableClock(Instant now) {
            this.now = now;
        }

        void advance(java.time.Duration d) {
            now = now.plus(d);
        }

        @Override public ZoneId getZone() { return ZoneOffset.UTC; }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return now; }
    }
}
