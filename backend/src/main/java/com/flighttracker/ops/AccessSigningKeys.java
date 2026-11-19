package com.flighttracker.ops;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * The Cloudflare Access signing keys for one team, fetched from the team's
 * certs endpoint and cached by key id (AccessTokenVerifier). An unknown key id
 * triggers a refetch, at most once per {@link #MIN_REFETCH_INTERVAL}, so
 * forged tokens can't turn the app into a request amplifier.
 */
final class AccessSigningKeys {

    // Logs under the verifier's name, as before this class was split out.
    private static final Logger log = LoggerFactory.getLogger(AccessTokenVerifier.class);

    static final Duration MIN_REFETCH_INTERVAL = Duration.ofMinutes(5);
    private static final Base64.Decoder B64 = Base64.getUrlDecoder();

    private final String teamDomain;
    private final Clock clock;
    private final ObjectMapper mapper;
    private final Function<URI, String> fetcher;
    private final Map<String, PublicKey> keys = new ConcurrentHashMap<>();
    private volatile Instant lastFetch = Instant.EPOCH;

    AccessSigningKeys(String teamDomain, Clock clock, ObjectMapper mapper, Function<URI, String> fetcher) {
        this.teamDomain = teamDomain;
        this.clock = clock;
        this.mapper = mapper;
        this.fetcher = fetcher;
    }

    /** The key with this id, or null when it is unknown (after at most one throttled refetch). */
    PublicKey keyFor(String kid) {
        if (kid == null) return null;
        PublicKey key = keys.get(kid);
        if (key != null) return key;
        synchronized (this) {
            key = keys.get(kid);
            if (key != null) return key;
            return refetchFor(kid);
        }
    }

    private PublicKey refetchFor(String kid) {
        Instant now = clock.instant();
        if (lastFetch.plus(MIN_REFETCH_INTERVAL).isAfter(now)) return null;
        lastFetch = now;
        try {
            Map<String, PublicKey> fresh = parseKeys(fetcher.apply(URI.create("https://" + teamDomain + "/cdn-cgi/access/certs")));
            keys.clear();
            keys.putAll(fresh);
        } catch (RuntimeException | GeneralSecurityException e) {
            log.warn("ops: could not load access signing keys: {}", e.toString());
            return null;
        }
        return keys.get(kid);
    }

    private Map<String, PublicKey> parseKeys(String body) throws GeneralSecurityException {
        Map<String, PublicKey> out = new HashMap<>();
        KeyFactory factory = KeyFactory.getInstance("RSA");
        for (JsonNode k : mapper.readTree(body).path("keys")) {
            String kid = text(k.get("kid"));
            String n = text(k.get("n"));
            String e = text(k.get("e"));
            if (!"RSA".equals(text(k.get("kty"))) || !allPresent(kid, n, e)) continue;
            out.put(kid, factory.generatePublic(new RSAPublicKeySpec(
                    new BigInteger(1, B64.decode(n)), new BigInteger(1, B64.decode(e)))));
        }
        return out;
    }

    private static boolean allPresent(String... values) {
        for (String v : values) {
            if (v == null) return false;
        }
        return true;
    }

    static String text(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    static String httpGet(URI uri) {
        try {
            HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();
            HttpResponse<String> response = client.send(
                    HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) throw new IllegalStateException("HTTP " + response.statusCode());
            return response.body();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("interrupted", e);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e.toString(), e);
        }
    }
}
