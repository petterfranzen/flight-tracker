package com.flighttracker.ops;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigInteger;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.RSAPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.regex.Pattern;

/**
 * Verifies the Cloudflare Access token on a request to the ops endpoint
 * (OpsStatsFilter). Access sits in front of the origin and only forwards a
 * request it has authenticated, adding a signed RS256 token in the
 * Cf-Access-Jwt-Assertion header. This checks that token itself rather than
 * trusting the header's presence, so the endpoint stays closed even for a
 * path Access was never configured on.
 *
 * Fails closed: with no team domain or audience configured, every token is
 * rejected. Neither value is a secret (the audience is in every token and
 * the signing keys are public), so both live in application.yml.
 */
@Component
public class AccessTokenVerifier {

    private static final Logger log = LoggerFactory.getLogger(AccessTokenVerifier.class);

    static final Duration CLOCK_SKEW = Duration.ofSeconds(60);
    // A token with an unknown key id triggers a key refetch, at most this
    // often, so forged tokens can't turn the app into a request amplifier.
    static final Duration MIN_REFETCH_INTERVAL = Duration.ofMinutes(5);
    private static final int MAX_TOKEN_LENGTH = 8192;
    private static final Pattern TEAM_DOMAIN = Pattern.compile("[a-z0-9-]+\\.cloudflareaccess\\.com");
    private static final Base64.Decoder B64 = Base64.getUrlDecoder();

    private final String teamDomain;
    private final String audience;
    private final Clock clock;
    private final ObjectMapper mapper;
    private final Function<URI, String> fetcher;
    private final Map<String, PublicKey> keys = new ConcurrentHashMap<>();
    private volatile Instant lastFetch = Instant.EPOCH;

    @Autowired
    public AccessTokenVerifier(@Value("${flighttracker.ops.access-team-domain:}") String teamDomain,
                               @Value("${flighttracker.ops.access-audience:}") String audience,
                               Clock clock, ObjectMapper mapper) {
        this(teamDomain, audience, clock, mapper, AccessTokenVerifier::httpGet);
    }

    AccessTokenVerifier(String teamDomain, String audience, Clock clock, ObjectMapper mapper,
                        Function<URI, String> fetcher) {
        this.teamDomain = teamDomain == null ? "" : teamDomain.trim();
        this.audience = audience == null ? "" : audience.trim();
        this.clock = clock;
        this.mapper = mapper;
        this.fetcher = fetcher;
    }

    public boolean isConfigured() {
        return !audience.isEmpty() && TEAM_DOMAIN.matcher(teamDomain).matches();
    }

    /** True only for a well-formed, correctly signed, unexpired token for this audience and team. */
    public boolean verify(String token) {
        if (!isConfigured() || token == null || token.isEmpty() || token.length() > MAX_TOKEN_LENGTH) return false;
        try {
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) return false;

            JsonNode header = mapper.readTree(B64.decode(parts[0]));
            if (!"RS256".equals(text(header.get("alg")))) return false;
            PublicKey key = keyFor(text(header.get("kid")));
            if (key == null) return false;

            Signature signature = Signature.getInstance("SHA256withRSA");
            signature.initVerify(key);
            signature.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
            if (!signature.verify(B64.decode(parts[2]))) return false;

            JsonNode claims = mapper.readTree(B64.decode(parts[1]));
            Instant now = clock.instant();
            JsonNode exp = claims.get("exp");
            if (exp == null || !exp.isNumber() || Instant.ofEpochSecond(exp.asLong()).plus(CLOCK_SKEW).isBefore(now)) return false;
            JsonNode nbf = claims.get("nbf");
            if (nbf != null && nbf.isNumber() && Instant.ofEpochSecond(nbf.asLong()).minus(CLOCK_SKEW).isAfter(now)) return false;
            if (!("https://" + teamDomain).equals(text(claims.get("iss")))) return false;
            return audienceMatches(claims.get("aud"));
        } catch (RuntimeException | GeneralSecurityException e) {
            return false;
        }
    }

    private boolean audienceMatches(JsonNode aud) {
        if (aud == null) return false;
        if (aud.isString()) return audience.equals(aud.stringValue());
        if (aud.isArray()) {
            for (JsonNode a : aud) {
                if (a.isString() && audience.equals(a.stringValue())) return true;
            }
        }
        return false;
    }

    private PublicKey keyFor(String kid) {
        if (kid == null) return null;
        PublicKey key = keys.get(kid);
        if (key != null) return key;
        synchronized (this) {
            key = keys.get(kid);
            if (key != null) return key;
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
    }

    private Map<String, PublicKey> parseKeys(String body) throws GeneralSecurityException {
        Map<String, PublicKey> out = new HashMap<>();
        KeyFactory factory = KeyFactory.getInstance("RSA");
        for (JsonNode k : mapper.readTree(body).path("keys")) {
            String kid = text(k.get("kid"));
            String n = text(k.get("n"));
            String e = text(k.get("e"));
            if (!"RSA".equals(text(k.get("kty"))) || kid == null || n == null || e == null) continue;
            out.put(kid, factory.generatePublic(new RSAPublicKeySpec(
                    new BigInteger(1, B64.decode(n)), new BigInteger(1, B64.decode(e)))));
        }
        return out;
    }

    private static String text(JsonNode node) {
        return node != null && node.isString() ? node.stringValue() : null;
    }

    private static String httpGet(URI uri) {
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
