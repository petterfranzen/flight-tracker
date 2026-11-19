package com.flighttracker.ops;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.PublicKey;
import java.security.Signature;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
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

    static final Duration CLOCK_SKEW = Duration.ofSeconds(60);
    // A token with an unknown key id triggers a key refetch, at most this
    // often, so forged tokens can't turn the app into a request amplifier.
    static final Duration MIN_REFETCH_INTERVAL = AccessSigningKeys.MIN_REFETCH_INTERVAL;
    private static final int MAX_TOKEN_LENGTH = 8192;
    private static final Pattern TEAM_DOMAIN = Pattern.compile("[a-z0-9-]+\\.cloudflareaccess\\.com");
    private static final Base64.Decoder B64 = Base64.getUrlDecoder();

    private final String teamDomain;
    private final String audience;
    private final Clock clock;
    private final ObjectMapper mapper;
    private final AccessSigningKeys keys;

    @Autowired
    public AccessTokenVerifier(@Value("${flighttracker.ops.access-team-domain:}") String teamDomain,
                               @Value("${flighttracker.ops.access-audience:}") String audience,
                               Clock clock, ObjectMapper mapper) {
        this(teamDomain, audience, clock, mapper, AccessSigningKeys::httpGet);
    }

    AccessTokenVerifier(String teamDomain, String audience, Clock clock, ObjectMapper mapper,
                        Function<URI, String> fetcher) {
        this.teamDomain = teamDomain == null ? "" : teamDomain.trim();
        this.audience = audience == null ? "" : audience.trim();
        this.clock = clock;
        this.mapper = mapper;
        this.keys = new AccessSigningKeys(this.teamDomain, clock, mapper, fetcher);
    }

    public boolean isConfigured() {
        return !audience.isEmpty() && TEAM_DOMAIN.matcher(teamDomain).matches();
    }

    /** True only for a well-formed, correctly signed, unexpired token for this audience and team. */
    public boolean verify(String token) {
        if (!isConfigured() || !plausibleLength(token)) return false;
        try {
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3) return false;
            if (!signatureValid(parts)) return false;
            return claimsValid(mapper.readTree(B64.decode(parts[1])));
        } catch (RuntimeException | GeneralSecurityException e) {
            return false;
        }
    }

    private static boolean plausibleLength(String token) {
        return token != null && !token.isEmpty() && token.length() <= MAX_TOKEN_LENGTH;
    }

    private boolean signatureValid(String[] parts) throws GeneralSecurityException {
        JsonNode header = mapper.readTree(B64.decode(parts[0]));
        if (!"RS256".equals(text(header.get("alg")))) return false;
        PublicKey key = keys.keyFor(text(header.get("kid")));
        if (key == null) return false;

        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initVerify(key);
        signature.update((parts[0] + "." + parts[1]).getBytes(StandardCharsets.US_ASCII));
        return signature.verify(B64.decode(parts[2]));
    }

    private boolean claimsValid(JsonNode claims) {
        Instant now = clock.instant();
        Instant exp = epochSeconds(claims.get("exp"));
        if (exp == null || exp.plus(CLOCK_SKEW).isBefore(now)) return false;
        Instant nbf = epochSeconds(claims.get("nbf"));
        if (nbf != null && nbf.minus(CLOCK_SKEW).isAfter(now)) return false;
        if (!("https://" + teamDomain).equals(text(claims.get("iss")))) return false;
        return audienceMatches(claims.get("aud"));
    }

    /** The claim as an instant, or null when it is absent or not a number. */
    private static Instant epochSeconds(JsonNode node) {
        return node != null && node.isNumber() ? Instant.ofEpochSecond(node.asLong()) : null;
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

    private static String text(JsonNode node) {
        return AccessSigningKeys.text(node);
    }
}
